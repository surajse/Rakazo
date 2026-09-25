"""Tests for the E2B sandbox provider.

The e2b SDK is fully mocked (a fake module is injected into sys.modules), so
these tests never make live API calls. They verify config handling, SDK call
shapes, and result mapping against the e2b 2.x API.
"""
from __future__ import annotations

import json
import sys
import types

import pytest

from app.services import sandbox as sandbox_mod
from app.services.sandbox import E2BProvider, E2BSession, SandboxNotConfigured, get_provider


# ----------------------------------------------------------------- fakes
class _FakeResult:
    def __init__(self, stdout="", stderr="", exit_code=0):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code


class _FakeCommands:
    def __init__(self):
        self.calls: list[dict] = []

    def run(self, cmd, timeout=None, **kwargs):
        self.calls.append({"cmd": cmd, "timeout": timeout})
        if "urlopen" in cmd:
            body = (
                "<html><head><title>Hi</title></head>"
                "<body><p>Hello world</p><script>var x = 1;</script></body></html>"
            )
            return _FakeResult(stdout=json.dumps({"status": 200, "body": body}))
        if cmd.startswith("boom"):
            raise RuntimeError("command exploded")
        return _FakeResult(stdout="ok-out", stderr="ok-err", exit_code=0)


class _FakeType:
    def __init__(self, value):
        self.value = value


class _FakeEntry:
    def __init__(self, name, ftype, size):
        self.name = name
        self.type = _FakeType(ftype)
        self.size = size


class _FakeFiles:
    def __init__(self):
        self.store = {"/workspace/a.txt": "hello"}
        self.reads: list[str] = []
        self.writes: list[tuple] = []
        self.lists: list[str] = []

    def read(self, path):
        self.reads.append(path)
        if path not in self.store:
            raise RuntimeError(f"file not found: {path}")
        return self.store[path]

    def write(self, path, data):
        self.writes.append((path, data))
        self.store[path] = data

    def list(self, path):
        self.lists.append(path)
        if path != "/workspace":
            raise RuntimeError(f"no such dir: {path}")
        return [_FakeEntry("a.txt", "file", 5), _FakeEntry("sub", "dir", 0)]


class _FakeSandbox:
    def __init__(self):
        self.commands = _FakeCommands()
        self.files = _FakeFiles()
        self.killed = False

    def kill(self):
        self.killed = True
        return True


class _FakeSandboxClass:
    """Stands in for e2b.Sandbox (class-method API like the real SDK)."""

    last_kwargs: dict | None = None
    sbx: _FakeSandbox | None = None
    raise_on_create: Exception | None = None

    @classmethod
    def create(cls, **kwargs):
        cls.last_kwargs = kwargs
        if cls.raise_on_create is not None:
            raise cls.raise_on_create
        cls.sbx = _FakeSandbox()
        return cls.sbx


@pytest.fixture()
def fake_e2b(monkeypatch):
    _FakeSandboxClass.last_kwargs = None
    _FakeSandboxClass.sbx = None
    _FakeSandboxClass.raise_on_create = None
    mod = types.ModuleType("e2b")
    mod.Sandbox = _FakeSandboxClass
    monkeypatch.setitem(sys.modules, "e2b", mod)
    monkeypatch.delenv("E2B_API_KEY", raising=False)
    return mod


@pytest.fixture()
async def session(fake_e2b):  # noqa: ARG001
    return await E2BProvider().create_session({"api_key": "test-key"})


# ----------------------------------------------------------------- provider
def test_e2b_registered():
    provider = get_provider("e2b")
    assert isinstance(provider, E2BProvider)
    assert provider.kind == "e2b"
    schema = provider.config_schema()
    assert {"api_key", "template", "timeout"} <= set(schema["properties"])


async def test_missing_api_key_raises(fake_e2b):  # noqa: ARG001
    with pytest.raises(SandboxNotConfigured, match="API key"):
        await E2BProvider().create_session({})


async def test_create_session_passes_config(fake_e2b):  # noqa: ARG001
    sess = await E2BProvider().create_session(
        {"api_key": "k", "template": "tpl-x", "timeout": 600}
    )
    assert isinstance(sess, E2BSession)
    assert _FakeSandboxClass.last_kwargs == {
        "template": "tpl-x",
        "timeout": 600,
        "api_key": "k",
    }


async def test_create_session_defaults(fake_e2b):  # noqa: ARG001
    await E2BProvider().create_session({"api_key": "k"})
    assert _FakeSandboxClass.last_kwargs == {
        "template": None,
        "timeout": 300,
        "api_key": "k",
    }


async def test_create_session_reads_key_from_env(fake_e2b, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "env-key")
    await E2BProvider().create_session({})
    assert _FakeSandboxClass.last_kwargs["api_key"] == "env-key"


async def test_create_failure_raises_not_configured(fake_e2b):  # noqa: ARG001
    _FakeSandboxClass.raise_on_create = RuntimeError("denied")
    with pytest.raises(SandboxNotConfigured, match="creation failed"):
        await E2BProvider().create_session({"api_key": "k"})


def test_is_configured_without_key(fake_e2b):  # noqa: ARG001
    assert E2BProvider().is_configured() is False


def test_is_configured_with_env_key(fake_e2b, monkeypatch):
    monkeypatch.setenv("E2B_API_KEY", "env-key")
    assert E2BProvider().is_configured() is True


# ----------------------------------------------------------------- session
async def test_shell_run(session):
    out = await session.shell_run("echo hi", timeout=30)
    assert out == {"exit_code": 0, "stdout": "ok-out", "stderr": "ok-err"}
    call = _FakeSandboxClass.sbx.commands.calls[-1]
    assert call["cmd"] == "echo hi"
    assert call["timeout"] == 30


async def test_shell_run_failure_raises(session):
    with pytest.raises(sandbox_mod.SandboxError):
        await session.shell_run("boom")


async def test_file_write_then_read(session):
    written = await session.file_write("/workspace/new.txt", "data-123")
    assert written == {"path": "/workspace/new.txt", "bytes_written": 8}
    read = await session.file_read("/workspace/new.txt")
    assert read == {"path": "/workspace/new.txt", "content": "data-123"}


async def test_file_read_missing(session):
    read = await session.file_read("/workspace/nope.txt")
    assert read["path"] == "/workspace/nope.txt"
    assert "not found" in read["error"]


async def test_file_list(session):
    listing = await session.file_list("/workspace")
    assert listing["path"] == "/workspace"
    by_name = {e["name"]: e for e in listing["entries"]}
    assert by_name["a.txt"]["type"] == "file"
    assert by_name["a.txt"]["size"] == 5
    assert by_name["sub"]["type"] == "dir"


async def test_file_list_missing_dir(session):
    listing = await session.file_list("/workspace/nope")
    assert "no such dir" in listing["error"]


async def test_http_fetch(session):
    res = await session.http_fetch("https://example.com", timeout=10)
    assert res["url"] == "https://example.com"
    assert res["status"] == 200
    assert "<title>Hi</title>" in res["body"]


async def test_browser_snapshot_extracts_text(session):
    snap = await session.browser_snapshot("https://example.com")
    assert snap["url"] == "https://example.com"
    assert snap["title"] == "Hi"
    assert "Hello world" in snap["text"]
    assert "var x" not in snap["text"]  # script content stripped


async def test_destroy_kills_sandbox(session):
    await session.destroy()
    assert _FakeSandboxClass.sbx.killed is True
