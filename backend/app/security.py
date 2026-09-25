"""Password hashing, JWT tokens, and Fernet encryption for stored API keys."""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet

from app.config import settings


# ---------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


# ---------------------------------------------------------------- JWT
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _encode(payload: dict) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: str) -> str:
    return _encode(
        {
            "sub": user_id,
            "type": "access",
            "jti": uuid.uuid4().hex,
            "exp": _now() + timedelta(minutes=settings.access_token_minutes),
            "iat": _now(),
        }
    )


def create_refresh_token(user_id: str) -> tuple[str, str]:
    """Return (token, jti)."""
    jti = uuid.uuid4().hex
    token = _encode(
        {
            "sub": user_id,
            "type": "refresh",
            "jti": jti,
            "exp": _now() + timedelta(days=settings.refresh_token_days),
            "iat": _now(),
        }
    )
    return token, jti


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- Fernet
_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    """Return the Fernet key, generating + persisting one on first boot if needed."""
    if settings.rakazo_fernet_key:
        key = settings.rakazo_fernet_key.strip()
        return key.encode("utf-8")
    path = settings.fernet_key_file
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read().strip()
    key = Fernet.generate_key()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt_secret(plaintext: str | None) -> str | None:
    if plaintext is None:
        return None
    return get_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_secret(ciphertext: str | None) -> str | None:
    if ciphertext is None:
        return None
    return get_fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")


def mask_key(api_key: str | None) -> str | None:
    """Return a masked representation safe to expose via the API."""
    if not api_key:
        return None
    if len(api_key) <= 8:
        return "••••••••"
    return f"{api_key[:3]}••••••••{api_key[-4:]}"
