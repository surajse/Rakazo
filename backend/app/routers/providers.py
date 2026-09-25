"""Model provider endpoints. API keys are write-only; responses are masked."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.deps import get_current_user, get_db
from app.models import ModelProvider, User
from app.security import decrypt_secret, encrypt_secret, mask_key
from app.services.audit import log_audit

router = APIRouter(prefix="/model-providers", tags=["model-providers"])


def _out(p: ModelProvider) -> schemas.ProviderOut:
    key = decrypt_secret(p.api_key_encrypted)
    return schemas.ProviderOut(
        id=p.id,
        name=p.name,
        kind=p.kind,
        base_url=p.base_url,
        model=p.model,
        api_key_masked=mask_key(key),
        has_api_key=bool(key),
        created_at=p.created_at,
    )


@router.get("", response_model=list[schemas.ProviderOut])
async def list_providers(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(select(ModelProvider).where(ModelProvider.user_id == user.id).order_by(ModelProvider.created_at))
    ).scalars().all()
    return [_out(p) for p in rows]


@router.post("", response_model=schemas.ProviderOut, status_code=201)
async def create_provider(
    data: schemas.ProviderIn, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    if data.kind == "openai_compatible" and not data.base_url:
        raise HTTPException(status_code=400, detail="base_url is required for openai_compatible providers")
    provider = ModelProvider(
        user_id=user.id,
        name=data.name,
        kind=data.kind,
        base_url=data.base_url,
        api_key_encrypted=encrypt_secret(data.api_key),
        model=data.model,
        extra_config=data.extra_config,
    )
    db.add(provider)
    await db.flush()
    await log_audit(db, user.id, None, "provider.created", {"provider_id": provider.id, "kind": data.kind})
    await db.commit()
    return _out(provider)


async def _get_owned(provider_id: str, user: User, db: AsyncSession) -> ModelProvider:
    provider = await db.get(ModelProvider, provider_id)
    if provider is None or provider.user_id != user.id:
        raise HTTPException(status_code=404, detail="Provider not found")
    return provider


@router.patch("/{provider_id}", response_model=schemas.ProviderOut)
async def update_provider(
    provider_id: str,
    data: schemas.ProviderPatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    provider = await _get_owned(provider_id, user, db)
    if data.name is not None:
        provider.name = data.name
    if data.base_url is not None:
        provider.base_url = data.base_url
    if data.api_key is not None:
        provider.api_key_encrypted = encrypt_secret(data.api_key) if data.api_key else None
    if data.model is not None:
        provider.model = data.model
    if data.extra_config is not None:
        provider.extra_config = data.extra_config
    await log_audit(db, user.id, None, "provider.updated", {"provider_id": provider.id})
    await db.commit()
    return _out(provider)


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    provider = await _get_owned(provider_id, user, db)
    await db.delete(provider)
    await log_audit(db, user.id, None, "provider.deleted", {"provider_id": provider_id})
    await db.commit()
    return None
