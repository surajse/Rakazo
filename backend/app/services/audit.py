"""Shared audit-log helper."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog


async def log_audit(
    db: AsyncSession,
    user_id: str | None,
    bot_id: str | None,
    event_type: str,
    detail: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            user_id=user_id,
            bot_id=bot_id,
            event_type=event_type,
            detail=detail or {},
        )
    )
    # Caller owns the commit; audit rows flush with the surrounding transaction.
