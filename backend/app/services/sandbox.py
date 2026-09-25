"""Pluggable sandbox providers.

A sandbox gives a bot a live computer: shell exec, file read/write, and HTTP.
Providers implement the SandboxProvider interface; sessions are created per
agent run and destroyed afterwards.

Built-in kinds:
  - local_docker: real Docker containers on the host (via docker-py). The API
    container needs /var/run/docker.sock mounted (see docker-compose.yml).
  - e2b: real cloud sandboxes via the E2B SDK (needs E2B_API_KEY or
    api_key in the provider config).
  - daytona: real cloud sandboxes via the Daytona SDK (needs DAYTONA_API_KEY or
    api_key in the provider config).
  - modal: stub with a config schema and a clear
    "not configured" error so it can be plugged in later. See README for how
    to add a provider.
"""
from __future__ import annotations

import asyncio
import base64
import html as html_module
import json
import os
from abc import ABC, abstractmethod
from html.parser import HTMLParser
from typing import Any


class SandboxError(RuntimeError):
    pass


class SandboxNotConfigured(SandboxError):
    pass


# ------------------------------------------------------------------ interface
class SandboxSession(ABC):
    """A live, isolated machine for one agent run."""

    @abstractmethod
    async def shell_run(self, command: str, timeout: int = 120) -> dict[str, Any]:
        """Run a shell command. Returns {exit_code, stdout, stderr}."""

    @abstractmethod
    async def file_read(self, path: str) -> dict[str, Any]:
        """Read a file. Returns {path, content} or {error}."""

    @abstractmethod
    async def file_write(self, path: str, content: str) -> dict[str, Any]:
        """Write a file (creates parent dirs). Returns {path, bytes_written}."""

    @abstractmethod
    async def file_list(self, path: str = "/workspace") -> dict[str, Any]:
        """List a directory. Returns {path, entries: [{name, type, size}]}."""

    @abstractmethod
    async def http_fetch(self, url: str, timeout: int = 30) -> dict[str, Any]:
        """Fetch a URL. Returns {url, status, body} (body truncated)."""

    @abstractmethod
    async def browser_snapshot(self, url: str) -> dict[str, Any]:
        """Best-effort rendered-page text snapshot. Returns {url, title, text}."""

    @abstractmethod
    async def destroy(self) -> None:
        """Tear down the session."""


class SandboxProvider(ABC):
    kind: str = ""
    name: str = ""
    description: str = ""

    @abstractmethod
    def config_schema(self) -> dict[str, Any]:
        """JSON-schema-ish description of the provider config."""

    @abstractmethod
    def is_configured(self) -> bool:
        """Whether this provider can actually create sessions right now."""

    @abstractmethod
    async def create_session(self, config: dict[str, Any]) -> SandboxSession:
        """Create an isolated session. Raises SandboxNotConfigured if unavailable."""


# ------------------------------------------------------------- local_docker
class LocalDockerSession(SandboxSession):
    def __init__(self, container: Any, client: Any):
        self._container = container
        self._client = client

    async def _exec(self, cmd: list[str] | str, timeout: int = 120) -> tuple[int, str, str]:
        def _run() -> tuple[int, str, str]:
            result = self._container.exec_run(cmd, demux=True, workdir="/workspace")
            out, err = result.output if isinstance(result.output, tuple) else (result.output, b"")
            return (
                result.exit_code,
                (out or b"").decode("utf-8", errors="replace"),
                (err or b"").decode("utf-8", errors="replace"),
            )

        return await asyncio.to_thread(_run)

    async def shell_run(self, command: str, timeout: int = 120) -> dict[str, Any]:
        code, out, err = await self._exec(["sh", "-c", command], timeout=timeout)
        return {"exit_code": code, "stdout": out[-20000:], "stderr": err[-20000:]}

    async def file_read(self, path: str) -> dict[str, Any]:
        code, out, err = await self._exec(["sh", "-c", f"base64 -w0 -- {sh_quote(path)}"])
        if code != 0:
            return {"path": path, "error": (err or out).strip() or "read failed"}
        try:
            content = base64.b64decode(out).decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": f"decode failed: {exc}"}
        return {"path": path, "content": content[:100000]}

    async def file_write(self, path: str, content: str) -> dict[str, Any]:
        b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
        # Write base64 in chunks to a temp file, then decode to the target path.
        await self._exec(
            ["sh", "-c", f"mkdir -p -- {sh_quote(os.path.dirname(path) or '/workspace')}"]
        )
        await self._exec(["sh", "-c", ": > /tmp/.rakazo_write.b64"])
        for i in range(0, len(b64), 6000):
            chunk = b64[i : i + 6000]
            code, _, err = await self._exec(
                ["sh", "-c", f"printf '%s' '{chunk}' >> /tmp/.rakazo_write.b64"]
            )
            if code != 0:
                return {"path": path, "error": f"write failed: {err.strip()}"}
        code, _, err = await self._exec(
            ["sh", "-c", f"base64 -d /tmp/.rakazo_write.b64 > {sh_quote(path)}"]
        )
        await self._exec(["sh", "-c", "rm -f /tmp/.rakazo_write.b64"])
        if code != 0:
            return {"path": path, "error": f"write failed: {err.strip()}"}
        return {"path": path, "bytes_written": len(content.encode("utf-8"))}

    async def file_list(self, path: str = "/workspace") -> dict[str, Any]:
        script = (
            "import json, os;"
            f"p={path!r};"
            "print(json.dumps([{'name': e, 'type': 'dir' if os.path.isdir(os.path.join(p, e)) else 'file',"
            " 'size': os.path.getsize(os.path.join(p, e)) if os.path.isfile(os.path.join(p, e)) else None}"
            " for e in sorted(os.listdir(p))]))"
        )
        code, out, err = await self._exec(["python3", "-c", script])
        if code != 0:
            return {"path": path, "error": (err or out).strip() or "list failed"}
        try:
            entries = json.loads(out)
        except json.JSONDecodeError:
            return {"path": path, "error": "could not parse listing"}
        return {"path": path, "entries": entries}

    async def http_fetch(self, url: str, timeout: int = 30) -> dict[str, Any]:
        script = (
            "import json, urllib.request;"
            f"req = urllib.request.Request({url!r}, headers={{'User-Agent': 'Rakazo/1.0'}});"
            f"resp = urllib.request.urlopen(req, timeout={int(timeout)});"
            "body = resp.read(60000).decode('utf-8', errors='replace');"
            "print(json.dumps({'status': resp.status, 'body': body}))"
        )
        code, out, err = await self._exec(["python3", "-c", script], timeout=timeout + 10)
        if code != 0:
            return {"url": url, "error": (err or out).strip()[-2000:] or "fetch failed"}
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return {"url": url, "error": "could not parse response"}
        data["url"] = url
        return data

    async def browser_snapshot(self, url: str) -> dict[str, Any]:
        """Best-effort snapshot: fetch the page and extract readable text.

        This is NOT a real browser render (no JS execution). For full
        rendering, point the bot at a browser-automation sidecar and extend
        this method — see README.
        """
        fetched = await self.http_fetch(url)
        if "error" in fetched:
            return {"url": url, "error": fetched["error"]}
        text = _html_to_text(fetched.get("body", ""))
        title = _extract_title(fetched.get("body", ""))
        return {"url": url, "title": title, "text": text[:30000]}

    async def destroy(self) -> None:
        def _rm() -> None:
            try:
                self._container.remove(force=True)
            except Exception:  # noqa: BLE001
                pass

        await asyncio.to_thread(_rm)


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style", "noscript"):
            self._skip += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip:
            text = data.strip()
            if text:
                self.parts.append(text)


def _html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = " ".join(parser.parts)
    return html_module.unescape(" ".join(text.split()))


def _extract_title(html: str) -> str | None:
    import re

    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return html_module.unescape(m.group(1).strip()) if m else None


async def _remote_http_fetch(
    shell_run: Any, url: str, timeout: int = 30
) -> dict[str, Any]:
    """Fetch a URL from inside a remote cloud sandbox via python3 + urllib.

    Shared by the cloud providers (e2b, daytona): runs a small python3
    one-liner in the remote sandbox through the given shell_run callable
    (an async ``(command, timeout=...) -> {exit_code, stdout, stderr}``).
    Returns {url, status, body} (body truncated).
    """
    script = (
        "import json, urllib.request;"
        f"req = urllib.request.Request({url!r}, headers={{'User-Agent': 'Rakazo/1.0'}});"
        f"resp = urllib.request.urlopen(req, timeout={int(timeout)});"
        "body = resp.read(60000).decode('utf-8', errors='replace');"
        "print(json.dumps({'status': resp.status, 'body': body}))"
    )
    result = await shell_run(f"python3 -c {sh_quote(script)}", timeout=timeout + 10)
    if result["exit_code"] != 0:
        err = (result.get("stderr") or result.get("stdout") or "").strip()
        return {"url": url, "error": err[-2000:] or "fetch failed"}
    try:
        data = json.loads(result["stdout"])
    except json.JSONDecodeError:
        return {"url": url, "error": "could not parse response"}
    data["url"] = url
    return data


async def _remote_browser_snapshot(http_fetch: Any, url: str) -> dict[str, Any]:
    """Best-effort rendered-page text snapshot via the given http_fetch callable.

    This is NOT a real browser render (no JS execution) — same limitation as
    the local_docker provider.
    """
    fetched = await http_fetch(url)
    if "error" in fetched:
        return {"url": url, "error": fetched["error"]}
    text = _html_to_text(fetched.get("body", ""))
    title = _extract_title(fetched.get("body", ""))
    return {"url": url, "title": title, "text": text[:30000]}


class LocalDockerProvider(SandboxProvider):
    kind = "local_docker"
    name = "Local Docker"
    description = (
        "Spawns a real Docker container per bot session on this host "
        "(python:3.12-slim with common tools). Requires /var/run/docker.sock."
    )

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "image": {
                    "type": "string",
                    "default": "python:3.12-slim",
                    "description": "Docker image for the sandbox container.",
                },
                "memory_limit": {
                    "type": "string",
                    "default": "1g",
                    "description": "Container memory limit (e.g. '512m', '2g').",
                },
            },
        }

    def is_configured(self) -> bool:
        try:
            import docker

            docker.from_env().ping()
            return True
        except Exception:  # noqa: BLE001
            return False

    async def create_session(self, config: dict[str, Any]) -> SandboxSession:
        import docker

        image = (config or {}).get("image") or "python:3.12-slim"
        mem_limit = (config or {}).get("memory_limit") or "1g"

        def _create() -> tuple[Any, Any]:
            client = docker.from_env()
            try:
                client.images.pull(image)
            except Exception:  # noqa: BLE001
                pass  # image may already exist locally
            container = client.containers.run(
                image,
                command=["sleep", "infinity"],
                detach=True,
                tty=True,
                stdin_open=True,
                working_dir="/workspace",
                mem_limit=mem_limit,
                labels={"rakazo": "sandbox"},
                name=f"rakazo-{os.getpid()}-{id(self) % 100000}",
            )
            # Ensure common tools exist.
            container.exec_run(
                ["sh", "-c", "command -v curl >/dev/null || (apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 || true)"],
                demux=True,
            )
            return client, container

        try:
            client, container = await asyncio.to_thread(_create)
        except Exception as exc:  # noqa: BLE001
            raise SandboxNotConfigured(f"local_docker unavailable: {exc}") from exc
        return LocalDockerSession(container, client)


# ------------------------------------------------------------------ e2b
class E2BSession(SandboxSession):
    """SandboxSession backed by a real E2B cloud sandbox.

    The e2b SDK is synchronous, so every SDK call runs in a worker thread.
    """

    def __init__(self, sandbox: Any):
        self._sandbox = sandbox

    async def shell_run(self, command: str, timeout: int = 120) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(
                self._sandbox.commands.run, command, timeout=timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise SandboxError(f"e2b shell_run failed: {exc}") from exc
        return {
            "exit_code": result.exit_code,
            "stdout": (result.stdout or "")[-20000:],
            "stderr": (result.stderr or "")[-20000:],
        }

    async def file_read(self, path: str) -> dict[str, Any]:
        try:
            content = await asyncio.to_thread(self._sandbox.files.read, path)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "read failed"}
        return {"path": path, "content": str(content)[:100000]}

    async def file_write(self, path: str, content: str) -> dict[str, Any]:
        try:
            # files.write creates parent dirs automatically.
            await asyncio.to_thread(self._sandbox.files.write, path, content)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "write failed"}
        return {"path": path, "bytes_written": len(content.encode("utf-8"))}

    async def file_list(self, path: str = "/workspace") -> dict[str, Any]:
        try:
            entries = await asyncio.to_thread(self._sandbox.files.list, path)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "list failed"}
        out = []
        for entry in entries or []:
            ftype = getattr(entry.type, "value", None)
            out.append(
                {
                    "name": entry.name,
                    "type": "dir" if ftype == "dir" else "file",
                    "size": getattr(entry, "size", None),
                }
            )
        return {"path": path, "entries": out}

    async def http_fetch(self, url: str, timeout: int = 30) -> dict[str, Any]:
        return await _remote_http_fetch(self.shell_run, url, timeout=timeout)

    async def browser_snapshot(self, url: str) -> dict[str, Any]:
        return await _remote_browser_snapshot(self.http_fetch, url)

    async def destroy(self) -> None:
        def _kill() -> None:
            try:
                self._sandbox.kill()
            except Exception:  # noqa: BLE001
                pass  # already gone or unreachable; nothing to do

        await asyncio.to_thread(_kill)


class E2BProvider(SandboxProvider):
    kind = "e2b"
    name = "E2B"
    description = (
        "Cloud sandboxes via E2B (needs E2B_API_KEY env var or api_key in config)."
    )
    env_var = "E2B_API_KEY"
    setup_hint = "Set the E2B_API_KEY env var or pass api_key in the provider config."

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "E2B API key (or E2B_API_KEY env)."},
                "template": {"type": "string", "description": "E2B template ID."},
                "timeout": {"type": "integer", "default": 300},
            },
        }

    def _api_key(self, config: dict[str, Any] | None) -> str | None:
        return (config or {}).get("api_key") or os.environ.get("E2B_API_KEY")

    def is_configured(self) -> bool:
        try:
            import e2b  # noqa: F401
        except ImportError:
            return False
        return bool(self._api_key(None))

    async def create_session(self, config: dict[str, Any]) -> SandboxSession:
        try:
            from e2b import Sandbox
        except ImportError as exc:
            raise SandboxNotConfigured(
                "The 'e2b' provider needs the e2b package (pip install e2b). "
                "See README ('Adding a sandbox provider')."
            ) from exc
        api_key = self._api_key(config)
        if not api_key:
            raise SandboxNotConfigured(
                "E2B API key missing: set the E2B_API_KEY env var or pass "
                "'api_key' in the provider config."
            )
        template = (config or {}).get("template")
        timeout = (config or {}).get("timeout") or 300
        try:
            sandbox = await asyncio.to_thread(
                Sandbox.create, template=template, timeout=timeout, api_key=api_key
            )
        except Exception as exc:  # noqa: BLE001
            raise SandboxNotConfigured(f"e2b sandbox creation failed: {exc}") from exc
        return E2BSession(sandbox)


# ------------------------------------------------------------------ daytona
class DaytonaSession(SandboxSession):
    """SandboxSession backed by a real Daytona cloud sandbox.

    The daytona SDK is synchronous, so every SDK call runs in a worker thread.

    Note: Daytona's ExecuteResponse exposes a single combined output stream
    (``result``) rather than separate stdout/stderr streams, so the ``stderr``
    field in shell_run results is always "".
    """

    def __init__(self, sandbox: Any):
        self._sandbox = sandbox

    async def shell_run(self, command: str, timeout: int = 120) -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(
                self._sandbox.process.exec, command, timeout=timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise SandboxError(f"daytona shell_run failed: {exc}") from exc
        return {
            "exit_code": result.exit_code,
            "stdout": (result.result or "")[-20000:],
            "stderr": "",
        }

    async def file_read(self, path: str) -> dict[str, Any]:
        try:
            content = await asyncio.to_thread(self._sandbox.fs.download_file, path)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "read failed"}
        if content is None:
            return {"path": path, "error": "file not found or empty"}
        return {"path": path, "content": content.decode("utf-8", errors="replace")[:100000]}

    async def file_write(self, path: str, content: str) -> dict[str, Any]:
        def _write() -> None:
            parent = os.path.dirname(path)
            if parent:
                try:
                    self._sandbox.fs.create_folder(parent, "0755")
                except Exception:  # noqa: BLE001
                    pass  # folder already exists or the daemon creates it
            self._sandbox.fs.upload_file(src=content.encode("utf-8"), dst=path)

        try:
            await asyncio.to_thread(_write)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "write failed"}
        return {"path": path, "bytes_written": len(content.encode("utf-8"))}

    async def file_list(self, path: str = "/workspace") -> dict[str, Any]:
        try:
            infos = await asyncio.to_thread(self._sandbox.fs.list_files, path)
        except Exception as exc:  # noqa: BLE001
            return {"path": path, "error": str(exc)[:2000] or "list failed"}
        out = []
        for info in infos or []:
            out.append(
                {
                    "name": info.name,
                    "type": "dir" if getattr(info, "is_dir", False) else "file",
                    "size": getattr(info, "size", None),
                }
            )
        return {"path": path, "entries": out}

    async def http_fetch(self, url: str, timeout: int = 30) -> dict[str, Any]:
        return await _remote_http_fetch(self.shell_run, url, timeout=timeout)

    async def browser_snapshot(self, url: str) -> dict[str, Any]:
        return await _remote_browser_snapshot(self.http_fetch, url)

    async def destroy(self) -> None:
        def _delete() -> None:
            try:
                self._sandbox.delete()
            except Exception:  # noqa: BLE001
                pass  # already gone or unreachable; nothing to do

        await asyncio.to_thread(_delete)


class DaytonaProvider(SandboxProvider):
    kind = "daytona"
    name = "Daytona"
    description = (
        "Cloud sandboxes via Daytona (needs DAYTONA_API_KEY env var or api_key in config)."
    )
    env_var = "DAYTONA_API_KEY"
    setup_hint = "Set the DAYTONA_API_KEY env var or pass api_key in the provider config."

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Daytona API key (or DAYTONA_API_KEY env)."},
                "snapshot": {
                    "type": "string",
                    "description": "Daytona snapshot to boot the sandbox from (maps to CreateSandboxFromSnapshotParams.snapshot).",
                },
                "timeout": {"type": "integer", "default": 300},
            },
        }

    def _api_key(self, config: dict[str, Any] | None) -> str | None:
        return (config or {}).get("api_key") or os.environ.get("DAYTONA_API_KEY")

    def is_configured(self) -> bool:
        try:
            import daytona  # noqa: F401
        except ImportError:
            return False
        return bool(self._api_key(None))

    async def create_session(self, config: dict[str, Any]) -> SandboxSession:
        try:
            from daytona import (
                CreateSandboxFromSnapshotParams,
                Daytona,
                DaytonaConfig,
            )
        except ImportError as exc:
            raise SandboxNotConfigured(
                "The 'daytona' provider needs the daytona package (pip install daytona). "
                "See README ('Adding a sandbox provider')."
            ) from exc
        api_key = self._api_key(config)
        if not api_key:
            raise SandboxNotConfigured(
                "Daytona API key missing: set the DAYTONA_API_KEY env var or pass "
                "'api_key' in the provider config."
            )
        snapshot = (config or {}).get("snapshot")
        timeout = (config or {}).get("timeout") or 300
        params = (
            CreateSandboxFromSnapshotParams(snapshot=snapshot) if snapshot else None
        )

        def _create() -> Any:
            client = Daytona(DaytonaConfig(api_key=api_key))
            return client.create(params, timeout=timeout)

        try:
            sandbox = await asyncio.to_thread(_create)
        except Exception as exc:  # noqa: BLE001
            raise SandboxNotConfigured(f"daytona sandbox creation failed: {exc}") from exc
        return DaytonaSession(sandbox)


# ------------------------------------------------- stub for future providers
class _StubProvider(SandboxProvider):
    env_var: str = ""
    setup_hint: str = ""

    def is_configured(self) -> bool:
        return False

    async def create_session(self, config: dict[str, Any]) -> SandboxSession:
        raise SandboxNotConfigured(
            f"The '{self.kind}' sandbox provider is not implemented in this build. "
            f"{self.setup_hint} See README ('Adding a sandbox provider') to plug it in."
        )


class ModalProvider(_StubProvider):
    kind = "modal"
    name = "Modal"
    description = "Ephemeral sandboxes via Modal (stub — plug in your Modal credentials)."
    env_var = "MODAL_TOKEN_ID"
    setup_hint = "Set MODAL_TOKEN_ID/MODAL_TOKEN_SECRET and implement ModalProvider.create_session()."

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "token_id": {"type": "string", "description": "Modal token ID."},
                "token_secret": {"type": "string", "description": "Modal token secret."},
                "image": {"type": "string", "description": "Modal image reference."},
            },
        }


REGISTRY: dict[str, SandboxProvider] = {
    "local_docker": LocalDockerProvider(),
    "e2b": E2BProvider(),
    "daytona": DaytonaProvider(),
    "modal": ModalProvider(),
}


def get_provider(kind: str) -> SandboxProvider:
    provider = REGISTRY.get(kind)
    if provider is None:
        raise SandboxError(f"Unknown sandbox kind: {kind!r}")
    return provider


def kind_infos() -> list[dict[str, Any]]:
    return [
        {
            "kind": p.kind,
            "name": p.name,
            "description": p.description,
            "configured": p.is_configured(),
            "config_schema": p.config_schema(),
        }
        for p in REGISTRY.values()
    ]
