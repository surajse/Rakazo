"""Bot CRUD, threads, messages, streaming runs, sub-bots, and memory."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.database import SessionLocal
from app.deps import get_current_user, get_db
from app.models import Bot, BotTemplate, MemoryItem, Message, ModelProvider, Run, Sandbox, Thread, User
from app.services import agent, runs
from app.services.audit import log_audit

router = APIRouter(prefix="/bots", tags=["bots"])

TERMINAL_RUN_STATUSES = ("completed", "cancelled", "failed")


async def _get_owned_bot(bot_id: str, user: User, db: AsyncSession) -> Bot:
    bot = await db.get(Bot, bot_id)
    if bot is None or bot.user_id != user.id:
        raise HTTPException(status_code=404, detail="Bot not found")
    return bot


async def _get_thread(bot: Bot, db: AsyncSession) -> Thread:
    thread = (await db.execute(select(Thread).where(Thread.bot_id == bot.id))).scalar_one_or_none()
    if thread is None:
        thread = Thread(bot_id=bot.id)
        db.add(thread)
        await db.flush()
    return thread


async def _template_prompts(db: AsyncSession, template_name: str | None) -> tuple[str, str]:
    if not template_name:
        return "", ""
    tpl = (await db.execute(select(BotTemplate).where(BotTemplate.name == template_name))).scalar_one_or_none()
    if tpl is None:
        raise HTTPException(status_code=400, detail=f"Unknown template: {template_name}")
    return tpl.system_prompt, tpl.routines_md


# ------------------------------------------------------------------ CRUD
async def _check_sandbox_access(db: AsyncSession, sandbox_id: str, user: User) -> Sandbox:
    """A bot may use the user's own sandbox, or any sandbox shared with the
    team (all authenticated users are "the team"; no org model). Read/execute
    access only — editing/deleting/sharing stays owner-only (enforced in the
    sandboxes router)."""
    sandbox = await db.get(Sandbox, sandbox_id)
    if sandbox is None or (sandbox.user_id != user.id and not sandbox.shared):
        raise HTTPException(status_code=400, detail="Invalid sandbox_id")
    return sandbox


@router.get("", response_model=list[schemas.BotOut])
async def list_bots(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(Bot).where(Bot.user_id == user.id).order_by(Bot.created_at))
    ).scalars().all()
    return rows


@router.post("", response_model=schemas.BotOut, status_code=201)
async def create_bot(
    data: schemas.BotIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if data.model_provider_id:
        provider = await db.get(ModelProvider, data.model_provider_id)
        if provider is None or provider.user_id != user.id:
            raise HTTPException(status_code=400, detail="Invalid model_provider_id")
    if data.sandbox_id:
        await _check_sandbox_access(db, data.sandbox_id, user)

    tpl_system, tpl_routines = await _template_prompts(db, data.template)
    bot = Bot(
        user_id=user.id,
        name=data.name,
        template=data.template,
        model_provider_id=data.model_provider_id,
        sandbox_id=data.sandbox_id,
        system_prompt=data.system_prompt if data.system_prompt is not None else tpl_system,
        routines_md=data.routines_md if data.routines_md is not None else tpl_routines,
        mcp_servers=data.mcp_servers,
        openapi_specs=data.openapi_specs,
    )
    db.add(bot)
    await db.flush()
    db.add(Thread(bot_id=bot.id))
    await log_audit(db, user.id, bot.id, "bot.created", {"name": bot.name, "template": data.template})
    await db.commit()
    return bot


@router.get("/{bot_id}", response_model=schemas.BotOut)
async def get_bot(bot_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _get_owned_bot(bot_id, user, db)


@router.patch("/{bot_id}", response_model=schemas.BotOut)
async def update_bot(
    bot_id: str, data: schemas.BotPatch, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    if data.model_provider_id is not None:
        if data.model_provider_id:
            provider = await db.get(ModelProvider, data.model_provider_id)
            if provider is None or provider.user_id != user.id:
                raise HTTPException(status_code=400, detail="Invalid model_provider_id")
            bot.model_provider_id = data.model_provider_id
        else:
            bot.model_provider_id = None
    if data.sandbox_id is not None:
        if data.sandbox_id:
            sandbox = await _check_sandbox_access(db, data.sandbox_id, user)
            bot.sandbox_id = data.sandbox_id
        else:
            bot.sandbox_id = None
    for field in ("name", "template", "system_prompt", "routines_md", "status"):
        value = getattr(data, field)
        if value is not None:
            setattr(bot, field, value)
    if data.mcp_servers is not None:
        bot.mcp_servers = data.mcp_servers
    if data.openapi_specs is not None:
        bot.openapi_specs = data.openapi_specs
    await log_audit(db, user.id, bot.id, "bot.updated", {"fields": data.model_dump(exclude_unset=True).keys().__str__()})
    await db.commit()
    return bot


@router.delete("/{bot_id}", status_code=204)
async def delete_bot(bot_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    bot = await _get_owned_bot(bot_id, user, db)
    await db.delete(bot)
    await log_audit(db, user.id, None, "bot.deleted", {"bot_id": bot_id})
    await db.commit()
    return None


# ------------------------------------------------------------------ thread
@router.get("/{bot_id}/thread", response_model=schemas.ThreadDetail)
async def get_thread(bot_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    bot = await _get_owned_bot(bot_id, user, db)
    thread = await _get_thread(bot, db)
    messages = (
        await db.execute(
            select(Message)
            .where(Message.thread_id == thread.id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(50)
        )
    ).scalars().all()
    return {"thread": thread, "messages": list(reversed(messages))}


@router.get("/{bot_id}/thread/messages", response_model=list[schemas.MessageOut])
async def list_messages(
    bot_id: str,
    before: str | None = None,
    limit: int = 50,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await _get_owned_bot(bot_id, user, db)
    thread = await _get_thread(bot, db)
    limit = max(1, min(limit, 200))
    stmt = select(Message).where(Message.thread_id == thread.id)
    if before:
        anchor = await db.get(Message, before)
        if anchor is None or anchor.thread_id != thread.id:
            raise HTTPException(status_code=400, detail="Invalid before cursor")
        stmt = stmt.where(
            (Message.created_at < anchor.created_at)
            | ((Message.created_at == anchor.created_at) & (Message.id < anchor.id))
        )
    stmt = stmt.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return list(reversed(rows))


@router.post("/{bot_id}/thread/messages", response_model=schemas.MessageAccepted, status_code=201)
async def post_message(
    bot_id: str, data: schemas.MessageIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    thread = await _get_thread(bot, db)
    message = Message(thread_id=thread.id, role="user", content=data.content)
    db.add(message)
    await db.flush()
    run = Run(bot_id=bot.id, thread_id=thread.id)
    db.add(run)
    await db.flush()
    await log_audit(
        db, user.id, bot.id, "thread.message_sent",
        {"message_id": message.id, "run_id": run.id, "chars": len(data.content)},
    )
    await db.commit()

    runs.register_run(run.id)
    task = asyncio.create_task(agent.run_agent(SessionLocal, bot.id, run.id, message.id))
    runs.track_task(run.id, task)

    return {"message": message, "run_id": run.id}


def _sse(event_type: str, data: dict) -> str:
    import json

    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


@router.get("/{bot_id}/thread/messages/stream")
async def stream_run(
    bot_id: str,
    run_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    bot = await _get_owned_bot(bot_id, user, db)
    run = await db.get(Run, run_id)
    if run is None or run.bot_id != bot.id:
        raise HTTPException(status_code=404, detail="Run not found")
    bus = runs.get_bus(run_id)

    async def gen():
        yield _sse("run", {"run_id": run_id, "status": run.status})
        while True:
            try:
                evt = await asyncio.wait_for(bus.get(), timeout=25)
            except asyncio.TimeoutError:
                await db.refresh(run)
                if run.status in TERMINAL_RUN_STATUSES:
                    yield _sse("done", {"status": run.status})
                    return
                yield ": keepalive\n\n"
                continue
            yield _sse(evt["type"], evt["data"])
            if evt["type"] in ("done", "error"):
                return

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/{bot_id}/runs/{run_id}/cancel")
async def cancel_run(
    bot_id: str, run_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    run = await db.get(Run, run_id)
    if run is None or run.bot_id != bot.id:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status in TERMINAL_RUN_STATUSES:
        return {"run_id": run_id, "status": run.status}
    runs.request_cancel(run_id)
    run.status = "cancelled"
    run.finished_at = datetime.now(timezone.utc)
    await log_audit(db, user.id, bot.id, "run.cancelled", {"run_id": run_id})
    await db.commit()
    await runs.emit(run_id, "done", {"status": "cancelled"})
    return {"run_id": run_id, "status": "cancelled"}


# ------------------------------------------------------------------ sub-bots
@router.get("/{bot_id}/subbots", response_model=list[schemas.BotOut])
async def list_subbots(bot_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    bot = await _get_owned_bot(bot_id, user, db)
    rows = (
        await db.execute(select(Bot).where(Bot.parent_bot_id == bot.id).order_by(Bot.created_at))
    ).scalars().all()
    return rows


@router.post("/{bot_id}/subbots", response_model=schemas.SubbotOut, status_code=201)
async def create_subbot(
    bot_id: str, data: schemas.SubbotIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    tpl_system, tpl_routines = await _template_prompts(db, data.template)
    child = Bot(
        user_id=user.id,
        name=data.name,
        template=data.template,
        model_provider_id=bot.model_provider_id,
        sandbox_id=bot.sandbox_id,
        system_prompt=tpl_system or "You are a focused helper bot. Complete the task, then summarize what you did.",
        routines_md=tpl_routines,
        parent_bot_id=bot.id,
    )
    db.add(child)
    await db.flush()
    thread = Thread(bot_id=child.id)
    db.add(thread)
    await db.flush()
    user_msg = Message(thread_id=thread.id, role="user", content=data.task)
    db.add(user_msg)
    await db.flush()
    run = Run(bot_id=child.id, thread_id=thread.id)
    db.add(run)
    await db.flush()
    await log_audit(
        db, user.id, bot.id, "bot.spawned",
        {"child_bot_id": child.id, "name": data.name, "run_id": run.id, "via": "api"},
    )
    await db.commit()

    runs.register_run(run.id)
    task = asyncio.create_task(agent.run_agent(SessionLocal, child.id, run.id, user_msg.id))
    runs.track_task(run.id, task)

    return {"bot": child, "run_id": run.id}


# ------------------------------------------------------------------ memory
@router.get("/{bot_id}/memory", response_model=list[schemas.MemoryOut])
async def list_memory(bot_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    bot = await _get_owned_bot(bot_id, user, db)
    rows = (
        await db.execute(select(MemoryItem).where(MemoryItem.bot_id == bot.id).order_by(MemoryItem.key))
    ).scalars().all()
    return rows


@router.post("/{bot_id}/memory", response_model=schemas.MemoryOut, status_code=201)
async def set_memory(
    bot_id: str, data: schemas.MemoryIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    item = (
        await db.execute(
            select(MemoryItem).where(MemoryItem.bot_id == bot.id, MemoryItem.key == data.key)
        )
    ).scalar_one_or_none()
    if item is None:
        item = MemoryItem(bot_id=bot.id, key=data.key, value=data.value)
        db.add(item)
    else:
        item.value = data.value
        item.updated_at = datetime.now(timezone.utc)
    await log_audit(db, user.id, bot.id, "memory.set", {"key": data.key})
    await db.commit()
    return item


@router.delete("/{bot_id}/memory/{key}", status_code=204)
async def delete_memory(
    bot_id: str, key: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    bot = await _get_owned_bot(bot_id, user, db)
    item = (
        await db.execute(select(MemoryItem).where(MemoryItem.bot_id == bot.id, MemoryItem.key == key))
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Memory key not found")
    await db.delete(item)
    await log_audit(db, user.id, bot.id, "memory.deleted", {"key": key})
    await db.commit()
    return None
