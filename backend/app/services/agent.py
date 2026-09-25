"""The agent loop: ReAct turns with tool execution, approvals, and streaming.

On each user message the bot runs a bounded ReAct loop against its configured
model provider, executing tools inside its sandbox session. Destructive or
privileged actions pause the turn and wait for user approval via the approvals
API. Token/tool events stream over SSE through the per-run event bus.
"""
from __future__ import annotations

import asyncio
import os
import re
import shlex
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import (
    Approval,
    Bot,
    BotTemplate,
    MemoryItem,
    Message,
    ModelProvider,
    Run,
    Sandbox as SandboxRow,
    SeenHost,
    Thread,
)
from app.services import model_clients, runs, sandbox as sandbox_mod
from app.services.audit import log_audit
from app.services.model_clients import ProviderConfig
from app.services.sandbox import SandboxError, SandboxSession
from app.security import decrypt_secret


# ---------------------------------------------------------------- tool schemas
def _fn(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


AGENT_TOOLS: list[dict] = [
    _fn(
        "shell_run",
        "Run a shell command inside the bot's sandbox computer (working dir /workspace). "
        "Installing packages, deleting files outside /workspace, or risky commands need user approval.",
        {"command": {"type": "string"}, "timeout": {"type": "integer", "default": 120}},
        ["command"],
    ),
    _fn(
        "file_read",
        "Read a text file from the sandbox.",
        {"path": {"type": "string"}},
        ["path"],
    ),
    _fn(
        "file_write",
        "Write a text file in the sandbox (parent dirs are created). Writing outside /workspace needs approval.",
        {"path": {"type": "string"}, "content": {"type": "string"}},
        ["path", "content"],
    ),
    _fn(
        "file_list",
        "List a directory in the sandbox.",
        {"path": {"type": "string", "default": "/workspace"}},
        [],
    ),
    _fn(
        "http_fetch",
        "Fetch a URL from inside the sandbox. First contact with a new host needs user approval.",
        {"url": {"type": "string"}, "timeout": {"type": "integer", "default": 30}},
        ["url"],
    ),
    _fn(
        "browser_snapshot",
        "Best-effort text snapshot of a web page (no JS rendering).",
        {"url": {"type": "string"}},
        ["url"],
    ),
    _fn(
        "spawn_bot",
        "Spawn a child bot that works on a task independently (it gets its own thread and reports back via memory). "
        "The child inherits this bot's model provider and sandbox.",
        {
            "name": {"type": "string"},
            "task": {"type": "string", "description": "The task for the child bot, as a user message."},
            "template": {"type": "string", "description": "Optional template name for the child bot."},
        },
        ["name", "task"],
    ),
    _fn(
        "run_helper",
        "Run a short-lived helper sub-agent inside this turn for a focused subtask. "
        "It can use shell/files/http tools but cannot spawn bots or helpers. Returns its result as text.",
        {"task": {"type": "string"}},
        ["task"],
    ),
    _fn(
        "memory_set",
        "Store a long-term memory note (key/value) for this bot.",
        {"key": {"type": "string"}, "value": {"type": "string"}},
        ["key", "value"],
    ),
    _fn(
        "memory_get",
        "Read a long-term memory note.",
        {"key": {"type": "string"}},
        ["key"],
    ),
]

HELPER_TOOLS: list[dict] = [t for t in AGENT_TOOLS if t["function"]["name"] not in ("spawn_bot", "run_helper")]


# ------------------------------------------------------------- approval policy
INSTALL_RE = re.compile(
    r"(^|[;&|\n])\s*(sudo\s+)?(pip3?|uv|apt-get|apt|npm|yarn|pnpm|bun|brew|apk|cargo)\s+(install|add)\b"
)


def _is_outside_workspace(path: str) -> bool:
    p = path.strip().strip("'\"")
    if p.startswith("~"):
        return True
    if not p.startswith("/"):
        p = "/workspace/" + p
    norm = os.path.normpath(p)
    return not (norm == "/workspace" or norm.startswith("/workspace/"))


def _rm_targets(cmd: str) -> list[str] | None:
    """Return rm target paths, or None if the command can't be parsed safely."""
    try:
        tokens = shlex.split(cmd, posix=True)
    except ValueError:
        return None
    targets: list[str] = []
    i = 0
    while i < len(tokens):
        if tokens[i] == "rm":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-") and tokens[i] != "-":
                i += 1
            while i < len(tokens) and tokens[i] not in (";", "&&", "||", "|"):
                targets.append(tokens[i])
                i += 1
        else:
            i += 1
    return targets


def shell_needs_approval(command: str) -> tuple[str, str] | None:
    """Return (kind, description) if the shell command needs approval."""
    if INSTALL_RE.search(command):
        return ("install", f"Package installation detected: {command[:200]}")
    if re.search(r"\brm\b", command):
        targets = _rm_targets(command)
        if targets is None:
            return ("destructive_file", f"Unparseable rm command, needs review: {command[:200]}")
        outside = [t for t in targets if _is_outside_workspace(t)]
        if outside:
            return (
                "destructive_file",
                f"Deleting files outside /workspace: {', '.join(outside[:5])}",
            )
    return None


# ------------------------------------------------------------------ run context
@dataclass
class RunContext:
    db: AsyncSession
    session_factory: async_sessionmaker[AsyncSession]
    bot: Bot
    thread: Thread
    run: Run
    provider_cfg: ProviderConfig
    sandbox_session: SandboxSession
    depth: int = 0
    memory: dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------------ approvals
async def require_approval(
    ctx: RunContext, kind: str, description: str, payload: dict[str, Any]
) -> bool:
    """Create an approval, pause the turn, and wait for approve/deny/timeout."""
    approval = Approval(
        user_id=ctx.bot.user_id,
        bot_id=ctx.bot.id,
        run_id=ctx.run.id,
        kind=kind,
        description=description,
        payload=payload,
    )
    ctx.db.add(approval)
    await ctx.db.flush()

    await log_audit(
        ctx.db, ctx.bot.user_id, ctx.bot.id, "approval.requested",
        {"approval_id": approval.id, "kind": kind, "description": description},
    )
    await ctx.db.commit()

    await runs.emit(
        ctx.run.id,
        "approval_request",
        {
            "id": approval.id,
            "kind": kind,
            "description": description,
            "payload": payload,
        },
    )
    await _set_run_status(ctx, "awaiting_approval")

    waiter = asyncio.Event()
    runs.approval_events[approval.id] = waiter
    try:
        await asyncio.wait_for(waiter.wait(), timeout=settings.approval_timeout_seconds)
        approved = runs.approval_outcomes.pop(approval.id, False)
    except asyncio.TimeoutError:
        approved = False
        approval.status = "denied"
        approval.reason = "Approval timed out"
        approval.resolved_at = datetime.now(timezone.utc)
        await ctx.db.commit()
        await log_audit(
            ctx.db, ctx.bot.user_id, ctx.bot.id, "approval.timeout", {"approval_id": approval.id}
        )
        await ctx.db.commit()
    finally:
        runs.approval_events.pop(approval.id, None)

    await _set_run_status(ctx, "running")
    return approved


async def _set_run_status(ctx: RunContext, status: str) -> None:
    ctx.run.status = status
    await ctx.db.commit()


# ------------------------------------------------------------------ tool impls
async def _seen_hosts(ctx: RunContext) -> set[str]:
    rows = (await ctx.db.execute(select(SeenHost.host).where(SeenHost.bot_id == ctx.bot.id))).all()
    return {r[0] for r in rows}


async def execute_tool(ctx: RunContext, name: str, args: dict[str, Any]) -> str:
    """Execute one tool call. Returns a string result for the model."""
    session = ctx.sandbox_session
    try:
        if name == "shell_run":
            command = str(args.get("command", ""))
            timeout = int(args.get("timeout") or 120)
            policy = shell_needs_approval(command)
            if policy:
                kind, desc = policy
                ok = await require_approval(ctx, kind, desc, {"command": command})
                if not ok:
                    return "Action denied by user: " + desc
            result = await session.shell_run(command, timeout=timeout)
            return _truncate(_fmt_shell(result))

        if name == "file_read":
            result = await session.file_read(str(args.get("path", "")))
            return _truncate(_fmt_file_read(result))

        if name == "file_write":
            path = str(args.get("path", ""))
            if _is_outside_workspace(path):
                ok = await require_approval(
                    ctx, "destructive_file", f"Write outside /workspace: {path}", {"path": path}
                )
                if not ok:
                    return f"Action denied by user: writing outside /workspace ({path})"
            result = await session.file_write(path, str(args.get("content", "")))
            return _truncate(str(result))

        if name == "file_list":
            result = await session.file_list(str(args.get("path") or "/workspace"))
            return _truncate(str(result))

        if name == "http_fetch":
            url = str(args.get("url", ""))
            host = (urlparse(url).hostname or "").lower()
            if host and host not in await _seen_hosts(ctx):
                ok = await require_approval(
                    ctx, "network", f"Network egress to new host: {host}", {"url": url, "host": host}
                )
                if not ok:
                    return f"Action denied by user: network egress to {host}"
                ctx.db.add(SeenHost(bot_id=ctx.bot.id, host=host))
                await ctx.db.commit()
            result = await session.http_fetch(url, timeout=int(args.get("timeout") or 30))
            return _truncate(str(result))

        if name == "browser_snapshot":
            result = await session.browser_snapshot(str(args.get("url", "")))
            return _truncate(str(result))

        if name == "spawn_bot":
            return await _tool_spawn_bot(ctx, args)

        if name == "run_helper":
            if ctx.depth >= 1:
                return "Helpers cannot spawn nested helpers."
            return await _tool_run_helper(ctx, str(args.get("task", "")))

        if name == "memory_set":
            key, value = str(args.get("key", "")), str(args.get("value", ""))
            await _memory_set(ctx.db, ctx.bot.id, key, value)
            ctx.memory[key] = value
            await ctx.db.commit()
            await log_audit(ctx.db, ctx.bot.user_id, ctx.bot.id, "memory.set", {"key": key})
            await ctx.db.commit()
            return f"Memory saved: {key}"

        if name == "memory_get":
            key = str(args.get("key", ""))
            item = (
                await ctx.db.execute(
                    select(MemoryItem).where(MemoryItem.bot_id == ctx.bot.id, MemoryItem.key == key)
                )
            ).scalar_one_or_none()
            return item.value if item else f"No memory stored for key: {key}"

        return f"Unknown tool: {name}"
    except SandboxError as exc:
        return f"Sandbox error: {exc}"
    except Exception as exc:  # noqa: BLE001
        return f"Tool error: {exc}"


def _truncate(text: str, limit: int | None = None) -> str:
    limit = limit or settings.max_tool_result_chars
    if len(text) > limit:
        return text[:limit] + f"\n…(truncated, {len(text) - limit} more chars)"
    return text


def _fmt_shell(result: dict[str, Any]) -> str:
    out = f"exit_code={result.get('exit_code')}\n"
    if result.get("stdout"):
        out += f"--- stdout ---\n{result['stdout']}\n"
    if result.get("stderr"):
        out += f"--- stderr ---\n{result['stderr']}"
    return out.strip() or "(no output)"


def _fmt_file_read(result: dict[str, Any]) -> str:
    if "error" in result:
        return f"Error: {result['error']}"
    return result.get("content", "")


async def _memory_set(db: AsyncSession, bot_id: str, key: str, value: str) -> None:
    item = (
        await db.execute(
            select(MemoryItem).where(MemoryItem.bot_id == bot_id, MemoryItem.key == key)
        )
    ).scalar_one_or_none()
    if item is None:
        db.add(MemoryItem(bot_id=bot_id, key=key, value=value))
    else:
        item.value = value
        item.updated_at = datetime.now(timezone.utc)


async def _tool_spawn_bot(ctx: RunContext, args: dict[str, Any]) -> str:
    name = str(args.get("name", "child-bot"))[:200]
    task = str(args.get("task", ""))
    template_name = args.get("template")

    system_prompt = "You are a focused helper bot. Complete the task given to you, then summarize what you did."
    routines_md = ""
    if template_name:
        tpl = (
            await ctx.db.execute(select(BotTemplate).where(BotTemplate.name == template_name))
        ).scalar_one_or_none()
        if tpl:
            system_prompt, routines_md = tpl.system_prompt, tpl.routines_md

    child = Bot(
        user_id=ctx.bot.user_id,
        name=name,
        template=template_name if isinstance(template_name, str) else None,
        model_provider_id=ctx.bot.model_provider_id,
        sandbox_id=ctx.bot.sandbox_id,
        system_prompt=system_prompt,
        routines_md=routines_md,
        parent_bot_id=ctx.bot.id,
    )
    ctx.db.add(child)
    await ctx.db.flush()
    thread = Thread(bot_id=child.id)
    ctx.db.add(thread)
    await ctx.db.flush()
    user_msg = Message(thread_id=thread.id, role="user", content=task)
    ctx.db.add(user_msg)
    await ctx.db.flush()
    run = Run(bot_id=child.id, thread_id=thread.id)
    ctx.db.add(run)
    await ctx.db.flush()

    await log_audit(
        ctx.db, ctx.bot.user_id, ctx.bot.id, "bot.spawned",
        {"child_bot_id": child.id, "name": name, "run_id": run.id},
    )
    await ctx.db.commit()

    runs.register_run(run.id)
    task_handle = asyncio.create_task(run_agent(ctx.session_factory, child.id, run.id, user_msg.id))
    runs.track_task(run.id, task_handle)

    return f"Spawned child bot '{name}' (id={child.id}). Its first run started (run_id={run.id})."


async def _tool_run_helper(ctx: RunContext, task: str) -> str:
    """Short-lived sub-agent inside the current turn. No persistent bot."""
    helper_ctx = RunContext(
        db=ctx.db,
        session_factory=ctx.session_factory,
        bot=ctx.bot,
        thread=ctx.thread,
        run=ctx.run,
        provider_cfg=ctx.provider_cfg,
        sandbox_session=ctx.sandbox_session,
        depth=ctx.depth + 1,
        memory=ctx.memory,
    )
    history: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are a short-lived helper sub-agent. Solve the subtask using the "
                "available tools and return a concise result. Do not ask follow-up questions."
            ),
        },
        {"role": "user", "content": task},
    ]
    final = "(helper produced no output)"
    for _ in range(settings.helper_max_iterations):
        if runs.is_cancelled(ctx.run.id):
            return "Helper cancelled."
        resp = await model_clients.chat_completion(ctx.provider_cfg, history, HELPER_TOOLS)
        history.append(
            {
                "role": "assistant",
                "content": resp["content"],
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {"name": tc["name"], "arguments": str(tc["arguments"])},
                    }
                    for tc in resp["tool_calls"]
                ]
                or None,
            }
        )
        if not resp["tool_calls"]:
            final = resp["content"] or final
            break
        for tc in resp["tool_calls"]:
            result = await execute_tool(helper_ctx, tc["name"], tc["arguments"])
            history.append(
                {"role": "tool", "tool_call_id": tc["id"], "content": result, "name": tc["name"]}
            )
    else:
        final = resp["content"] or final
    return f"Helper result:\n{final}"


# ------------------------------------------------------------------ main loop
def _build_system_prompt(bot: Bot, thread: Thread, memory: dict[str, str]) -> str:
    parts = [bot.system_prompt or "You are Rakazo, a helpful AI teammate with a live computer."]
    if bot.routines_md:
        parts.append("## Your routines\n" + bot.routines_md)
    if thread.summary:
        parts.append("## Conversation summary so far\n" + thread.summary)
    if memory:
        parts.append("## Long-term memory\n" + "\n".join(f"- {k}: {v}" for k, v in memory.items()))
    parts.append(
        "## Working notes\n"
        "- You have a live sandbox computer (working dir /workspace) with shell_run, file_*, http_fetch, browser_snapshot tools.\n"
        "- Prefer doing real work with tools over describing what you would do.\n"
        "- Package installs, deleting files outside /workspace, and contacting new network hosts require the user's approval — ask via the tool and wait.\n"
        "- Keep responses concise unless the user asked for detail."
    )
    return "\n\n".join(parts)


def _provider_config(provider: ModelProvider) -> ProviderConfig:
    return ProviderConfig(
        kind=provider.kind,
        model=provider.model,
        base_url=provider.base_url,
        api_key=decrypt_secret(provider.api_key_encrypted),
    )


async def _load_memory(db: AsyncSession, bot_id: str) -> dict[str, str]:
    rows = (await db.execute(select(MemoryItem).where(MemoryItem.bot_id == bot_id))).scalars().all()
    return {r.key: r.value for r in rows}


async def run_agent(
    session_factory: async_sessionmaker[AsyncSession],
    bot_id: str,
    run_id: str,
    user_message_id: str | None = None,
) -> None:
    """Run one agent turn in the background. Emits SSE events on the run bus."""
    runs.register_run(run_id)
    session: SandboxSession | None = None

    async with session_factory() as db:
        try:
            run = await db.get(Run, run_id)
            bot = await db.get(Bot, bot_id)
            if run is None or bot is None:
                await runs.emit(run_id, "error", {"message": "Run or bot not found"})
                return
            thread = (
                await db.execute(select(Thread).where(Thread.bot_id == bot.id))
            ).scalar_one()
            provider_row = await db.get(ModelProvider, bot.model_provider_id) if bot.model_provider_id else None
            if provider_row is None:
                raise RuntimeError("Bot has no model provider configured")
            sandbox_row = await db.get(SandboxRow, bot.sandbox_id) if bot.sandbox_id else None
            if sandbox_row is None:
                raise RuntimeError("Bot has no sandbox configured")

            provider_cfg = _provider_config(provider_row)
            try:
                sandbox_session = await sandbox_mod.get_provider(sandbox_row.kind).create_session(
                    sandbox_row.config or {}
                )
                session = sandbox_session
            except sandbox_mod.SandboxNotConfigured as exc:
                raise RuntimeError(str(exc)) from exc

            memory = await _load_memory(db, bot.id)
            ctx = RunContext(
                db=db,
                session_factory=session_factory,
                bot=bot,
                thread=thread,
                run=run,
                provider_cfg=provider_cfg,
                sandbox_session=sandbox_session,
                memory=memory,
            )

            await runs.emit(run_id, "run_started", {"bot_id": bot.id, "run_id": run_id})
            await log_audit(db, bot.user_id, bot.id, "run.started", {"run_id": run_id})
            await db.commit()

            messages: list[dict[str, Any]] = [
                {"role": "system", "content": _build_system_prompt(bot, thread, memory)}
            ]
            history = (
                await db.execute(
                    select(Message)
                    .where(Message.thread_id == thread.id)
                    .order_by(Message.created_at.asc())
                    .limit(200)
                )
            ).scalars().all()
            for m in history:
                msg: dict[str, Any] = {"role": m.role, "content": m.content or ""}
                if m.tool_calls:
                    msg["tool_calls"] = [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": str(tc.get("arguments", {}))},
                        }
                        for tc in m.tool_calls
                    ]
                if m.tool_call_id:
                    msg["tool_call_id"] = m.tool_call_id
                if m.name:
                    msg["name"] = m.name
                messages.append(msg)

            final_content: str | None = None
            for _step in range(settings.max_agent_iterations):
                if runs.is_cancelled(run_id):
                    run.status = "cancelled"
                    run.finished_at = datetime.now(timezone.utc)
                    await db.commit()
                    await log_audit(db, bot.user_id, bot.id, "run.cancelled", {"run_id": run_id})
                    await db.commit()
                    await runs.emit(run_id, "done", {"status": "cancelled"})
                    return

                async def on_token(t: str) -> None:
                    await runs.emit(run_id, "token", {"text": t})

                resp = await model_clients.chat_completion(provider_cfg, messages, AGENT_TOOLS, on_token)

                assistant_msg = Message(
                    thread_id=thread.id,
                    role="assistant",
                    content=resp["content"],
                    tool_calls=resp["tool_calls"] or None,
                    run_id=run_id,
                )
                db.add(assistant_msg)
                messages.append(
                    {
                        "role": "assistant",
                        "content": resp["content"] or "",
                        "tool_calls": [
                            {
                                "id": tc["id"],
                                "type": "function",
                                "function": {"name": tc["name"], "arguments": str(tc.get("arguments", {}))},
                            }
                            for tc in resp["tool_calls"]
                        ]
                        or None,
                    }
                )
                await db.commit()

                if not resp["tool_calls"]:
                    final_content = resp["content"]
                    break

                for tc in resp["tool_calls"]:
                    await runs.emit(
                        run_id, "tool_call",
                        {"id": tc["id"], "name": tc["name"], "arguments": tc["arguments"]},
                    )
                    result = await execute_tool(ctx, tc["name"], tc["arguments"] or {})
                    await runs.emit(
                        run_id, "tool_result",
                        {"id": tc["id"], "name": tc["name"], "result": _truncate(result, 4000)},
                    )
                    await log_audit(
                        db, bot.user_id, bot.id, "tool.executed",
                        {"run_id": run_id, "tool": tc["name"], "result_chars": len(result)},
                    )
                    db.add(
                        Message(
                            thread_id=thread.id,
                            role="tool",
                            content=result,
                            tool_call_id=tc["id"],
                            name=tc["name"],
                            run_id=run_id,
                        )
                    )
                    messages.append(
                        {"role": "tool", "tool_call_id": tc["id"], "content": result, "name": tc["name"]}
                    )
                    await db.commit()
                    if runs.is_cancelled(run_id):
                        break

            await _maybe_summarize(ctx, provider_cfg)

            run.status = "completed"
            run.finished_at = datetime.now(timezone.utc)
            await db.commit()
            await log_audit(db, bot.user_id, bot.id, "run.completed", {"run_id": run_id})
            await db.commit()
            await runs.emit(run_id, "done", {"status": "completed"})
        except Exception as exc:  # noqa: BLE001
            try:
                run = await db.get(Run, run_id)
                if run is not None and run.status not in ("completed", "cancelled"):
                    run.status = "failed"
                    run.error = str(exc)[:2000]
                    run.finished_at = datetime.now(timezone.utc)
                    await db.commit()
            except Exception:  # noqa: BLE001
                pass
            await runs.emit(run_id, "error", {"message": str(exc)[:2000]})
        finally:
            if session is not None:
                try:
                    await session.destroy()
                except Exception:  # noqa: BLE001
                    pass
            # Keep the event bus briefly so late SSE subscribers can drain it.
            async def _delayed_cleanup() -> None:
                await asyncio.sleep(120)
                runs.cleanup_run(run_id)

            asyncio.create_task(_delayed_cleanup())


async def _maybe_summarize(ctx: RunContext, provider_cfg: ProviderConfig) -> None:
    """Update the thread's rolling summary (best-effort, failures ignored)."""
    try:
        recent = (
            await ctx.db.execute(
                select(Message)
                .where(Message.thread_id == ctx.thread.id, Message.role.in_(("user", "assistant")))
                .order_by(Message.created_at.desc())
                .limit(20)
            )
        ).scalars().all()
        if not recent:
            return
        transcript = "\n".join(
            f"{m.role}: {(m.content or '')[:1500]}" for m in reversed(recent)
        )
        prompt = (
            "Summarize this conversation for long-term memory in 5-10 bullet points. "
            "Keep facts, decisions, and open tasks."
            + (f"\n\nPrevious summary:\n{ctx.thread.summary}" if ctx.thread.summary else "")
            + f"\n\nRecent messages:\n{transcript}"
        )
        resp = await model_clients.chat_completion(
            provider_cfg,
            [
                {"role": "system", "content": "You summarize conversations concisely."},
                {"role": "user", "content": prompt},
            ],
            tools=None,
            timeout=90,
        )
        if resp["content"]:
            ctx.thread.summary = resp["content"][:8000]
            await ctx.db.commit()
            await log_audit(ctx.db, ctx.bot.user_id, ctx.bot.id, "thread.summarized", {"run_id": ctx.run.id})
            await ctx.db.commit()
    except Exception:  # noqa: BLE001
        pass
