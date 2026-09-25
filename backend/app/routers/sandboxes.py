"""Sandbox kinds + named sandbox configs."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
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


def _sandbox_out(sandbox: Sandbox, user: User, owner: User | None) -> schemas.SandboxOut:
    return schemas.SandboxOut(
        id=sandbox.id,
        name=sandbox.name,
        kind=sandbox.kind,
        config=sandbox.config or {},
        shared=bool(sandbox.shared),
        is_owner=sandbox.user_id == user.id,
        owner_name=owner.name if owner else None,
        owner_email=owner.email if owner else None,
        created_at=sandbox.created_at,
    )


async def _get_owned_sandbox(db: AsyncSession, sandbox_id: str, user: User) -> Sandbox:
    """Fetch a sandbox, raising 404 unless it exists and belongs to `user`.

    404 (not 403) hides existence from non-owners; in particular this blocks
    non-owners from editing, deleting, or changing the share flag of a sandbox
    they don't own.
    """
    sandbox = await db.get(Sandbox, sandbox_id)
    if sandbox is None or sandbox.user_id != user.id:
        raise HTTPException(status_code=404, detail="Sandbox not found")
    return sandbox


@router.get("/sandboxes", response_model=list[schemas.SandboxOut])
async def list_sandboxes(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # The requesting user's own sandboxes plus sandboxes shared by other team
    # members. Deliberate simplification: every authenticated user is "the
    # team" — there is no org/team model.
    rows = (
        await db.execute(
            select(Sandbox, User)
            .outerjoin(User, User.id == Sandbox.user_id)
            .where(or_(Sandbox.user_id == user.id, Sandbox.shared.is_(True)))
            .order_by(Sandbox.created_at)
        )
    ).all()
    return [_sandbox_out(sandbox, user, owner) for sandbox, owner in rows]


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
    return _sandbox_out(sandbox, user, user)


@router.patch("/sandboxes/{sandbox_id}", response_model=schemas.SandboxOut)
async def update_sandbox(
    sandbox_id: str,
    data: schemas.SandboxPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rename and/or toggle team sharing. Owner only — non-owners get 404."""
    sandbox = await _get_owned_sandbox(db, sandbox_id, user)
    was_shared = bool(sandbox.shared)
    if data.name is not None:
        sandbox.name = data.name
    if data.shared is not None:
        sandbox.shared = data.shared
    if sandbox.shared != was_shared:
        await log_audit(
            db,
            user.id,
            None,
            "sandbox.shared" if sandbox.shared else "sandbox.unshared",
            {"sandbox_id": sandbox.id},
        )
    else:
        await log_audit(db, user.id, None, "sandbox.updated", {"sandbox_id": sandbox.id})
    await db.commit()
    return _sandbox_out(sandbox, user, user)


@router.delete("/sandboxes/{sandbox_id}", status_code=204)
async def delete_sandbox(
    sandbox_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    sandbox = await _get_owned_sandbox(db, sandbox_id, user)
    await db.delete(sandbox)
    await log_audit(db, user.id, None, "sandbox.deleted", {"sandbox_id": sandbox_id})
    await db.commit()
    return None
