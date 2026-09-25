"""Pydantic schemas for the REST API (contract under /api)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


# ---------------------------------------------------------------- users/auth
class UserOut(BaseModel):
    id: str
    email: str
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokenPair(BaseModel):
    user: UserOut
    access_token: str
    refresh_token: str


class MeOut(BaseModel):
    user: UserOut


# ---------------------------------------------------------------- model providers
ProviderKind = Literal["openai_compatible", "anthropic", "ollama"]


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: ProviderKind
    base_url: str | None = None
    api_key: str | None = None
    model: str = Field(min_length=1, max_length=200)
    extra_config: dict | None = None


class ProviderPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = Field(default=None, max_length=200)
    extra_config: dict | None = None


class ProviderOut(BaseModel):
    id: str
    name: str
    kind: str
    base_url: str | None
    model: str
    api_key_masked: str | None
    has_api_key: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- sandboxes
class SandboxKindOut(BaseModel):
    kind: str
    name: str
    description: str
    configured: bool
    config_schema: dict


class SandboxIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str
    config: dict = Field(default_factory=dict)


class SandboxOut(BaseModel):
    id: str
    name: str
    kind: str
    config: dict
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- templates
class TemplateOut(BaseModel):
    id: str
    name: str
    description: str
    system_prompt: str
    routines_md: str

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- bots
class BotIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    template: str | None = None
    model_provider_id: str | None = None
    sandbox_id: str | None = None
    system_prompt: str | None = None
    routines_md: str | None = None
    # MCP tool servers; see Bot.mcp_servers for the config schema.
    mcp_servers: list[dict[str, Any]] | None = None


class BotPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    template: str | None = None
    model_provider_id: str | None = None
    sandbox_id: str | None = None
    system_prompt: str | None = None
    routines_md: str | None = None
    status: Literal["active", "archived"] | None = None
    mcp_servers: list[dict[str, Any]] | None = None


class BotOut(BaseModel):
    id: str
    name: str
    template: str | None
    model_provider_id: str | None
    sandbox_id: str | None
    system_prompt: str
    routines_md: str
    parent_bot_id: str | None
    status: str
    mcp_servers: list[dict[str, Any]] | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- thread / messages
class MessageOut(BaseModel):
    id: str
    role: str
    content: str | None
    tool_calls: list | None = None
    tool_call_id: str | None = None
    name: str | None = None
    run_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ThreadOut(BaseModel):
    id: str
    bot_id: str
    summary: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ThreadDetail(BaseModel):
    thread: ThreadOut
    messages: list[MessageOut]


class MessageIn(BaseModel):
    content: str = Field(min_length=1)


class MessageAccepted(BaseModel):
    message: MessageOut
    run_id: str


class SubbotIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    task: str = Field(min_length=1)
    template: str | None = None


class SubbotOut(BaseModel):
    bot: BotOut
    run_id: str


# ---------------------------------------------------------------- memory
class MemoryIn(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    value: str


class MemoryOut(BaseModel):
    key: str
    value: str
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- approvals
class ApprovalOut(BaseModel):
    id: str
    bot_id: str
    run_id: str | None
    kind: str
    description: str
    payload: dict
    status: str
    reason: str | None
    created_at: datetime
    resolved_at: datetime | None

    model_config = {"from_attributes": True}


class DenyIn(BaseModel):
    reason: str | None = None


# ---------------------------------------------------------------- audit
class AuditOut(BaseModel):
    id: str
    event_type: str
    user_id: str | None
    bot_id: str | None
    detail: dict
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------- health
class HealthOut(BaseModel):
    status: str
    version: str
    sandbox_kinds: list[SandboxKindOut]
