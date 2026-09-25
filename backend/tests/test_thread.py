"""Thread / message / streaming run flow with a scripted fake model."""
from __future__ import annotations

import json

from app.services import agent as agent_mod
from app.services import model_clients
from tests.conftest import FakeModel, make_bot, wait_for


def _tool_call(tc_id, name, arguments):
    return {"id": tc_id, "name": name, "arguments": arguments}


async def _post_and_wait(client, headers, bot_id, content, expect_text, timeout=25.0):
    r = await client.post(
        f"/api/bots/{bot_id}/thread/messages", json={"content": content}, headers=headers
    )
    assert r.status_code == 201, r.text
    run_id = r.json()["run_id"]

    async def _done():
        r = await client.get(f"/api/bots/{bot_id}/thread", headers=headers)
        msgs = r.json()["messages"]
        assistants = [m for m in msgs if m["role"] == "assistant" and m.get("content")]
        if assistants and expect_text in (assistants[-1]["content"] or ""):
            return assistants[-1]
        return None

    msg = await wait_for(_done, timeout=timeout)
    return run_id, msg


async def test_message_flow_with_tool_call(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "shell_run", {"command": "echo hello"})],
            },
            {"content": "The shell said hello.", "tool_calls": []},
            # summarizer call at end of run
            {"content": "Summary: user asked for a shell test.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    run_id, final = await _post_and_wait(
        client, headers, bot["id"], "run echo hello", "The shell said hello."
    )
    assert run_id

    # tool call + tool result persisted in history
    r = await client.get(f"/api/bots/{bot['id']}/thread", headers=headers)
    msgs = r.json()["messages"]
    roles = [m["role"] for m in msgs]
    assert roles[0] == "user"
    assert "assistant" in roles and "tool" in roles
    tool_msg = next(m for m in msgs if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "call_1"
    assert "fake-shell: echo hello" in tool_msg["content"]

    # thread summary was auto-generated
    assert r.json()["thread"]["summary"] is not None


async def test_message_pagination(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)
    fake = FakeModel(
        [
            {"content": "reply one", "tool_calls": []},
            {"content": "Summary one.", "tool_calls": []},
            {"content": "reply two", "tool_calls": []},
            {"content": "Summary two.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    await _post_and_wait(client, headers, bot["id"], "first", "reply one")
    await _post_and_wait(client, headers, bot["id"], "second", "reply two")

    r = await client.get(f"/api/bots/{bot['id']}/thread/messages?limit=2", headers=headers)
    page = r.json()
    assert len(page) == 2
    assert page[0]["content"] == "second"  # oldest-first within the page
    assert page[1]["content"] == "reply two"

    r = await client.get(
        f"/api/bots/{bot['id']}/thread/messages?before={page[0]['id']}&limit=50", headers=headers
    )
    older = r.json()
    assert [m["content"] for m in older] == ["first", "reply one"]


async def test_sse_stream(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)
    fake = FakeModel(
        [
            {"content": "streamed answer", "tool_calls": []},
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "hi"}, headers=headers
    )
    run_id = r.json()["run_id"]

    events = []
    async with client.stream(
        "GET",
        f"/api/bots/{bot['id']}/thread/messages/stream?run_id={run_id}",
        headers=headers,
        timeout=30,
    ) as resp:
        assert resp.status_code == 200
        current_event, data_lines = None, []
        async for line in resp.aiter_lines():
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].strip())
            elif line == "" and current_event:
                events.append((current_event, json.loads("".join(data_lines))))
                current_event, data_lines = None, []
                if events[-1][0] in ("done", "error"):
                    break

    types = [e[0] for e in events]
    assert "token" in types
    assert types[-1] == "done"
    token_text = "".join(e[1]["text"] for e in events if e[0] == "token")
    assert "streamed answer" in token_text


async def test_spawn_bot_tool_and_subbots_api(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)

    # Parent run: fake returns spawn_bot tool call, then final text.
    # Child run: fake returns final text immediately.
    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [
                    _tool_call("call_1", "spawn_bot", {"name": "Helper", "task": "do the thing"})
                ],
            },
            {"content": "Spawned a helper.", "tool_calls": []},
            {"content": "Summary parent.", "tool_calls": []},
            {"content": "Child did the thing.", "tool_calls": []},
            {"content": "Summary child.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    await _post_and_wait(client, headers, bot["id"], "delegate this", "Spawned a helper.")

    r = await client.get(f"/api/bots/{bot['id']}/subbots", headers=headers)
    children = r.json()
    assert len(children) == 1
    assert children[0]["parent_bot_id"] == bot["id"]
    assert children[0]["name"] == "Helper"

    async def _child_done():
        r = await client.get(f"/api/bots/{children[0]['id']}/thread", headers=headers)
        msgs = [m for m in r.json()["messages"] if m["role"] == "assistant" and m.get("content")]
        return msgs[-1] if msgs and "Child did the thing." in msgs[-1]["content"] else None

    await wait_for(_child_done)


async def test_run_helper_tool(client, user_headers, monkeypatch):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)
    fake = FakeModel(
        [
            # parent run, call 1 -> invokes the helper
            {
                "content": None,
                "tool_calls": [_tool_call("call_1", "run_helper", {"task": "check the notes"})],
            },
            # helper run, call 1 -> reads a file
            {
                "content": None,
                "tool_calls": [_tool_call("h1", "file_read", {"path": "/workspace/notes.txt"})],
            },
            # helper run, call 2 -> final
            {"content": "notes look fine", "tool_calls": []},
            # parent run, call 2 -> final (fake echoes the helper result)
            {"content": "Helper says: notes look fine.", "tool_calls": []},
            # thread summarizer
            {"content": "Summary.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    _, final = await _post_and_wait(
        client, headers, bot["id"], "use a helper", "Helper says: notes look fine."
    )
    assert final is not None
