"""Minimal MCP (Model Context Protocol) client for Rakazo bot tool sources.

Dependency-light: stdlib + httpx only.

Transports:
- ``stdio``: spawns ``command`` and speaks newline-delimited JSON-RPC 2.0 over
  stdin/stdout (the MCP stdio convention). The child's stderr is discarded so
  server logs can never corrupt the message stream.
- ``http``: POSTs JSON-RPC 2.0 to ``url`` (Streamable HTTP style). Handles a
  plain JSON response as well as a ``text/event-stream`` (SSE) response, in
  which case the first ``data:`` payload is parsed as the response message.

Implements the MCP ``initialize`` handshake, ``tools/list`` and
``tools/call``. The legacy MCP SSE transport (GET an event stream, then POST
to a separate messages endpoint with a session id) is NOT implemented — point
``url`` at a Streamable HTTP endpoint instead.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2025-06-18"
DEFAULT_TIMEOUT = 30.0


class MCPError(Exception):
    """Raised for MCP protocol/transport failures."""


# ------------------------------------------------------------------ transports
class _StdioTransport:
    """Newline-delimited JSON-RPC 2.0 over a child process's stdio."""

    def __init__(self, command: str, args: list[str] | None, env: dict[str, str] | None) -> None:
        self.command = command
        self.args = args or []
        self.env = env or {}
        self.proc: asyncio.subprocess.Process | None = None
        self._next_id = 0

    async def start(self) -> None:
        merged = dict(os.environ)
        merged.update(self.env)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                self.command,
                *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=merged,
            )
        except FileNotFoundError as exc:
            raise MCPError(f"MCP stdio command not found: {self.command}") from exc
        except OSError as exc:
            raise MCPError(f"Could not spawn MCP server '{self.command}': {exc}") from exc

    async def send(self, message: dict[str, Any]) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()

    async def recv(self, timeout: float) -> dict[str, Any]:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
        except asyncio.TimeoutError as exc:
            raise MCPError(f"Timed out waiting for MCP server '{self.command}'") from exc
        if not line:
            raise MCPError(f"MCP server '{self.command}' closed stdout")
        try:
            return json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MCPError(f"Invalid JSON from MCP server: {exc}") from exc

    async def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        self._next_id += 1
        msg_id: int | str = self._next_id
        await self.send({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}})
        # Skip any server notifications; match on our request id.
        while True:
            msg = await self.recv(timeout)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    err = msg["error"]
                    raise MCPError(f"MCP error {err.get('code')}: {err.get('message')}")
                result = msg.get("result")
                return result if isinstance(result, dict) else {}
            # A notification or someone else's message: ignore and keep reading.

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    async def close(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except (asyncio.TimeoutError, ProcessLookupError, BrokenPipeError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass


def _parse_sse_json(text: str) -> dict[str, Any]:
    """Extract the first `data:` JSON payload from an SSE response body."""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload and payload != "[DONE]":
                parsed = json.loads(payload)
                return parsed if isinstance(parsed, dict) else {}
    raise MCPError("No data payload found in SSE response")


class _HttpTransport:
    """JSON-RPC 2.0 over HTTP POST (Streamable HTTP style)."""

    def __init__(self, url: str, headers: dict[str, str] | None, client: httpx.AsyncClient | None) -> None:
        self.url = url
        self.headers = headers or {}
        self.client = client or httpx.AsyncClient(timeout=DEFAULT_TIMEOUT)
        self._owns_client = client is None

    async def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        payload = {
            "jsonrpc": "2.0",
            "id": uuid.uuid4().hex,
            "method": method,
            "params": params or {},
        }
        try:
            resp = await self.client.post(self.url, json=payload, headers=self.headers, timeout=timeout)
        except httpx.HTTPError as exc:
            raise MCPError(f"MCP HTTP request failed: {exc}") from exc
        if resp.status_code >= 400:
            raise MCPError(f"MCP HTTP endpoint returned {resp.status_code}: {resp.text[:300]}")
        content_type = resp.headers.get("content-type", "")
        try:
            if "text/event-stream" in content_type:
                msg = _parse_sse_json(resp.text)
            else:
                msg = resp.json()
                if not isinstance(msg, dict):
                    raise MCPError("MCP HTTP endpoint returned a non-object response")
        except (json.JSONDecodeError, MCPError) as exc:
            raise MCPError(f"Could not parse MCP HTTP response: {exc}") from exc
        if "error" in msg:
            err = msg["error"]
            raise MCPError(f"MCP error {err.get('code')}: {err.get('message')}")
        result = msg.get("result")
        return result if isinstance(result, dict) else {}

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        # Fire-and-forget notification; failures are non-fatal.
        try:
            await self.client.post(
                self.url,
                json={"jsonrpc": "2.0", "method": method, "params": params or {}},
                headers=self.headers,
            )
        except httpx.HTTPError:
            pass

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()


# ------------------------------------------------------------------ client
def _content_text(result: dict[str, Any]) -> str:
    """Flatten MCP content blocks into plain text."""
    parts: list[str] = []
    for block in result.get("content", []) or []:
        if isinstance(block, dict):
            if block.get("type") == "text" or "text" in block:
                parts.append(str(block.get("text", "")))
            elif block.get("type") == "image":
                parts.append("[image content omitted]")
            else:
                parts.append(json.dumps(block, default=str))
        else:
            parts.append(str(block))
    text = "\n".join(p for p in parts if p).strip()
    return text or "(empty result)"


class MCPClient:
    """One connected MCP server. Call connect() before list_tools()/call_tool()."""

    def __init__(self, config: dict[str, Any], http_client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self.name = str(config.get("name", "mcp"))
        self.transport_name = str(config.get("transport", "stdio")).lower()
        self._transport: _StdioTransport | _HttpTransport | None = None
        self._http_client_override = http_client
        self.server_info: dict[str, Any] = {}
        self.negotiated_version: str | None = None

    def _build_transport(self) -> _StdioTransport | _HttpTransport:
        if self.transport_name == "stdio":
            command = self.config.get("command")
            if not command:
                raise MCPError(f"MCP server '{self.name}': stdio transport needs 'command'")
            return _StdioTransport(
                str(command),
                [str(a) for a in self.config.get("args", []) or []],
                {str(k): str(v) for k, v in (self.config.get("env") or {}).items()},
            )
        if self.transport_name == "http":
            url = self.config.get("url")
            if not url:
                raise MCPError(f"MCP server '{self.name}': http transport needs 'url'")
            return _HttpTransport(
                str(url),
                {str(k): str(v) for k, v in (self.config.get("headers") or {}).items()},
                self._http_client_override,
            )
        raise MCPError(f"MCP server '{self.name}': unknown transport '{self.transport_name}'")

    async def connect(self, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Run the MCP initialize handshake."""
        self._transport = self._build_transport()
        if isinstance(self._transport, _StdioTransport):
            await self._transport.start()
        try:
            result = await asyncio.wait_for(
                self._transport.request(
                    "initialize",
                    {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "rakazo", "version": "1.0"},
                    },
                ),
                timeout,
            )
        except asyncio.TimeoutError as exc:
            await self.aclose()
            raise MCPError(f"MCP server '{self.name}' did not answer initialize") from exc
        self.negotiated_version = result.get("protocolVersion")
        self.server_info = result.get("serverInfo", {}) if isinstance(result.get("serverInfo"), dict) else {}
        await self._transport.notify("notifications/initialized")
        log.info("MCP server '%s' connected (protocol %s)", self.name, self.negotiated_version)

    async def list_tools(self, timeout: float = DEFAULT_TIMEOUT) -> list[dict[str, Any]]:
        """Return [{name, description, inputSchema}, ...]."""
        if self._transport is None:
            raise MCPError(f"MCP server '{self.name}' is not connected")
        result = await self._transport.request("tools/list", {}, timeout)
        tools = result.get("tools", [])
        normalized: list[dict[str, Any]] = []
        for t in tools if isinstance(tools, list) else []:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            schema = t.get("inputSchema")
            normalized.append(
                {
                    "name": str(t["name"]),
                    "description": str(t.get("description") or ""),
                    "inputSchema": schema if isinstance(schema, dict) else {"type": "object"},
                }
            )
        return normalized

    async def call_tool(self, name: str, arguments: dict[str, Any] | None, timeout: float = DEFAULT_TIMEOUT) -> str:
        """Call a tool; return its content as plain text."""
        if self._transport is None:
            raise MCPError(f"MCP server '{self.name}' is not connected")
        result = await self._transport.request(
            "tools/call", {"name": name, "arguments": arguments or {}}, timeout
        )
        text = _content_text(result)
        if result.get("isError"):
            raise MCPError(f"MCP tool '{name}' reported an error: {text[:500]}")
        return text

    async def aclose(self) -> None:
        transport, self._transport = self._transport, None
        if transport is not None:
            await transport.close()


# ------------------------------------------------------------------ bot wiring
_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9_]")


def sanitize_name(value: str) -> str:
    """Make a string safe for use in a tool name."""
    return _SANITIZE_RE.sub("_", value).strip("_") or "unnamed"


def namespaced_tool_name(server_name: str, tool_name: str) -> str:
    """Namespace choice: ``mcp_<server>_<tool>`` (sanitized).

    Rationale: flat global tool namespace in the agent loop, so the prefix
    both avoids collisions with built-ins and tells the model which server a
    tool comes from. Documented here and in the agent module.
    """
    return f"mcp_{sanitize_name(server_name)}_{sanitize_name(tool_name)}"


@dataclass
class MCPToolRef:
    """One MCP tool exposed to the agent loop, with its namespaced name."""

    namespaced: str
    server_name: str
    tool_name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)


async def connect_bot_mcp_servers(
    raw_servers: list[dict[str, Any]] | None,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[dict[str, MCPClient], dict[str, MCPToolRef], list[str]]:
    """Connect each configured MCP server and list its tools.

    Returns ``(clients, tool_map, errors)`` where ``tool_map`` maps the
    namespaced tool name (``mcp_<server>_<tool>``) to an ``MCPToolRef``.
    Per-server failures are collected into ``errors`` instead of raising, so
    one bad server config can't take down the whole run.
    """
    clients: dict[str, MCPClient] = {}
    tool_map: dict[str, MCPToolRef] = {}
    errors: list[str] = []

    for raw in raw_servers or []:
        if not isinstance(raw, dict):
            errors.append(f"Invalid MCP server entry (not an object): {raw!r:.100}")
            continue
        name = str(raw.get("name") or "mcp").strip() or "mcp"
        client = MCPClient(raw, http_client=http_client)
        try:
            await client.connect()
            tools = await client.list_tools()
        except MCPError as exc:
            errors.append(f"MCP server '{name}': {exc}")
            await client.aclose()
            continue
        except Exception as exc:  # noqa: BLE001 - never let a server break the run
            errors.append(f"MCP server '{name}': unexpected error: {exc}")
            await client.aclose()
            continue
        clients[name] = client
        for tool in tools:
            base = namespaced_tool_name(name, tool["name"])
            namespaced = base
            suffix = 2
            while namespaced in tool_map:  # de-duplicate across servers
                namespaced = f"{base}_{suffix}"
                suffix += 1
            tool_map[namespaced] = MCPToolRef(
                namespaced=namespaced,
                server_name=name,
                tool_name=tool["name"],
                description=tool["description"],
                input_schema=tool["inputSchema"],
            )
    return clients, tool_map, errors
