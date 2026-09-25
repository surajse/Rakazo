"""Alembic environment for Rakazo."""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def get_url() -> str:
    url = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    # Alembic runs synchronously; use psycopg2 instead of asyncpg.
    url = url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")
    if url.startswith("sqlite+aiosqlite:"):
        path = url.split("sqlite+aiosqlite:", 1)[1].lstrip("/")
        # Normalize to an absolute sqlite path (sqlite:////abs/path).
        url = f"sqlite:////{path}"
    return url


config.set_main_option("sqlalchemy.url", get_url())

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=get_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
