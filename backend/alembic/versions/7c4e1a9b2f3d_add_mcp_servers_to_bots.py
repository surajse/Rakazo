"""add mcp_servers to bots

Revision ID: 7c4e1a9b2f3d
Revises: 28f49ac1d22c
Create Date: 2026-09-25

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = '7c4e1a9b2f3d'
down_revision: str | None = '28f49ac1d22c'
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column('bots', sa.Column('mcp_servers', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('bots', 'mcp_servers')
