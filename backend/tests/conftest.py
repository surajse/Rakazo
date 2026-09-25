"""Test fixtures: sqlite DB, seeded templates, mocked model + sandbox."""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

TEST_DB_PATH = "/tmp/rakazo_test.db"

# Point settings at sqlite before app modules are imported.
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{TEST_DB_PATH}"
os.environ["FERNET_KEY_FILE"] = "/tmp/rakazo_test_fernet.key"
os.environ.setdefault("JWT_SECRET", "test-secret")

import app.database as database  # noqa: E402
from app import deps  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Base, BotTemplate  # noqa: E402
from app.seed import TEMPLATES  # noqa: E402
from app.services import agent as agent_mod  # noqa: E402
from app.services import sandbox as sandbox_mod  # noqa: E402


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture()
async def db_engine():
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
    engine = create_async_engine(f"sqlite+aiosqlite:///{TEST_DB_PATH}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)


@pytest_asyncio.fixture()
async def session_factory(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    # Seed templates once per test run db.
    async with factory() as db:
        existing = (await db.execute(select(BotTemplate))).scalars().all()
        if not existing:
            for tpl in TEMPLATES:
                db.add(BotTemplate(**tpl))
            await db.commit()
    yield factory


class FakeSandboxSession(sandbox_mod.SandboxSession):
    """In-memory sandbox: files dict, canned http, echo shell."""

    def __init__(self) -> None:
        self.files: dict[str, str] = {"/workspace/notes.txt": "hello"}
        self.destroyed = False

    async def shell_run(self, command: str, timeout: int = 120) -> dict[str, Any]:
        return {"exit_code": 0, "stdout": f"fake-shell: {command}", "stderr": ""}

    async def file_read(self, path: str) -> dict[str, Any]:
        if path in self.files:
            return {"path": path, "content": self.files[path]}
        return {"path": path, "error": "not found"}

    async def file_write(self, path: str, content: str) -> dict[str, Any]:
        self.files[path] = content
        return {"path": path, "bytes_written": len(content.encode())}

    async def file_list(self, path: str = "/workspace") -> dict[str, Any]:
        entries = [
            {"name": p.split("/")[-1], "type": "file", "size": len(c)}
            for p, c in self.files.items()
            if p.startswith(path.rstrip("/") + "/")
        ]
        return {"path": path, "entries": entries}

    async def http_fetch(self, url: str, timeout: int = 30) -> dict[str, Any]:
        return {"url": url, "status": 200, "body": f"fake body for {url}"}

    async def browser_snapshot(self, url: str) -> dict[str, Any]:
        return {"url": url, "title": "Fake", "text": f"fake snapshot of {url}"}

    async def destroy(self) -> None:
        self.destroyed = True


class FakeModel:
    """Scripted model: pop responses per completion call."""

    def __init__(self, script: list[dict[str, Any]]):
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, provider, messages, tools=None, on_token=None, timeout=180):
        self.calls.append({"messages": messages, "tools": tools})
        resp = self.script.pop(0) if self.script else {"content": "done", "tool_calls": []}
        if on_token and resp.get("content"):
            await on_token(resp["content"])
        return resp


@pytest_asyncio.fixture()
async def client(session_factory, monkeypatch):
    """Async HTTP client with DB override + fake sandbox provider."""
    app = create_app()

    async def override_get_db():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[deps.get_db] = override_get_db

    # Background agent tasks use the router's SessionLocal directly (not the
    # get_db dependency), so point it at the test session factory. Otherwise
    # the agent would use the app's own engine with pooled connections to a
    # stale database file between tests.
    from app.routers import bots as bots_router  # noqa: E402

    monkeypatch.setattr(bots_router, "SessionLocal", session_factory)

    async def fake_create_session(self, config):
        return FakeSandboxSession()

    monkeypatch.setattr(
        sandbox_mod.LocalDockerProvider, "create_session", fake_create_session
    )
    monkeypatch.setattr(sandbox_mod.LocalDockerProvider, "is_configured", lambda self: True)
    # Shorten approval waits in tests.
    monkeypatch.setattr(agent_mod.settings, "approval_timeout_seconds", 30)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture()
async def user_headers(client):
    """Sign up a fresh user; return auth headers."""
    import uuid as _uuid

    email = f"user_{_uuid.uuid4().hex[:8]}@example.com"
    r = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "password123", "name": "Test User"},
    )
    assert r.status_code == 201, r.text
    tokens = r.json()
    return {"Authorization": f"Bearer {tokens['access_token']}"}, tokens


async def make_bot(client, headers, monkeypatch=None, **overrides):
    """Create provider + sandbox + bot; return (bot, provider, sandbox)."""
    r = await client.post(
        "/api/model-providers",
        json={"name": "P", "kind": "ollama", "model": "llama3", **overrides.pop("provider", {})},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    provider = r.json()
    r = await client.post(
        "/api/sandboxes",
        json={"name": "S", "kind": "local_docker", "config": {}},
        headers=headers,
    )
    assert r.status_code == 201, r.text
    sandbox = r.json()
    payload = {
        "name": "TestBot",
        "model_provider_id": provider["id"],
        "sandbox_id": sandbox["id"],
    }
    payload.update(overrides)
    r = await client.post("/api/bots", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    return r.json(), provider, sandbox


async def wait_for(coro_factory, timeout: float = 20.0, interval: float = 0.25):
    """Poll coro_factory until it returns truthy."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        result = await coro_factory()
        if result:
            return result
        if loop.time() > deadline:
            raise TimeoutError("wait_for timed out")
        await asyncio.sleep(interval)
