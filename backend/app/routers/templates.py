"""Bot template catalog (seeded at startup)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.deps import get_current_user, get_db
from app.models import BotTemplate, User

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("", response_model=list[schemas.TemplateOut])
async def list_templates(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(BotTemplate).order_by(BotTemplate.name))).scalars().all()
    return rows
