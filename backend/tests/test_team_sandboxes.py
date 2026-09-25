"""Team-shared sandboxes: sharing toggle, listing visibility, ownership
enforcement, and running bots against a shared sandbox owned by another user."""
from __future__ import annotations

import uuid

from app.services import model_clients
from tests.conftest import FakeModel, wait_for


async def _signup(client, name):
    email = f"team_{name}_{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "password123", "name": name},
    )
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_sandbox(client, headers, name="TeamBox"):
    r = await client.post(
        "/api/sandboxes",
        json={"name": name, "kind": "local_docker", "config": {}},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _list(client, headers):
    r = await client.get("/api/sandboxes", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def test_owner_can_share_and_unshare(client):
    headers = await _signup(client, "alice")
    sb = await _make_sandbox(client, headers)

    by_id = {s["id"]: s for s in await _list(client, headers)}
    assert by_id[sb["id"]]["shared"] is False
    assert by_id[sb["id"]]["is_owner"] is True

    r = await client.patch(f"/api/sandboxes/{sb['id']}", json={"shared": True}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["shared"] is True
    assert r.json()["is_owner"] is True

    by_id = {s["id"]: s for s in await _list(client, headers)}
    assert by_id[sb["id"]]["shared"] is True

    r = await client.patch(f"/api/sandboxes/{sb['id']}", json={"shared": False}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["shared"] is False


async def test_non_owner_sees_shared_sandbox_in_list(client):
    alice = await _signup(client, "alice")
    bob = await _signup(client, "bob")
    shared = await _make_sandbox(client, alice, name="SharedBox")
    private = await _make_sandbox(client, alice, name="PrivateBox")
    await client.patch(f"/api/sandboxes/{shared['id']}", json={"shared": True}, headers=alice)

    sandboxes = await _list(client, bob)
    by_id = {s["id"]: s for s in sandboxes}
    assert shared["id"] in by_id
    assert private["id"] not in by_id

    view = by_id[shared["id"]]
    assert view["is_owner"] is False
    assert view["shared"] is True
    assert view["owner_name"] == "alice" or view["owner_email"] is not None


async def test_non_owner_cannot_edit_delete_or_share(client):
    alice = await _signup(client, "alice")
    bob = await _signup(client, "bob")
    shared = await _make_sandbox(client, alice, name="SharedBox")
    await client.patch(f"/api/sandboxes/{shared['id']}", json={"shared": True}, headers=alice)

    # Bob cannot rename, re-share/unshare, or delete alice's sandbox.
    r = await client.patch(
        f"/api/sandboxes/{shared['id']}", json={"name": "Hijacked"}, headers=bob
    )
    assert r.status_code == 404, r.text
    r = await client.patch(
        f"/api/sandboxes/{shared['id']}", json={"shared": False}, headers=bob
    )
    assert r.status_code == 404, r.text
    r = await client.delete(f"/api/sandboxes/{shared['id']}", headers=bob)
    assert r.status_code == 404, r.text

    # The sandbox is untouched and still shared.
    sandboxes = await _list(client, alice)
    by_id = {s["id"]: s for s in sandboxes}
    assert by_id[shared["id"]]["name"] == "SharedBox"
    assert by_id[shared["id"]]["shared"] is True


async def test_private_sandbox_rejected_for_other_user_bots(client):
    alice = await _signup(client, "alice")
    bob = await _signup(client, "bob")
    private = await _make_sandbox(client, alice, name="PrivateBox")

    r = await client.post(
        "/api/model-providers",
        json={"name": "P", "kind": "ollama", "model": "llama3"},
        headers=bob,
    )
    assert r.status_code == 201, r.text
    provider = r.json()

    # Bob cannot attach alice's private sandbox to a new bot.
    r = await client.post(
        "/api/bots",
        json={
            "name": "BobsBot",
            "model_provider_id": provider["id"],
            "sandbox_id": private["id"],
        },
        headers=bob,
    )
    assert r.status_code == 400, r.text

    # Bob also cannot swap an existing bot onto it.
    r = await client.post(
        "/api/bots",
        json={"name": "BobsBot", "model_provider_id": provider["id"]},
        headers=bob,
    )
    assert r.status_code == 201, r.text
    bot = r.json()
    r = await client.patch(
        f"/api/bots/{bot['id']}", json={"sandbox_id": private["id"]}, headers=bob
    )
    assert r.status_code == 400, r.text


async def test_run_executes_against_shared_sandbox_owned_by_other_user(client, monkeypatch):
    alice = await _signup(client, "alice")
    bob = await _signup(client, "bob")
    shared = await _make_sandbox(client, alice, name="SharedBox")
    await client.patch(f"/api/sandboxes/{shared['id']}", json={"shared": True}, headers=alice)

    r = await client.post(
        "/api/model-providers",
        json={"name": "P", "kind": "ollama", "model": "llama3"},
        headers=bob,
    )
    assert r.status_code == 201, r.text
    provider = r.json()

    # Bob can attach alice's shared sandbox to his bot.
    r = await client.post(
        "/api/bots",
        json={
            "name": "BobsBot",
            "model_provider_id": provider["id"],
            "sandbox_id": shared["id"],
        },
        headers=bob,
    )
    assert r.status_code == 201, r.text
    bot = r.json()

    fake = FakeModel(
        [
            {
                "content": None,
                "tool_calls": [
                    {"id": "call_1", "name": "shell_run", "arguments": {"command": "echo hello"}}
                ],
            },
            {"content": "The shell said hello.", "tool_calls": []},
            {"content": "Summary: user asked for a shell test.", "tool_calls": []},
        ]
    )
    monkeypatch.setattr(model_clients, "chat_completion", fake)

    r = await client.post(
        f"/api/bots/{bot['id']}/thread/messages", json={"content": "run echo hello"}, headers=bob
    )
    assert r.status_code == 201, r.text

    async def _done():
        r = await client.get(f"/api/bots/{bot['id']}/thread", headers=bob)
        msgs = r.json()["messages"]
        assistants = [m for m in msgs if m["role"] == "assistant" and m.get("content")]
        if assistants and "The shell said hello." in (assistants[-1]["content"] or ""):
            return assistants[-1]
        return None

    msg = await wait_for(_done, timeout=25.0)
    assert msg is not None

    # The shell tool ran inside a sandbox session resolved from the shared row.
    r = await client.get(f"/api/bots/{bot['id']}/thread", headers=bob)
    tool_msg = next(m for m in r.json()["messages"] if m["role"] == "tool")
    assert "fake-shell: echo hello" in tool_msg["content"]
