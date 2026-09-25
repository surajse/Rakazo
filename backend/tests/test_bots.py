"""Bot CRUD, providers, sandboxes, templates, memory tests."""
from __future__ import annotations

from tests.conftest import make_bot


async def test_provider_crud_masks_key(client, user_headers):
    headers, _ = user_headers
    r = await client.post(
        "/api/model-providers",
        json={
            "name": "OpenAI",
            "kind": "openai_compatible",
            "base_url": "https://api.openai.com/v1",
            "api_key": "sk-super-secret-key-12345",
            "model": "gpt-4o",
        },
        headers=headers,
    )
    assert r.status_code == 201, r.text
    provider = r.json()
    assert provider["api_key_masked"] == "sk-••••••••2345"
    assert provider["has_api_key"] is True
    assert "sk-super-secret" not in r.text  # raw key never returned

    pid = provider["id"]
    r = await client.get("/api/model-providers", headers=headers)
    assert r.status_code == 200 and len(r.json()) == 1

    r = await client.patch(
        f"/api/model-providers/{pid}", json={"model": "gpt-4o-mini"}, headers=headers
    )
    assert r.status_code == 200 and r.json()["model"] == "gpt-4o-mini"

    r = await client.delete(f"/api/model-providers/{pid}", headers=headers)
    assert r.status_code == 204
    r = await client.get("/api/model-providers", headers=headers)
    assert r.json() == []


async def test_sandbox_kinds_and_crud(client, user_headers):
    headers, _ = user_headers
    r = await client.get("/api/sandbox-kinds")
    assert r.status_code == 200
    kinds = {k["kind"]: k for k in r.json()}
    assert set(kinds) == {"local_docker", "e2b", "daytona", "modal"}
    assert kinds["local_docker"]["configured"] is True  # monkeypatched in conftest
    assert kinds["e2b"]["configured"] is False
    assert "api_key" in kinds["e2b"]["config_schema"]["properties"]

    r = await client.post(
        "/api/sandboxes", json={"name": "Dev", "kind": "local_docker", "config": {}}, headers=headers
    )
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    r = await client.post(
        "/api/sandboxes", json={"name": "Bad", "kind": "nope", "config": {}}, headers=headers
    )
    assert r.status_code == 400
    r = await client.delete(f"/api/sandboxes/{sid}", headers=headers)
    assert r.status_code == 204


async def test_templates_seeded(client, user_headers):
    headers, _ = user_headers
    r = await client.get("/api/templates", headers=headers)
    assert r.status_code == 200
    names = {t["name"] for t in r.json()}
    assert names == {
        "Inbox Manager",
        "Sales Outbound",
        "Talent Scout",
        "Expense Manager",
        "Bug Triage",
        "Account Manager",
        "Paid Media",
        "Chief of Staff",
    }
    inbox = next(t for t in r.json() if t["name"] == "Inbox Manager")
    assert "## Daily triage" in inbox["routines_md"]


async def test_bot_crud(client, user_headers):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers, template="Inbox Manager")
    assert bot["template"] == "Inbox Manager"
    assert "## Daily triage" in bot["routines_md"]
    assert bot["parent_bot_id"] is None
    assert bot["status"] == "active"

    r = await client.get("/api/bots", headers=headers)
    assert len(r.json()) == 1

    r = await client.patch(f"/api/bots/{bot['id']}", json={"name": "Renamed"}, headers=headers)
    assert r.status_code == 200 and r.json()["name"] == "Renamed"

    r = await client.get(f"/api/bots/{bot['id']}", headers=headers)
    assert r.status_code == 200

    r = await client.delete(f"/api/bots/{bot['id']}", headers=headers)
    assert r.status_code == 204
    r = await client.get(f"/api/bots/{bot['id']}", headers=headers)
    assert r.status_code == 404


async def test_memory_crud(client, user_headers):
    headers, _ = user_headers
    bot, _, _ = await make_bot(client, headers)

    r = await client.post(
        f"/api/bots/{bot['id']}/memory", json={"key": "pref", "value": "dark mode"}, headers=headers
    )
    assert r.status_code == 201
    r = await client.get(f"/api/bots/{bot['id']}/memory", headers=headers)
    items = r.json()
    assert len(items) == 1 and items[0]["key"] == "pref" and items[0]["value"] == "dark mode"
    r = await client.delete(f"/api/bots/{bot['id']}/memory/pref", headers=headers)
    assert r.status_code == 204
    r = await client.get(f"/api/bots/{bot['id']}/memory", headers=headers)
    assert r.json() == []
