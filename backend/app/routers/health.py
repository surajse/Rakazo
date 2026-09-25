"""Health check."""
from __future__ import annotations

from fastapi import APIRouter

from app import schemas
from app.config import settings
from app.services import sandbox as sandbox_mod

router = APIRouter(tags=["health"])


@router.get("/health", response_model=schemas.HealthOut)
async def health():
    return {
        "status": "ok",
        "version": settings.version,
        "sandbox_kinds": [schemas.SandboxKindOut(**info) for info in sandbox_mod.kind_infos()],
    }
