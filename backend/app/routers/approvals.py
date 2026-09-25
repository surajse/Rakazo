"""Approval queue endpoints."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.deps import get_current_user, get_db
from app.models import Approval, Bot, User
from app.services import runs
from app.services.audit import log_audit

router = APIRouter(prefix="/approvals", tags=["approvals"])


@router.get("", response_model=list[schemas.ApprovalOut])
async def list_approvals(
    status: str = "pending",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Approval)
        .join(Bot, Approval.bot_id == Bot.id)
        .where(Bot.user_id == user.id)
        .order_by(Approval.created_at.desc())
    )
    if status != "all":
        stmt = stmt.where(Approval.status == status)
    rows = (await db.execute(stmt)).scalars().all()
    return rows


async def _get_owned(approval_id: str, user: User, db: AsyncSession) -> Approval:
    approval = await db.get(Approval, approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    bot = await db.get(Bot, approval.bot_id)
    if bot is None or bot.user_id != user.id:
        raise HTTPException(status_code=404, detail="Approval not found")
    return approval


def _resolve(approval: Approval, approved: bool, reason: str | None) -> None:
    approval.status = "approved" if approved else "denied"
    approval.reason = reason
    approval.resolved_at = datetime.now(timezone.utc)
    runs.approval_outcomes[approval.id] = approved
    waiter = runs.approval_events.get(approval.id)
    if waiter is not None:
        waiter.set()


@router.post("/{approval_id}/approve", response_model=schemas.ApprovalOut)
async def approve(
    approval_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    approval = await _get_owned(approval_id, user, db)
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail=f"Approval already {approval.status}")
    _resolve(approval, True, None)
    await log_audit(db, user.id, approval.bot_id, "approval.resolved",
                    {"approval_id": approval.id, "decision": "approved"})
    await db.commit()
    return approval


@router.post("/{approval_id}/deny", response_model=schemas.ApprovalOut)
async def deny(
    approval_id: str,
    data: schemas.DenyIn | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    approval = await _get_owned(approval_id, user, db)
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail=f"Approval already {approval.status}")
    _resolve(approval, False, data.reason if data else None)
    await log_audit(db, user.id, approval.bot_id, "approval.resolved",
                    {"approval_id": approval.id, "decision": "denied"})
    await db.commit()
    return approval
