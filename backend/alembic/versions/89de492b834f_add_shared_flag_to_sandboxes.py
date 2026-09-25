"""add shared flag to sandboxes

Revision ID: 89de492b834f
Revises: 7c4e1a9b2f3d
Create Date: 2026-09-25

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = '89de492b834f'
down_revision: str | None = '7c4e1a9b2f3d'
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        'sandboxes',
        sa.Column('shared', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('sandboxes', 'shared')
