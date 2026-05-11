from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: Literal["fatal", "error", "warn", "info", "debug", "trace"] = "info"

    # Empty string disables auth — used for local dev. In production set a strong key.
    api_key: str = ""

    backend: Literal["stub", "claude", "openai", "qwen"] = "stub"

    # --- Anthropic / Claude ---
    # API key is read separately from the backend selection because we report
    # "configured" / "not configured" via /v1/providers/status regardless of
    # which backend is currently active. Lets the UI tell the operator at a
    # glance which providers are usable.
    anthropic_api_key: str = ""
    anthropic_model_id: str = "claude-opus-4-7-20260301"  # latest as of 2026-05; override via env when newer ships
    anthropic_max_tokens: int = Field(default=2048, ge=64, le=8192)
    anthropic_timeout_seconds: float = Field(default=120.0, ge=5.0)

    # --- OpenAI (placeholder for a future backend) ---
    openai_api_key: str = ""

    # --- Qwen-VL specific. Read only by the qwen backend. ---
    qwen_model_id: str = "Qwen/Qwen2.5-VL-3B-Instruct"
    qwen_device: str = "auto"
    qwen_dtype: str = "auto"
    qwen_max_new_tokens: int = Field(default=2048, ge=64, le=8192)


settings = Settings()
