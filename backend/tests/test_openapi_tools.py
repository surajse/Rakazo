"""OpenAPI tool sources: spec parsing, invocation, and agent wiring end to end."""
from __future__ import annotations

import json

import httpx
import pytest

from app.services import openapi_tools as openapi_mod
from app.services import model_clients
from tests.conftest import FakeModel, make_bot, wait_for

SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "Widget API", "version": "1.0"},
    "servers": [{"url": "https://api.example.com/v1"}],
    "paths": {
        "/widgets/{widgetId}": {
            "get": {
                "operationId": "getWidget",
                "summary": "Get a widget",
                "description": "Returns a single widget by ID.",
                "parameters": [
                    {
                        "name": "widgetId",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {
                        "name": "verbose",
                        "in": "query",
                        "schema": {"type": "boolean", "description": "Verbose output"},
                    },
                    {"name": "X-Tenant", "in": "header", "schema": {"type": "string"}},
                ],
                "responses": {"200": {"description": "ok"}},
            }
        },
        "/widgets": {
            "post": {
                "operationId": "createWidget",
                "summary": "Create a widget",
                "requestBody": {
                    "required": True,
                    "description": "The widget to create",
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/Widget"}
                        }
                    },
                },
                "responses": {"201": {"description": "created"}},
            }
        },
    },
    "components": {
        "schemas": {
            "Widget": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "default": 1},
                },
                "required": ["name"],
            }
        }
    },
}

YAML_SPEC = """\
openapi: 3.0.0
info:
  title: Ping API
  version: '1'
servers:
  - url: https://ping.example.com
paths:
  /ping:
    get:
      operationId: ping
      summary: Ping the API
      responses:
        '200':
          description: ok
"""

SPEC_URL = "https://specs.example.com/openapi.json"


def _spec_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200, json=SPEC, headers={"content-type": "application/json"}
    )


def _api_handler_factory(recorded: list):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "specs.example.com":
            return _spec_handler(request)
        recorded.append(request)
        return httpx.Response(
            200,
            json={"id": "w-1", "name": "gizmo"},
            headers={"content-type": "application/json"},
        )

    return handler


def _tool_call(tc_id, name, arguments):
    return {"id": tc_id, "name": name, "arguments": arguments}


# ------------------------------------------------------------ spec parsing
def test_parse_spec_builds_tool_defs():
    refs = {r.operation: r for r in openapi_mod.parse_spec(SPEC)}
    assert set(refs) == {"getWidget", "createWidget"}

    get = refs["getWidget"]
    assert get.method == "GET"
    assert get.path_template == "/widgets/{widgetId}"
    assert "Get a widget" in get.description
    assert "Returns a single widget by ID." in get.description
    props = get.input_schema["properties"]
    assert set(props) == {"widgetId", "verbose", "X-Tenant"}
    assert props["widgetId"]["type"] == "string"
    assert props["verbose"]["type"] == "boolean"
    # Path params are always required; others follow the spec.
    assert get.input_schema["required"] == ["widgetId"]

    create = refs["createWidget"]
    assert create.method == "POST"
    assert create.has_json_body and create.body_required
    body = create.input_schema["properties"]["body"]
    # The $ref to #/components/schemas/Widget was inlined.
    assert body["type"] == "object"
    assert set(body["properties"]) == {"name", "quantity"}
    assert body["required"] == ["name"]
    assert create.input_schema["required"] == ["body"]


def test_parse_spec_operation_id_fallback_name():
    spec = {
        "openapi": "3.1.0",
        "info": {"title": "t", "version": "1"},
        "servers": [{"url": "https://x.example.com"}],
        "paths": {"/things/{id}": {"delete": {"responses": {"204": {"description": "gone"}}}}},
    }
    (ref,) = openapi_mod.parse_spec(spec)
    assert ref.operation == "delete /things/{id}"
    # Namespacing sanitizes method + path when there is no operationId.
    assert openapi_mod.namespaced_tool_name("shop", ref.operation) == "openapi_shop_delete__things__id"


async def test_parse_spec_rejects_swagger_2():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(200, json={"swagger": "2.0", "paths": {}})
        )
    ) as client:
        with pytest.raises(openapi_mod.OpenAPIError, match="2.0"):
            await openapi_mod.fetch_spec_document("https://x.example.com/s.json", client)


# ------------------------------------------------------------ spec fetching
async def test_fetch_spec_json_and_yaml():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200, text=YAML_SPEC, headers={"content-type": "text/yaml"}
            )
        )
    ) as client:
        doc = await openapi_mod.fetch_spec_document("https://x.example.com/spec.yaml", client)
    assert doc["openapi"] == "3.0.0"
    refs = openapi_mod.parse_spec(doc)
    assert [r.operation for r in refs] == ["ping"]


async def test_fetch_spec_yaml_without_pyyaml_gives_clear_error(monkeypatch):
    monkeypatch.setattr(openapi_mod, "_HAS_YAML", False)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda req: httpx.Response(
                200, text=YAML_SPEC, headers={"content-type": "text/yaml"}
            )
        )
    ) as client:
        with pytest.raises(openapi_mod.OpenAPIError, match="PyYAML"):
            await openapi_mod.fetch_spec_document("https://x.example.com/spec.yaml", client)


async def test_fetch_spec_http_error():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda req: httpx.Response(404, text="nope"))
    ) as client:
        with pytest.raises(openapi_mod.OpenAPIError, match="404"):
            await openapi_mod.fetch_spec_document(SPEC_URL, client)


# ------------------------------------------------------------ auth shapes
def test_normalize_auth_shapes():
    assert openapi_mod._normalize_auth(None) is None
    assert openapi_mod._normalize_auth("sk-abc") == {"header": ("Authorization", "Bearer sk-abc")}
    assert openapi_mod._normalize_auth({"type": "header", "name": "X-API-Key", "value": "k"}) == {
        "header": ("X-API-Key", "k")
    }
    assert openapi_mod._normalize_auth({"type": "query", "name": "api_key", "value": "k"}) == {
        "query": ("api_key", "k")
    }
    assert openapi_mod._normalize_auth({"type": "bearer", "value": "k"}) == {
        "header": ("Authorization", "Bearer k")
    }
    with pytest.raises(openapi_mod.OpenAPIError, match="Unknown auth type"):
        openapi_mod._normalize_auth({"type": "oauth2", "value": "k"})
    # Redacted form never carries the secret.
    assert "k" not in openapi_mod._redacted_auth({"header": ("X-API-Key", "k")})


# ------------------------------------------------------------ invocation
def _source(recorded, auth):
    client = httpx.AsyncClient(transport=httpx.MockTransport(_api_handler_factory(recorded)))
    return openapi_mod.OpenAPISource(
        {"name": "widgets", "spec_url": SPEC_URL, "auth": auth}, http_client=client
    )


async def test_call_tool_builds_url_method_headers():
    recorded: list = []
    source = _source(recorded, {"type": "header", "name": "X-API-Key", "value": "s3cr3t"})
    try:
        await source.load()
        ref = next(r for r in source.tools if r.operation == "getWidget")
        result = await source.call_tool(
            ref, {"widgetId": "w-1", "verbose": True, "X-Tenant": "acme"}
        )
    finally:
        await source.aclose()
    assert "gizmo" in result  # JSON response returned as text

    (req,) = recorded
    assert req.method == "GET"
    assert str(req.url).startswith("https://api.example.com/v1/widgets/w-1")
    assert req.url.params["verbose"] == "true"
    assert req.headers["X-Tenant"] == "acme"
    assert req.headers["X-API-Key"] == "s3cr3t"


async def test_call_tool_post_json_body_and_query_auth():
    recorded: list = []
    source = _source(recorded, {"type": "query", "name": "api_key", "value": "q-secret"})
    try:
        await source.load()
        ref = next(r for r in source.tools if r.operation == "createWidget")
        await source.call_tool(ref, {"body": {"name": "gizmo", "quantity": 3}})
    finally:
        await source.aclose()
    (req,) = recorded
    assert req.method == "POST"
    assert req.url.path == "/v1/widgets"
    assert json.loads(req.content.decode()) == {"name": "gizmo", "quantity": 3}
    assert req.url.params["api_key"] == "q-secret"


async def test_call_tool_string_shorthand_auth_is_bearer():
    recorded: list = []
    source = _source(recorded, "tok-123")
    try:
        await source.load()
        ref = next(r for r in source.tools if r.operation == "getWidget")
        await source.call_tool(ref, {"widgetId": "w-9"})
    finally:
        await source.aclose()
    assert recorded[0].headers["Authorization"] == "Bearer tok-123"


async def test_call_tool_missing_required_arg():
    recorded: list = []
    source = _source(recorded, None)
    try:
        await source.load()
        ref = next(r for r in source.tools if r.operation == "getWidget")
        with pytest.raises(openapi_mod.OpenAPIError, match="widgetId"):
            await source.call_tool(ref, {})
        create = next(r for r in source.tools if r.operation == "createWidget")
        with pytest.raises(openapi_mod.OpenAPIError, match="body"):
            await source.call_tool(create, {})
    finally:
        await source.aclose()
    assert not recorded  # nothing was sent


async def test_call_tool_server_error_never_leaks_secret():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "specs.example.com":
            return _spec_handler(request)
        return httpx.Response(500, text="internal boom")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    source = openapi_mod.OpenAPISource(
        {
            "name": "widgets",
            "spec_url": SPEC_URL,
            "auth": {"type": "header", "name": "X-API-Key", "value": "s3cr3t-value"},
        },
        http_client=client,
    )
    try:
        await source.load()
        ref = next(r for r in source.tools if r.operation == "getWidget")
        with pytest.raises(openapi_mod.OpenAPIError) as excinfo:
            await source.call_tool(ref, {"widgetId": "w-1"})
    finally:
        await source.aclose()
    assert "500" in str(excinfo.value)
    assert "s3cr3t-value" not in str(excinfo.value)


async def test_base_url_override_and_server_variables():
    spec = {
        "openapi": "3.0.0",
        "info": {"title": "t", "version": "1"},
        "servers": [
            {
                "url": "https://{env}.example.com/{base}",
                "variables": {"env": {"default": "prod"}, "base": {"default": "v2"}},
            }
        ],
        "paths": {"/ping": {"get": {"operationId": "ping", "responses": {}}}},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/spec.json":
            return httpx.Response(200, json=spec)
        return httpx.Response(200, text="pong")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    source = openapi_mod.OpenAPISource(
        {"name": "s", "spec_url": "https://x.example.com/spec.json"}, http_client=client
    )
    try:
        await source.load()
        assert source.base_url == "https://prod.example.com/v2"
    finally:
        await source.aclose()

    # Explicit base_url wins over servers[0].url.
    client2 = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    source2 = openapi_mod.OpenAPISource(
        {
            "name": "s",
            "spec_url": "https://x.example.com/spec.json",
            "base_url": "https://override.example.com/api",
        },
        http_client=client2,
    )
    try:
        await source2.load()
        assert source2.base_url == "https://override.example.com/api"
    finally:
        await source2.aclose()


# ------------------------------------------------------------ wiring helper
async def test_connect_bot_openapi_specs_namespacing_and_errors():
    recorded: list = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(_api_handler_factory(recorded)))
    specs = [
        {"name": "widgets", "spec_url": SPEC_URL},
        {"name": "widgets", "spec_url": SPEC_URL},  # duplicate name -> dedupe suffix
        {"name": "broken", "spec_url": "https://nope.example.com/missing.json"},
        {"name": "nourl"},
    ]
    sources, tool_map, errors = await openapi_mod.connect_bot_openapi_specs(specs, http_client=client)
    try:
        assert len(errors) == 2
        assert any("broken" in e for e in errors)
        assert any("nourl" in e for e in errors)
        assert set(sources) == {"widgets"}
        # Namespacing: openapi_<source>_<operation>, deduped across sources.
        assert "openapi_widgets_getWidget" in tool_map
        assert "openapi_widgets_getWidget_2" in tool_map
        assert "openapi_widgets_createWidget" in tool_map
        ref = tool_map["openapi_widgets_getWidget"]
        assert (ref.source_name, ref.operation) == ("widgets", "getWidget")
    finally:
        for s in sources.values():
            await s.aclose()


# ------------------------------------------------------------ agent end to end
async def _pending_approval(client, headers):
    r = await client.get("/api/approvals?status=pending", headers=headers)
    items = r.json()
    return items[0] if items else None


async def _make_openapi_bot(client, headers, monkeypatch):
    recorded: list = []
    transport = httpx.MockTransport(_api_handler_factory(recorded))
    real_client = openapi_mod.httpx.AsyncClient
    monkeypatch.setattr(
        openapi_mod.httpx,
        "AsyncClient",
        lambda *a, **k: real_client(transport=transport, *a, **k),
    )
    bot, _, _ = await make_bot(
        client,
        headers,
        openapi_specs=[
            {
                "name": "widgets",
                "spec_url": SPEC_URL,
                "auth": {"type": "header", "name": "X-API-Key", "value": "s3cr3t"},
            }
        ],
    )
    assert bot["openapi_specs"][0]["name"] == "widgets"  # config round-trips through the API
    return bot, recorded


async def test_openapi_tool_listed_invoked_and_approved(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, recorded = await _make_openapi_bot(client, headers, monkeypatch)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [
                    _tool_call("call_1", "openapi_widgets_getWidget", {"widgetId": "w-1"})
                ],
            },
            {"content": "Widget gizmo.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "get widget w-1"}, headers=headers
    )
    assert r.status_code == 201

    # The namespaced OpenAPI tool was offered to the model alongside built-ins.
    async def _model_called():
        return fake.calls[0] if fake.calls else None

    first_call = await wait_for(_model_called)
    offered = [t["function"]["name"] for t in first_call["tools"]]
    assert "openapi_widgets_getWidget" in offered
    assert "openapi_widgets_createWidget" in offered
    assert "shell_run" in offered  # built-ins still present

    # Invocation is gated: an approval of kind openapi_tool is created.
    approval = await wait_for(lambda: _pending_approval(client, headers))
    assert approval["kind"] == "openapi_tool"
    assert approval["payload"]["source"] == "widgets"
    assert approval["payload"]["operation"] == "getWidget"
    assert approval["payload"]["arguments"] == {"widgetId": "w-1"}

    r = await client.post(f"/api/approvals/{approval['id']}/approve", headers=headers)
    assert r.status_code == 200

    async def _tool_result():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        tool_msgs = [
            m for m in msgs if m["role"] == "tool" and m.get("name") == "openapi_widgets_getWidget"
        ]
        return tool_msgs[-1] if tool_msgs else None

    tool_msg = await wait_for(_tool_result)
    assert "gizmo" in tool_msg["content"]

    # The outgoing API call hit the right URL/method with the configured credential.
    assert recorded, "expected the API call to be recorded"
    req = recorded[0]
    assert req.method == "GET"
    assert req.url.path == "/v1/widgets/w-1"
    assert req.headers["X-API-Key"] == "s3cr3t"


async def test_openapi_tool_denied(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _ = await _make_openapi_bot(client, headers, monkeypatch)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [
                    _tool_call(
                        "call_1",
                        "openapi_widgets_createWidget",
                        {"body": {"name": "evil"}},
                    )
                ],
            },
            {"content": "Could not create.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)
    await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "create a widget"}, headers=headers
    )

    approval = await wait_for(lambda: _pending_approval(client, headers))
    assert approval["kind"] == "openapi_tool"
    r = await client.post(
        f"/api/approvals/{approval['id']}/deny", json={"reason": "no api calls"}, headers=headers
    )
    assert r.status_code == 200

    async def _denied_result():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        tool_msgs = [
            m
            for m in msgs
            if m["role"] == "tool" and m.get("name") == "openapi_widgets_createWidget"
        ]
        if tool_msgs and "denied" in (tool_msgs[-1]["content"] or "").lower():
            return True
        return None

    await wait_for(_denied_result)


async def test_openapi_spec_failure_never_fails_run(client, user_headers, monkeypatch):
    """A bot whose spec URL is unreachable still completes its run."""
    headers, _ = user_headers
    transport = httpx.MockTransport(lambda req: httpx.Response(500, text="down"))
    real_client = openapi_mod.httpx.AsyncClient
    monkeypatch.setattr(
        openapi_mod.httpx,
        "AsyncClient",
        lambda *a, **k: real_client(transport=transport, *a, **k),
    )
    bot, _, _ = await make_bot(
        client,
        headers,
        openapi_specs=[{"name": "broken", "spec_url": "https://down.example.com/s.json"}],
    )

    fake = FakeModel(
        [
            {"content": "No API tools available, but I can still chat.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)
    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "hi"}, headers=headers
    )
    assert r.status_code == 201

    async def _done():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        assistant = [m for m in msgs if m["role"] == "assistant" and m.get("content")]
        return assistant[-1] if assistant else None

    msg = await wait_for(_done)
    assert "still chat" in (msg["content"] or "")
    # The broken spec was not offered as a tool.
    offered = [t["function"]["name"] for t in fake.calls[0]["tools"]]
    assert not any(n.startswith("openapi_") for n in offered)
