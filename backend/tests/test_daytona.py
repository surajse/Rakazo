"""Tests for the Daytona sandbox provider.

The daytona SDK is fully mocked (a fake module is injected into sys.modules),
so these tests never make live API calls. They verify config handling, SDK
call shapes, and result mapping against the daytona 0.218.x API:

  - Daytona(DaytonaConfig(api_key=...)) creates the client
  - client.create(params, timeout=...) -> Sandbox
    (params is CreateSandboxFromSnapshotParams(snapshot=...) when a snapshot
    is configured, else None)
  - sandbox.process.exec(command, timeout=...) -> ExecuteResponse
    (exit_code, result, artifacts; result is the combined output stream)
  - sandbox.fs.upload_file(src=..., dst=...) / download_file(path) /
    list_files(path) / create_folder(path, mode)
  - sandbox.delete() removes the sandbox
"""
from __future__ import annotations

import json
import sys
import types

import pytest

from app.services import sandbox as sandbox_mod
from app.services.sandbox import (
    DaytonaProvider,
    DaytonaSession,
    SandboxNotConfigured,
    get_provider,
)


# ----------------------------------------------------------------- fakes
class _FakeExecResult:
    def __init__(self, result="", exit_code=0):
        self.result = result
        self.exit_code = exit_code
        self.artifacts = None


class _FakeProcess:
    def __init__(self):
        self.calls: list[dict] = []

    def exec(self, command, timeout=None, **kwargs):
        self.calls.append({"command": command, "timeout": timeout})
        if "urlopen" in command:
            body = (
                "<html><head><title>Hi</title></head>"
                "<body><p>Hello world</p><script>var x = 1;</script></body></html>"
            )
            return _FakeExecResult(result=json.dumps({"status": 200, "body": body}))
        if command.startswith("boom"):
            raise RuntimeError("command exploded")
        return _FakeExecResult(result="ok-out", exit_code=0)


class _FakeFileInfo:
    def __init__(self, name, is_dir, size):
        self.name = name
        self.is_dir = is_dir
        self.size = size


class _FakeFs:
    def __init__(self):
        self.store = {"/workspace/a.txt": "hello"}
        self.reads: list[str] = []
        self.writes: list[tuple] = []
        self.lists: list[str] = []
        self.folders: list[tuple] = []

    def download_file(self, remote_path, timeout=None):
        self.reads.append(remote_path)
        if remote_path not in self.store:
            raise RuntimeError(f"file not found: {remote_path}")
        return self.store[remote_path].encode("utf-8")

    def upload_file(self, src=None, dst=None, timeout=None):
        self.writes.append((src, dst))
        self.store[dst] = src.decode("utf-8") if isinstance(src, bytes) else src

    def list_files(self, path, **kwargs):
        self.lists.append(path)
        if path != "/workspace":
            raise RuntimeError(f"no such dir: {path}")
        return [_FakeFileInfo("a.txt", False, 5), _FakeFileInfo("sub", True, 0)]

    def create_folder(self, path, mode, **kwargs):
        self.folders.append((path, mode))


class _FakeDaytonaSandbox:
    def __init__(self):
        self.process = _FakeProcess()
        self.fs = _FakeFs()
        self.deleted = False

    def delete(self, **kwargs):
        self.deleted = True


class _FakeDaytonaConfig:
    def __init__(self, api_key=None, **kwargs):
        self.api_key = api_key
        self.kwargs = kwargs


class _FakeSnapshotParams:
    def __init__(self, snapshot=None, **kwargs):
        self.snapshot = snapshot
        self.kwargs = kwargs


class _FakeDaytona:
    """Stands in for daytona.Daytona (client API of the real SDK)."""

    last_config: _FakeDaytonaConfig | None = None
    last_params: _FakeSnapshotParams | None = None
    last_timeout: float | None = None
    sbx: _FakeDaytonaSandbox | None = None
    raise_on_create: Exception | None = None

    def __init__(self, config=None):
        type(self).last_config = config

    def create(self, params=None, timeout=60, **kwargs):
        type(self).last_params = params
        type(self).last_timeout = timeout
        if type(self).raise_on_create is not None:
            raise type(self).raise_on_create
        type(self).sbx = _FakeDaytonaSandbox()
        return type(self).sbx


@pytest.fixture()
def fake_daytona(monkeypatch):
    _FakeDaytona.last_config = None
    _FakeDaytona.last_params = None
    _FakeDaytona.last_timeout = None
    _FakeDaytona.sbx = None
    _FakeDaytona.raise_on_create = None
    mod = types.ModuleType("daytona")
    mod.Daytona = _FakeDaytona
    mod.DaytonaConfig = _FakeDaytonaConfig
    mod.CreateSandboxFromSnapshotParams = _FakeSnapshotParams
    monkeypatch.setitem(sys.modules, "daytona", mod)
    monkeypatch.delenv("DAYTONA_API_KEY", raising=False)
    return mod


@pytest.fixture()
async def session(fake_daytona):  # noqa: ARG001
    return await DaytonaProvider().create_session({"api_key": "test-key"})


# ----------------------------------------------------------------- provider
def test_daytona_registered():
    provider = get_provider("daytona")
    assert isinstance(provider, DaytonaProvider)
    assert provider.kind == "daytona"
    schema = provider.config_schema()
    assert {"api_key", "snapshot", "timeout"} <= set(schema["properties"])
    assert schema["properties"]["timeout"]["default"] == 300


async def test_missing_api_key_raises(fake_daytona):  # noqa: ARG001
    with pytest.raises(SandboxNotConfigured, match="API key"):
        await DaytonaProvider().create_session({})


async def test_create_session_passes_config(fake_daytona):  # noqa: ARG001
    sess = await DaytonaProvider().create_session(
        {"api_key": "k", "snapshot": "snap-x", "timeout": 600}
    )
    assert isinstance(sess, DaytonaSession)
    assert _FakeDaytona.last_config.api_key == "k"
    assert isinstance(_FakeDaytona.last_params, _FakeSnapshotParams)
    assert _FakeDaytona.last_params.snapshot == "snap-x"
    assert _FakeDaytona.last_timeout == 600


async def test_create_session_defaults(fake_daytona):  # noqa: ARG001
    await DaytonaProvider().create_session({"api_key": "k"})
    # No snapshot configured -> default sandbox params (None).
    assert _FakeDaytona.last_params is None
    assert _FakeDaytona.last_timeout == 300


async def test_create_session_reads_key_from_env(fake_daytona, monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "env-key")
    await DaytonaProvider().create_session({})
    assert _FakeDaytona.last_config.api_key == "env-key"


async def test_create_failure_raises_not_configured(fake_daytona):  # noqa: ARG001
    _FakeDaytona.raise_on_create = RuntimeError("denied")
    with pytest.raises(SandboxNotConfigured, match="creation failed"):
        await DaytonaProvider().create_session({"api_key": "k"})


def test_is_configured_without_key(fake_daytona):  # noqa: ARG001
    assert DaytonaProvider().is_configured() is False


def test_is_configured_with_env_key(fake_daytona, monkeypatch):
    monkeypatch.setenv("DAYTONA_API_KEY", "env-key")
    assert DaytonaProvider().is_configured() is True


# ----------------------------------------------------------------- session
async def test_shell_run(session):
    out = await session.shell_run("echo hi", timeout=30)
    # Daytona merges output into a single stream; stderr is always "".
    assert out == {"exit_code": 0, "stdout": "ok-out", "stderr": ""}
    call = _FakeDaytona.sbx.process.calls[-1]
    assert call["command"] == "echo hi"
    assert call["timeout"] == 30


async def test_shell_run_failure_raises(session):
    with pytest.raises(sandbox_mod.SandboxError):
        await session.shell_run("boom")


async def test_file_write_then_read(session):
    written = await session.file_write("/workspace/new.txt", "data-123")
    assert written == {"path": "/workspace/new.txt", "bytes_written": 8}
    read = await session.file_read("/workspace/new.txt")
    assert read == {"path": "/workspace/new.txt", "content": "data-123"}


async def test_file_write_creates_parent_dir(session):
    await session.file_write("/workspace/nested/deep.txt", "x")
    assert ("/workspace/nested", "0755") in _FakeDaytona.sbx.fs.folders
    assert _FakeDaytona.sbx.fs.writes[-1][1] == "/workspace/nested/deep.txt"


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


async def test_destroy_deletes_sandbox(session):
    await session.destroy()
    assert _FakeDaytona.sbx.deleted is True
