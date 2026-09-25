"""Sandbox kinds + named sandbox configs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.deps import get_current_user, get_db
from app.models import Sandbox, User
from app.services import sandbox as sandbox_mod
from app.services.audit import log_audit

router = APIRouter(tags=["sandboxes"])


@router.get("/sandbox-kinds", response_model=list[schemas.SandboxKindOut])
async def list_kinds():
    return [schemas.SandboxKindOut(**info) for info in sandbox_mod.kind_infos()]


@router.get("/sandboxes", response_model=list[schemas.SandboxOut])
async def list_sandboxes(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(Sandbox).where(Sandbox.user_id == user.id).order_by(Sandbox.created_at))
    ).scalars().all()
    return rows


@router.post("/sandboxes", response_model=schemas.SandboxOut, status_code=201)
async def create_sandbox(
    data: schemas.SandboxIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if data.kind not in sandbox_mod.REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown sandbox kind: {data.kind}")
    sandbox = Sandbox(user_id=user.id, name=data.name, kind=data.kind, config=data.config or {})
    db.add(sandbox)
    await db.flush()
    await log_audit(db, user.id, None, "sandbox.created", {"sandbox_id": sandbox.id, "kind": data.kind})
    await db.commit()
    return sandbox


@router.delete("/sandboxes/{sandbox_id}", status_code=204)
async def delete_sandbox(
    sandbox_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    sandbox = await db.get(Sandbox, sandbox_id)
    if sandbox is None or sandbox.user_id != user.id:
        raise HTTPException(status_code=404, detail="Sandbox not found")
    await db.delete(sandbox)
    await log_audit(db, user.id, None, "sandbox.deleted", {"sandbox_id": sandbox_id})
    await db.commit()
    return None
