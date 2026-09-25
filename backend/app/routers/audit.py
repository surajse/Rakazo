"""Audit log endpoints (read-only)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.deps import get_current_user, get_db
from app.models import AuditLog, Bot, User

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=list[schemas.AuditOut])
async def list_audit(
    bot_id: str | None = None,
    limit: int = 100,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(limit, 500))
    # Only rows for this user's own activity / bots.
    own_bot_ids = (
        select(Bot.id).where(Bot.user_id == user.id)
    )
    stmt = (
        select(AuditLog)
        .where((AuditLog.user_id == user.id) | (AuditLog.bot_id.in_(own_bot_ids)))
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
    )
    if bot_id:
        bot = await db.get(Bot, bot_id)
        if bot is None or bot.user_id != user.id:
            return []
        stmt = select(AuditLog).where(AuditLog.bot_id == bot_id).order_by(
            AuditLog.created_at.desc(), AuditLog.id.desc()
        ).limit(limit)
    rows = (await db.execute(stmt)).scalars().all()
    return rows
