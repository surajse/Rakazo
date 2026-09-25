"""Rakazo API — self-hosted AI bot platform."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import schemas
from app.config import settings
from app.database import SessionLocal
from app.deps import get_current_user
from app.models import User
from app.routers import approvals, audit, auth, bots, health, providers, sandboxes, templates
from app.seed import seed_templates
from app.security import get_fernet  # noqa: F401  (ensures key exists on boot)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the Fernet key exists (generated + persisted on first boot).
    get_fernet()
    # Run DB migrations (Alembic), with retries for the db container startup.
    await _migrate_with_retry()
    # Seed bot templates.
    async with SessionLocal() as db:
        await seed_templates(db)
    yield


async def _migrate_with_retry(tries: int = 15, delay: float = 2.0) -> None:
    from alembic import command
    from alembic.config import Config

    import os

    last_exc: Exception | None = None
    for _ in range(tries):
        try:
            cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
            await asyncio.to_thread(command.upgrade, cfg, "head")
            return
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            await asyncio.sleep(delay)
    raise RuntimeError(f"Database migration failed after {tries} attempts: {last_exc}")


def create_app() -> FastAPI:
    app = FastAPI(title="Rakazo", version=settings.version, lifespan=lifespan)

    origins = (
        ["*"] if settings.cors_origins.strip() == "*" else [o.strip() for o in settings.cors_origins.split(",")]
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(providers.router, prefix="/api")
    app.include_router(sandboxes.router, prefix="/api")
    app.include_router(templates.router, prefix="/api")
    app.include_router(bots.router, prefix="/api")
    app.include_router(approvals.router, prefix="/api")
    app.include_router(audit.router, prefix="/api")

    @app.get("/api/me", response_model=schemas.MeOut, tags=["auth"])
    async def me(user: User = Depends(get_current_user)):
        return {"user": user}

    @app.get("/", include_in_schema=False)
    async def root():
        return {"name": "Rakazo", "version": settings.version, "docs": "/docs"}

    return app


app = create_app()
