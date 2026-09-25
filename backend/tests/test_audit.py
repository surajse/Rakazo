"""Audit log tests."""
from __future__ import annotations

from app.services import model_clients
from tests.conftest import FakeModel, make_bot, wait_for


async def test_audit_records_auth_and_config_events(client, user_headers):
    headers, tokens = user_headers
    bot, provider, sandbox = await make_bot(client, headers)

    r = await client.get("/api/audit?limit=100", headers=headers)
    assert r.status_code == 200
    events = {e["event_type"] for e in r.json()}
    assert "auth.signup" in events
    assert "provider.created" in events
    assert "sandbox.created" in events
    assert "bot.created" in events

    r = await client.get(f"/api/audit?bot_id={bot['id']}&limit=100", headers=headers)
    assert r.status_code == 200
    bot_events = {e["event_type"] for e in r.json()}
    assert "bot.created" in bot_events
    assert "auth.signup" not in bot_events  # filtered to this bot


async def test_audit_records_run_and_tool_events(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)
    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [
                    {"id": "c1", "name": "shell_run", "arguments": {"command": "echo hi"}}
                ],
            },
            {"content": "done", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "hi"}, headers=headers
    )

    async def _has_run_events():
        r = await client.get(f"/api/audit?bot_id={bot['id']}&limit=100", headers=headers)
        events = {e["event_type"] for e in r.json()}
        return events if {"run.started", "run.completed", "tool.executed"} <= events else None

    events = await wait_for(_has_run_events)
    assert "thread.message_sent" in events
