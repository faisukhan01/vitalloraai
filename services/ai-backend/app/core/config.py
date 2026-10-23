"""Application configuration.

Loads environment variables from the repository-root .env file (development)
or the process environment (production). Fails fast with a clear, actionable
error when required configuration is missing (spec §9).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# services/ai-backend/app/core/config.py -> repo root is 4 parents up
REPO_ROOT = Path(__file__).resolve().parents[4]
# Real secrets live in .env.local (gitignored). .env (if present) holds fallback config.
# .env.local takes precedence (pydantic-settings: earlier files win per key).
ENV_FILES = (REPO_ROOT / ".env.local", REPO_ROOT / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=[str(p) for p in ENV_FILES],
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Database (Turso) ────────────────────────────────────────────────
    turso_database_url: str = Field(default="", alias="TURSO_DATABASE_URL")
    turso_auth_token: str = Field(default="", alias="TURSO_AUTH_TOKEN")

    # ── Security ────────────────────────────────────────────────────────
    jwt_secret: str = Field(default="", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    access_token_expire_minutes: int = Field(default=30, alias="ACCESS_TOKEN_EXPIRE_MINUTES")
    refresh_token_expire_days: int = Field(default=7, alias="REFRESH_TOKEN_EXPIRE_DAYS")

    # ── Service ─────────────────────────────────────────────────────────
    backend_host: str = Field(default="0.0.0.0", alias="BACKEND_HOST")
    backend_port: int = Field(default=8000, alias="BACKEND_PORT")
    cors_origins: str = Field(default="*", alias="CORS_ORIGINS")
    cookie_secure: bool = Field(default=False, alias="COOKIE_SECURE")
    cookie_samesite: Literal["lax", "none", "strict"] = Field(default="lax", alias="COOKIE_SAMESITE")

    # ── AI bridge ───────────────────────────────────────────────────────
    ai_bridge_url: str = Field(default="http://127.0.0.1:8100", alias="AI_BRIDGE_URL")
    llm_provider: Literal["zai", "openai"] = Field(default="zai", alias="LLM_PROVIDER")
    stt_provider: Literal["zai", "openai"] = Field(default="zai", alias="STT_PROVIDER")
    tts_provider: Literal["zai", "openai"] = Field(default="zai", alias="TTS_PROVIDER")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    openai_llm_model: str = Field(default="gpt-4o-mini", alias="OPENAI_LLM_MODEL")

    # ── Voice defaults ──────────────────────────────────────────────────
    default_voice_language: str = Field(default="en", alias="DEFAULT_VOICE_LANGUAGE")
    supported_languages: str = Field(default="en,ur,hi,ar", alias="SUPPORTED_LANGUAGES")

    # ── Retention ───────────────────────────────────────────────────────
    transcript_retention_days: int = Field(default=90, alias="TRANSCRIPT_RETENTION_DAYS")
    audit_retention_days: int = Field(default=365, alias="AUDIT_RETENTION_DAYS")

    # ── Seed (development only) ─────────────────────────────────────────
    seed_admin_password: str = Field(default="", alias="SEED_ADMIN_PASSWORD")

    @field_validator("turso_database_url")
    @classmethod
    def _validate_db_url(cls, v: str) -> str:
        if v and not v.startswith("libsql://"):
            raise ValueError("TURSO_DATABASE_URL must start with libsql://")
        return v

    @model_validator(mode="after")
    def _validate_required(self) -> Settings:
        missing = []
        if not self.turso_database_url:
            missing.append("TURSO_DATABASE_URL")
        if not self.turso_auth_token:
            missing.append("TURSO_AUTH_TOKEN")
        if not self.jwt_secret or self.jwt_secret == "change-me-to-a-64-char-random-hex-string":
            missing.append('JWT_SECRET (generate: python -c "import secrets; print(secrets.token_hex(32))")')
        if missing:
            raise RuntimeError(
                "Missing required environment configuration: "
                + ", ".join(missing)
                + f". Copy .env.example to {ENV_FILES[0]} and fill in real values."
            )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def supported_language_list(self) -> list[str]:
        return [lang.strip() for lang in self.supported_languages.split(",") if lang.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
