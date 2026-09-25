"""MCP tool sources: client unit tests (stdio + HTTP) and agent wiring end to end."""
from __future__ import annotations

import json
import sys

import httpx
import pytest

from app.services import mcp as mcp_mod
from app.services import model_clients
from tests.conftest import FakeModel, make_bot, wait_for

# A fake MCP server speaking newline-delimited JSON-RPC 2.0 over stdio.
FAKE_MCP_SERVER = '''
import json, sys

def respond(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    msg_id = msg.get("id")
    if method == "initialize":
        respond(msg_id, {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "0.1"},
        })
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        respond(msg_id, {"tools": [
            {"name": "add", "description": "Add two numbers", "inputSchema": {
                "type": "object",
                "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                "required": ["a", "b"],
            }},
            {"name": "echo", "description": "Echo text", "inputSchema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
            }},
        ]})
    elif method == "tools/call":
        params = msg.get("params", {})
        name = params.get("name")
        args = params.get("arguments", {})
        if name == "add":
            text = str(args.get("a", 0) + args.get("b", 0))
        else:
            text = "echo: " + str(args.get("text", ""))
        respond(msg_id, {"content": [{"type": "text", "text": text}]})
    elif msg_id is not None:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": -32601, "message": "unknown method"}}) + "\\n")
        sys.stdout.flush()
'''


def _write_fake_server(tmp_path):
    script = tmp_path / "fake_mcp.py"
    script.write_text(FAKE_MCP_SERVER)
    return str(script)


def _tool_call(tc_id, name, arguments):
    return {"id": tc_id, "name": name, "arguments": arguments}


# ------------------------------------------------------------ client: stdio
async def test_mcp_stdio_client_initialize_list_call(tmp_path):
    script = _write_fake_server(tmp_path)
    client = mcp_mod.MCPClient(
        {"name": "demo", "transport": "stdio", "command": sys.executable, "args": [script]}
    )
    await client.connect()
    assert client.negotiated_version == "2025-06-18"
    assert client.server_info["name"] == "fake-mcp"

    tools = await client.list_tools()
    by_name = {t["name"]: t for t in tools}
    assert set(by_name) == {"add", "echo"}
    assert by_name["add"]["description"] == "Add two numbers"
    assert by_name["add"]["inputSchema"]["required"] == ["a", "b"]

    assert await client.call_tool("add", {"a": 2, "b": 3}) == "5"
    assert await client.call_tool("echo", {"text": "hi"}) == "echo: hi"
    await client.aclose()


async def test_mcp_stdio_missing_command():
    client = mcp_mod.MCPClient(
        {"name": "nope", "transport": "stdio", "command": "/nonexistent/mcp-server-xyz"}
    )
    with pytest.raises(mcp_mod.MCPError):
        await client.connect()
    await client.aclose()


# ------------------------------------------------------------ client: HTTP
def _http_handler(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content.decode())
    method = body["method"]
    msg_id = body.get("id")
    if method == "initialize":
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "serverInfo": {"name": "fake-http-mcp", "version": "0.1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "ping",
                    "description": "Ping",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            ]
        }
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": "pong"}]}
    else:
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "nope"}}
        )
    return httpx.Response(200, json={"jsonrpc": "2.0", "id": msg_id, "result": result})


async def test_mcp_http_transport_initialize_list_call():
    transport = httpx.MockTransport(_http_handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = mcp_mod.MCPClient(
            {"name": "remote", "transport": "http", "url": "https://mcp.example.com/mcp"},
            http_client=http_client,
        )
        await client.connect()
        tools = await client.list_tools()
        assert [t["name"] for t in tools] == ["ping"]
        assert await client.call_tool("ping", {}) == "pong"
        await client.aclose()


# ------------------------------------------------------------ wiring helper
async def test_connect_bot_mcp_servers_namespacing(tmp_path):
    script = _write_fake_server(tmp_path)
    servers = [
        {"name": "demo", "transport": "stdio", "command": sys.executable, "args": [script]},
        {"name": "broken", "transport": "stdio", "command": "/nonexistent/xyz"},
    ]
    clients, tool_map, errors = await mcp_mod.connect_bot_mcp_servers(servers)
    try:
        # Bad servers are reported, not fatal.
        assert len(errors) == 1 and "broken" in errors[0]
        assert set(clients) == {"demo"}
        # Namespacing: mcp_<server>_<tool>.
        assert set(tool_map) == {"mcp_demo_add", "mcp_demo_echo"}
        ref = tool_map["mcp_demo_add"]
        assert (ref.server_name, ref.tool_name) == ("demo", "add")
    finally:
        for c in clients.values():
            await c.aclose()


# ------------------------------------------------------------ agent end to end
async def _pending_approval(client, headers):
    r = await client.get("/api/approvals?status=pending", headers=headers)
    items = r.json()
    return items[0] if items else None


async def _make_mcp_bot(client, headers, tmp_path):
    script = _write_fake_server(tmp_path)
    bot, _, _ = await make_bot(
        client,
        headers,
        mcp_servers=[
            {"name": "demo", "transport": "stdio", "command": sys.executable, "args": [script]}
        ],
    )
    assert bot["mcp_servers"][0]["name"] == "demo"  # config round-trips through the API
    return bot


async def test_mcp_tool_listed_invoked_and_approved(client, user_headers, monkeypatch, tmp_path):
    headers, _ = user_headers
    bot = await _make_mcp_bot(client, headers, tmp_path)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "mcp_demo_add", {"a": 2, "b": 3})],
            },
            {"content": "Sum is 5.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "add 2 and 3"}, headers=headers
    )
    assert r.status_code == 201

    # The namespaced MCP tool was offered to the model alongside built-ins.
    async def _model_called():
        return fake.calls[0] if fake.calls else None

    first_call = await wait_for(_model_called)
    offered = [t["function"]["name"] for t in first_call["tools"]]
    assert "mcp_demo_add" in offered
    assert "mcp_demo_echo" in offered
    assert "shell_run" in offered  # built-ins still present

    # Invocation is gated: an approval of kind mcp_tool is created.
    approval = await wait_for(lambda: _pending_approval(client, headers))
    assert approval["kind"] == "mcp_tool"
    assert approval["payload"]["server"] == "demo"
    assert approval["payload"]["tool"] == "add"
    assert approval["payload"]["arguments"] == {"a": 2, "b": 3}

    r = await client.post(f"/api/approvals/{approval['id']}/approve", headers=headers)
    assert r.status_code == 200

    async def _tool_result():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        tool_msgs = [m for m in msgs if m["role"] == "tool" and m.get("name") == "mcp_demo_add"]
        return tool_msgs[-1] if tool_msgs else None

    tool_msg = await wait_for(_tool_result)
    assert tool_msg["content"].strip() == "5"


async def test_mcp_tool_denied(client, user_headers, monkeypatch, tmp_path):
    headers, _ = user_headers
    bot = await _make_mcp_bot(client, headers, tmp_path)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "mcp_demo_echo", {"text": "secret"})],
            },
            {"content": "Could not echo.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)
    await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "echo something"}, headers=headers
    )

    approval = await wait_for(lambda: _pending_approval(client, headers))
    assert approval["kind"] == "mcp_tool"
    r = await client.post(
        f"/api/approvals/{approval['id']}/deny", json={"reason": "no mcp"}, headers=headers
    )
    assert r.status_code == 200

    async def _denied_result():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        tool_msgs = [m for m in msgs if m["role"] == "tool" and m.get("name") == "mcp_demo_echo"]
        if tool_msgs and "denied" in (tool_msgs[-1]["content"] or "").lower():
            return True
        return None

    await wait_for(_denied_result)
