"""Auth endpoints: signup, login, refresh, me."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.config import settings
from app.deps import get_db
from app.models import RefreshToken, User
from app.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    sha256_hex,
    verify_password,
)
from app.services.audit import log_audit

router = APIRouter(prefix="/auth", tags=["auth"])


async def _issue_pair(db: AsyncSession, user: User) -> tuple[str, str]:
    access = create_access_token(user.id)
    refresh, jti = create_refresh_token(user.id)
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=sha256_hex(refresh),
            expires_at=datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days),
        )
    )
    return access, refresh


@router.post("/signup", response_model=schemas.TokenPair, status_code=status.HTTP_201_CREATED)
async def signup(data: schemas.SignupIn, db: AsyncSession = Depends(get_db)):
    existing = (
        await db.execute(select(User).where(User.email == data.email.lower()))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(email=data.email.lower(), name=data.name, password_hash=hash_password(data.password))
    db.add(user)
    await db.flush()
    access, refresh = await _issue_pair(db, user)
    await log_audit(db, user.id, None, "auth.signup", {"email": user.email})
    await db.commit()
    return {"user": user, "access_token": access, "refresh_token": refresh}


@router.post("/login", response_model=schemas.TokenPair)
async def login(data: schemas.LoginIn, db: AsyncSession = Depends(get_db)):
    user = (
        await db.execute(select(User).where(User.email == data.email.lower()))
    ).scalar_one_or_none()
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    access, refresh = await _issue_pair(db, user)
    await log_audit(db, user.id, None, "auth.login", {"email": user.email})
    await db.commit()
    return {"user": user, "access_token": access, "refresh_token": refresh}


@router.post("/refresh", response_model=schemas.TokenPair)
async def refresh(data: schemas.RefreshIn, db: AsyncSession = Depends(get_db)):
    try:
        payload = decode_token(data.refresh_token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")

    record = (
        await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == sha256_hex(data.refresh_token))
        )
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if (
        record is None
        or record.revoked
        or record.expires_at.replace(tzinfo=timezone.utc) < now
        or record.user_id != payload.get("sub")
    ):
        raise HTTPException(status_code=401, detail="Refresh token expired or revoked")

    user = await db.get(User, record.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    # Rotate: revoke the old token, issue a new pair.
    record.revoked = True
    access, refresh = await _issue_pair(db, user)
    await log_audit(db, user.id, None, "auth.refresh", {})
    await db.commit()
    return {"user": user, "access_token": access, "refresh_token": refresh}
