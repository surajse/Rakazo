"""Approval flow: agent pauses, user approves/denies via API, run resumes."""
from __future__ import annotations

from app.services import model_clients
from tests.conftest import FakeModel, make_bot, wait_for


def _tool_call(tc_id, name, arguments):
    return {"id": tc_id, "name": name, "arguments": arguments}


async def test_network_approval_approve_flow(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "http_fetch", {"url": "https://example.com/data"})],
            },
            {"content": "Fetched the data.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "fetch that url"}, headers=headers
    )
    assert r.status_code == 201

    async def _pending():
        r = await client.get("/api/approvals?status=pending", headers=headers)
        items = r.json()
        return items[0] if items else None

    approval = await wait_for(_pending)
    assert approval["kind"] == "network"
    assert "example.com" in approval["description"]

    r = await client.post(f"/api/approvals/{approval['id']}/approve", headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "approved"

    async def _done():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = [m for m in r.json()["messages"] if m["role"] == "assistant" and m.get("content")]
        return msgs[-1] if msgs and "Fetched the data." in msgs[-1]["content"] else None

    await wait_for(_done)

    # second fetch to the same host needs no approval (host is now seen)
    fake2 = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_2", "http_fetch", {"url": "https://example.com/other"})],
            },
            {"content": "Fetched again.", "tool_calls": []},
            {"content": "Summary 2.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake2)
    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "fetch again"}, headers=headers
    )
    assert r.status_code == 201

    async def _done2():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = [m for m in r.json()["messages"] if m["role"] == "assistant" and m.get("content")]
        return msgs[-1] if msgs and "Fetched again." in msgs[-1]["content"] else None

    await wait_for(_done2)
    r = await client.get("/api/approvals?status=pending", headers=headers)
    assert r.json() == []


async def test_install_approval_denied(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "shell_run", {"command": "pip install requests"})],
            },
            {"content": "I could not install it.", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "install requests"}, headers=headers
    )
    assert r.status_code == 201

    async def _pending():
        r = await client.get("/api/approvals?status=pending", headers=headers)
        items = r.json()
        return items[0] if items else None

    approval = await wait_for(_pending)
    assert approval["kind"] == "install"

    r = await client.post(
        f"/api/approvals/{approval['id']}/deny", json={"reason": "no installs"}, headers=headers
    )
    assert r.status_code == 200 and r.json()["status"] == "denied"

    async def _done():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
        msgs = r.json()["messages"]
        tool_msgs = [m for m in msgs if m["role"] == "tool"]
        assistants = [m for m in msgs if m["role"] == "assistant" and m.get("content")]
        if tool_msgs and assistants and "denied" in (tool_msgs[-1]["content"] or "").lower():
            return True
        return None

    await wait_for(_done)


async def test_approve_twice_conflicts(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)
    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "http_fetch", {"url": "https://x.example/a"})],
            },
            {"content": "ok", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)
    await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "go"}, headers=headers
    )

    async def _pending():
        r = await client.get("/api/approvals?status=pending", headers=headers)
        items = r.json()
        return items[0] if items else None

    approval = await wait_for(_pending)
    r = await client.post(f"/api/approvals/{approval['id']}/approve", headers=headers)
    assert r.status_code == 200
    r = await client.post(f"/api/approvals/{approval['id']}/approve", headers=headers)
    assert r.status_code == 409
