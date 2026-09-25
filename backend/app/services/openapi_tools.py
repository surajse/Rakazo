"""OpenAPI 3.x tool sources for Rakazo bots.

Each configured spec is fetched (JSON, or YAML when PyYAML is available),
parsed into agent-callable tools, and invoked with httpx. Mirrors the MCP
module's shape: :class:`OpenAPISource` plays the role of ``MCPClient`` and
:func:`connect_bot_openapi_specs` the role of ``connect_bot_mcp_servers``.

Not supported: OpenAPI 2.0 (Swagger), multipart/form-data file uploads,
OAuth2/token-exchange flows, and server-variable enums beyond defaults.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
MAX_BODY_CHARS = 5000  # cap on how much of an HTTP response we keep

try:
    import yaml  # type: ignore

    _HAS_YAML = True
except ImportError:  # pragma: no cover - exercised only when PyYAML is missing
    yaml = None  # type: ignore
    _HAS_YAML = False


class OpenAPIError(Exception):
    """Raised for spec fetch/parse failures and tool invocation failures."""


# ------------------------------------------------------------------ naming
_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9_]")


def sanitize_name(value: str) -> str:
    """Make a string safe for use in a tool name."""
    return _SANITIZE_RE.sub("_", value).strip("_") or "unnamed"


def namespaced_tool_name(source_name: str, operation: str) -> str:
    """Namespace choice: ``openapi_<source>_<operation>`` (sanitized).

    Same rationale as the MCP ``mcp_<server>_<tool>`` prefix: a flat global
    tool namespace in the agent loop, where the prefix avoids collisions and
    tells the model which spec a tool comes from. Components are truncated so
    the result stays within typical 64-char function-name limits; any residual
    collision is resolved by the de-dupe loop in connect_bot_openapi_specs.
    """
    return f"openapi_{sanitize_name(source_name)[:24]}_{sanitize_name(operation)[:28]}"


# ------------------------------------------------------------------ spec load
def _looks_like_yaml(text: str) -> bool:
    stripped = text.lstrip()
    return stripped.startswith("---") or (
        "\n" in stripped and ":" in stripped.splitlines()[0] and not stripped.startswith("{")
    )


async def fetch_spec_document(
    url: str, client: httpx.AsyncClient, timeout: float = DEFAULT_TIMEOUT
) -> dict[str, Any]:
    """GET an OpenAPI document and parse it (JSON always, YAML if PyYAML exists).

    Raises OpenAPIError with a clear, secret-free message on failure.
    """
    try:
        resp = await client.get(url, timeout=timeout, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise OpenAPIError(f"Could not fetch OpenAPI spec from {url}: {exc}") from exc
    if resp.status_code >= 400:
        raise OpenAPIError(
            f"OpenAPI spec URL returned {resp.status_code}: {resp.text[:300]}"
        )
    text = resp.text
    content_type = resp.headers.get("content-type", "").lower()
    wants_yaml = "yaml" in content_type or url.lower().endswith((".yaml", ".yml"))

    if wants_yaml or _looks_like_yaml(text):
        if not _HAS_YAML:
            raise OpenAPIError(
                "Spec appears to be YAML, but PyYAML is not installed "
                "(add pyyaml to backend/requirements.txt). JSON specs work without it."
            )
        try:
            doc = yaml.safe_load(text)  # type: ignore[union-attr]
        except Exception as exc:
            raise OpenAPIError(f"Could not parse YAML spec from {url}: {exc}") from exc
    else:
        try:
            doc = json.loads(text)
        except json.JSONDecodeError:
            if _HAS_YAML:
                try:
                    doc = yaml.safe_load(text)  # type: ignore[union-attr]
                except Exception as exc:
                    raise OpenAPIError(
                        f"Could not parse spec from {url} as JSON or YAML: {exc}"
                    ) from exc
            else:
                raise OpenAPIError(
                    f"Spec from {url} is not valid JSON. (Install PyYAML if the spec is YAML.)"
                )
    if not isinstance(doc, dict):
        raise OpenAPIError(f"Spec from {url} did not parse to an object")
    version = str(doc.get("openapi", ""))
    if not version.startswith("3."):
        raise OpenAPIError(
            f"Unsupported OpenAPI version {version!r} (only 3.x is supported; "
            "OpenAPI 2.0/Swagger specs are not)"
        )
    if not isinstance(doc.get("paths"), dict):
        raise OpenAPIError("Spec has no 'paths' object")
    return doc


# ------------------------------------------------------------------ $ref
def _resolve_ref(spec: dict[str, Any], ref: str) -> Any:
    """Resolve a local JSON pointer like '#/components/schemas/Foo'."""
    if not ref.startswith("#/"):
        raise OpenAPIError(f"Only local $refs are supported, got {ref!r}")
    node: Any = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise OpenAPIError(f"Unresolvable $ref {ref!r}")
        node = node[part]
    return node


def _deref(spec: dict[str, Any], node: Any, _seen: tuple[int, ...] = ()) -> Any:
    """Recursively resolve $refs in a schema/parameter node (cycle-guarded)."""
    if isinstance(node, dict) and set(node.keys()) == {"$ref"}:
        target = _resolve_ref(spec, str(node["$ref"]))
        if id(target) in _seen:
            return {}  # recursive schema: stop expanding
        return _deref(spec, target, _seen + (id(target),))
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k == "$ref":
                continue
            out[k] = _deref(spec, v, _seen)
        return out
    if isinstance(node, list):
        return [_deref(spec, v, _seen) for v in node]
    return node


# ------------------------------------------------------------------ parse
_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


@dataclass
class _Param:
    name: str
    location: str  # query | path | header
    required: bool
    schema: dict[str, Any]
    description: str = ""


@dataclass
class OpenAPIToolRef:
    """One OpenAPI operation exposed to the agent loop, with its namespaced name."""

    namespaced: str
    source_name: str
    operation: str  # operationId or "method path" fallback
    method: str
    path_template: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)
    params: list[_Param] = field(default_factory=list)
    has_json_body: bool = False
    body_required: bool = False
    body_description: str = ""


def _schema_summary(schema: dict[str, Any]) -> dict[str, Any]:
    """Keep a parameter/property schema small but informative for the model."""
    out: dict[str, Any] = {}
    for key in ("type", "format", "description", "default", "enum", "items", "properties", "required"):
        if key in schema:
            out[key] = schema[key]
    if "type" not in out:
        out["type"] = "string"
    return out


def parse_spec(spec: dict[str, Any]) -> list[OpenAPIToolRef]:
    """Turn an OpenAPI 3.x document's paths+operations into tool refs.

    Name: ``<operationId or method_path>`` (namespaced later per source).
    Input schema: object with properties for query/path/header parameters and,
    when the operation takes ``application/json``, a ``body`` property holding
    the requestBody schema inline.
    """
    refs: list[OpenAPIToolRef] = []
    paths = spec.get("paths") or {}
    for path, path_item in paths.items():
        if not isinstance(path_item, dict):
            continue
        common_params = path_item.get("parameters") or []
        for method in _METHODS:
            op = path_item.get(method)
            if not isinstance(op, dict):
                continue
            operation_id = op.get("operationId") or f"{method} {path}"
            summary = str(op.get("summary") or "")
            description = str(op.get("description") or "")
            full_desc = (summary + ("\n" + description if description else "")).strip()[:500]

            params: list[_Param] = []
            for raw_param in list(common_params) + list(op.get("parameters") or []):
                if not isinstance(raw_param, dict):
                    continue
                param = _deref(spec, raw_param)
                if not isinstance(param, dict) or not param.get("name"):
                    continue
                location = str(param.get("in", "query"))
                if location not in ("query", "path", "header"):
                    continue  # cookie params and friends: not supported
                schema = param.get("schema") if isinstance(param.get("schema"), dict) else {}
                params.append(
                    _Param(
                        name=str(param["name"]),
                        location=location,
                        required=bool(param.get("required")) or location == "path",
                        schema=_schema_summary(_deref(spec, schema)),
                        description=str(param.get("description") or ""),
                    )
                )

            has_json_body = False
            body_required = False
            body_schema: dict[str, Any] | None = None
            body_description = ""
            raw_body = op.get("requestBody")
            if isinstance(raw_body, dict):
                body = _deref(spec, raw_body)
                content = body.get("content") if isinstance(body, dict) else None
                if isinstance(content, dict):
                    media = content.get("application/json") or content.get("application/*+json")
                    if isinstance(media, dict) and isinstance(media.get("schema"), dict):
                        has_json_body = True
                        body_required = bool(body.get("required"))
                        body_schema = _deref(spec, media["schema"])
                        body_description = str(body.get("description") or "")

            properties: dict[str, Any] = {}
            required: list[str] = []
            for p in params:
                prop = dict(p.schema)
                if p.description and "description" not in prop:
                    prop["description"] = p.description[:300]
                properties[p.name] = prop
                if p.required:
                    required.append(p.name)
            if has_json_body and body_schema is not None:
                body_prop: dict[str, Any] = dict(body_schema)
                body_prop.setdefault("description", body_description or "JSON request body")
                properties["body"] = body_prop
                if body_required:
                    required.append("body")

            refs.append(
                OpenAPIToolRef(
                    namespaced="",  # filled in by connect_bot_openapi_specs
                    source_name="",
                    operation=str(operation_id),
                    method=method.upper(),
                    path_template=str(path),
                    description=full_desc,
                    input_schema={"type": "object", "properties": properties, "required": required},
                    params=params,
                    has_json_body=has_json_body,
                    body_required=body_required,
                    body_description=body_description,
                )
            )
    return refs


# ------------------------------------------------------------------ auth
def _normalize_auth(auth: Any) -> dict[str, Any] | None:
    """Normalize per-source auth config.

    Accepted shapes:
    - ``"sk-..."`` (string) -> Authorization: Bearer <key> header
    - ``{"type": "header", "name": "X-API-Key", "value": "..."}``
    - ``{"type": "query", "name": "api_key", "value": "..."}``
    - ``{"type": "bearer", "value": "..."}``
    Returns ``{"header": (name, value)}`` or ``{"query": (name, value)}``.
    """
    if auth is None:
        return None
    if isinstance(auth, str):
        if not auth:
            return None
        return {"header": ("Authorization", f"Bearer {auth}")}
    if isinstance(auth, dict):
        kind = str(auth.get("type", "")).lower()
        value = str(auth.get("value", ""))
        if not value:
            return None
        if kind == "header":
            return {"header": (str(auth.get("name", "Authorization")), value)}
        if kind == "query":
            return {"query": (str(auth.get("name", "api_key")), value)}
        if kind == "bearer":
            return {"header": ("Authorization", f"Bearer {value}")}
        raise OpenAPIError(
            f"Unknown auth type {kind!r}; expected 'header', 'query', or 'bearer'"
        )
    raise OpenAPIError("Auth config must be a string or an object")


def _redacted_auth(auth: dict[str, Any] | None) -> str:
    """A log-safe description of the auth config (never the secret value)."""
    if not auth:
        return "none"
    if "header" in auth:
        return f"header:{auth['header'][0]}"
    if "query" in auth:
        return f"query:{auth['query'][0]}"
    return "unknown"


# ------------------------------------------------------------------ source
def _substitute_server_variables(url: str, server: dict[str, Any]) -> str:
    variables = server.get("variables") if isinstance(server, dict) else None
    if not isinstance(variables, dict):
        return url

    def repl(match: re.Match[str]) -> str:
        var = match.group(1)
        spec = variables.get(var)
        if isinstance(spec, dict) and "default" in spec:
            return str(spec["default"])
        return match.group(0)

    return re.sub(r"\{([^}/]+)\}", repl, url)


class OpenAPISource:
    """One connected OpenAPI spec. Call load() before call_tool()."""

    def __init__(self, config: dict[str, Any], http_client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self.name = str(config.get("name", "openapi")).strip() or "openapi"
        self.spec_url = str(config.get("spec_url") or config.get("url") or "")
        self.base_url_override = config.get("base_url")
        self._auth = _normalize_auth(config.get("auth") or config.get("api_key"))
        self.client = http_client or httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        self._owns_client = http_client is None
        self.base_url: str = ""
        self.tools: list[OpenAPIToolRef] = []
        self.spec_title: str = ""

    async def load(self, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Fetch the spec, resolve the base URL, and parse operations."""
        if not self.spec_url:
            raise OpenAPIError(f"OpenAPI source '{self.name}': config needs 'spec_url'")
        spec = await fetch_spec_document(self.spec_url, self.client, timeout)
        self.spec_title = str((spec.get("info") or {}).get("title") or "")

        base = str(self.base_url_override or "").strip()
        if not base:
            servers = spec.get("servers") or []
            if servers and isinstance(servers[0], dict) and servers[0].get("url"):
                base = _substitute_server_variables(str(servers[0]["url"]), servers[0])
        if not base:
            raise OpenAPIError(
                f"OpenAPI source '{self.name}': no base URL (set 'base_url' in the "
                "source config or add 'servers' to the spec)"
            )
        if "://" not in base:
            raise OpenAPIError(
                f"OpenAPI source '{self.name}': base URL {base!r} is relative; "
                "set an absolute 'base_url' in the source config"
            )
        self.base_url = base.rstrip("/")
        self.tools = parse_spec(spec)
        if not self.tools:
            raise OpenAPIError(f"OpenAPI source '{self.name}': spec defines no operations")
        log.info(
            "OpenAPI source '%s' loaded: %d operations (auth=%s)",
            self.name,
            len(self.tools),
            _redacted_auth(self._auth),
        )

    async def call_tool(self, ref: OpenAPIToolRef, args: dict[str, Any] | None) -> str:
        """Invoke one parsed operation; return the response body as text."""
        args = dict(args or {})
        missing = [p.name for p in ref.params if p.required and p.name not in args]
        if ref.body_required and "body" not in args:
            missing.append("body")
        if missing:
            raise OpenAPIError(f"Missing required argument(s): {', '.join(missing)}")

        path = ref.path_template
        for p in ref.params:
            if p.location == "path" and p.name in args:
                path = path.replace("{" + p.name + "}", quote(str(args[p.name]), safe=""))

        query: dict[str, Any] = {}
        headers: dict[str, str] = {}
        for p in ref.params:
            if p.name not in args:
                continue
            value = args[p.name]
            if p.location == "query":
                query[p.name] = value
            elif p.location == "header":
                headers[p.name] = str(value)

        # Configured credentials always win over model-supplied values for the
        # same header/query name, so the model can never swap or drop them.
        if self._auth:
            if "header" in self._auth:
                header_name, header_value = self._auth["header"]
                headers[header_name] = header_value
            if "query" in self._auth:
                query_name, query_value = self._auth["query"]
                query[query_name] = query_value

        json_body = args.get("body") if ref.has_json_body else None

        url = self.base_url + path
        try:
            resp = await self.client.request(
                ref.method, url, params=query or None, headers=headers or None, json=json_body
            )
        except httpx.HTTPError as exc:
            # Never include headers (auth secrets) in the error text.
            raise OpenAPIError(
                f"OpenAPI call {ref.method} {ref.path_template} failed: {exc}"
            ) from exc
        body_text = resp.text[:MAX_BODY_CHARS]
        if resp.status_code >= 400:
            raise OpenAPIError(
                f"OpenAPI call {ref.method} {ref.path_template} returned "
                f"{resp.status_code}: {body_text[:500]}"
            )
        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                return json.dumps(resp.json(), indent=2, default=str)[:MAX_BODY_CHARS]
            except (json.JSONDecodeError, ValueError):
                pass
        return body_text or f"(empty response, status {resp.status_code})"

    async def aclose(self) -> None:
        if self._owns_client:
            await self.client.aclose()


# ------------------------------------------------------------------ bot wiring
async def connect_bot_openapi_specs(
    raw_specs: list[dict[str, Any]] | None,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[dict[str, OpenAPISource], dict[str, OpenAPIToolRef], list[str]]:
    """Fetch each configured OpenAPI spec and parse its operations.

    Returns ``(sources, tool_map, errors)`` where ``tool_map`` maps the
    namespaced tool name (``openapi_<source>_<operation>``) to an
    ``OpenAPIToolRef``. Per-source failures are collected into ``errors``
    instead of raising, so one bad spec can't take down the whole run.
    """
    sources: dict[str, OpenAPISource] = {}
    tool_map: dict[str, OpenAPIToolRef] = {}
    errors: list[str] = []

    for raw in raw_specs or []:
        if not isinstance(raw, dict):
            errors.append(f"Invalid OpenAPI spec entry (not an object): {raw!r:.100}")
            continue
        name = str(raw.get("name") or "openapi").strip() or "openapi"
        source = OpenAPISource(raw, http_client=http_client)
        try:
            await source.load()
        except OpenAPIError as exc:
            errors.append(f"OpenAPI source '{name}': {exc}")
            await source.aclose()
            continue
        except Exception as exc:  # noqa: BLE001 - never let a spec break the run
            errors.append(f"OpenAPI source '{name}': unexpected error: {exc}")
            await source.aclose()
            continue
        sources[name] = source
        for ref in source.tools:
            ref.source_name = name
            base = namespaced_tool_name(name, ref.operation)
            namespaced = base
            suffix = 2
            while namespaced in tool_map:  # de-duplicate across sources
                namespaced = f"{base}_{suffix}"
                suffix += 1
            ref.namespaced = namespaced
            tool_map[namespaced] = ref
    return sources, tool_map, errors
