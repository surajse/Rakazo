"""Application configuration loaded from environment variables."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Rakazo"
    version: str = "0.1.0"

    # Postgres (async). Example: postgresql+asyncpg://rakazo:rakazo@db:5432/rakazo
    database_url: str = "postgresql+asyncpg://rakazo:rakazo@localhost:5432/rakazo"

    # JWT
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30

    # Fernet key used to encrypt stored provider API keys.
    # If unset, one is generated on first boot and persisted to fernet_key_file.
    rakazo_fernet_key: str | None = None
    fernet_key_file: str = "/data/.fernet_key"

    # CORS: "*" or comma-separated origins
    cors_origins: str = "*"

    # Agent loop
    max_agent_iterations: int = 25
    helper_max_iterations: int = 8
    approval_timeout_seconds: int = 900
    max_tool_result_chars: int = 12000


settings = Settings()
