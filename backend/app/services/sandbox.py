"""Pluggable sandbox providers.

A sandbox gives a bot a live computer: shell exec, file read/write, and HTTP.
Providers implement the SandboxProvider interface; sessions are created per
agent run and destroyed afterwards.

Built-in kinds:
  - local_docker: real Docker containers on the host (via docker-py). The API
    container needs /var/run/docker.sock mounted (see docker-compose.yml).
  - e2b / daytona / modal: stubs with a config schema and a clear
    "not configured" error so they can be plugged in later. See README for how
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


# ------------------------------------------------- stubs for future providers
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


class E2BProvider(_StubProvider):
    kind = "e2b"
    name = "E2B"
    description = "Cloud sandboxes via E2B (stub — plug in your E2B_API_KEY)."
    env_var = "E2B_API_KEY"
    setup_hint = "Set E2B_API_KEY and implement E2BProvider.create_session()."

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "E2B API key (or E2B_API_KEY env)."},
                "template": {"type": "string", "description": "E2B template ID."},
                "timeout": {"type": "integer", "default": 300},
            },
        }


class DaytonaProvider(_StubProvider):
    kind = "daytona"
    name = "Daytona"
    description = "Cloud sandboxes via Daytona (stub — plug in your DAYTONA_API_KEY)."
    env_var = "DAYTONA_API_KEY"
    setup_hint = "Set DAYTONA_API_KEY and implement DaytonaProvider.create_session()."

    def config_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Daytona API key (or DAYTONA_API_KEY env)."},
                "snapshot": {"type": "string", "description": "Daytona snapshot/image."},
            },
        }


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
