"""add openapi_specs to bots

Revision ID: c1d2e3f4a5b6
Revises: 89de492b834f
Create Date: 2026-09-25

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = 'c1d2e3f4a5b6'
down_revision: str | None = '89de492b834f'
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column('bots', sa.Column('openapi_specs', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('bots', 'openapi_specs')
