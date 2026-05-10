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

    backend: Literal["stub", "qwen"] = "stub"

    # Qwen-VL specific. Read only by the qwen backend.
    qwen_model_id: str = "Qwen/Qwen2.5-VL-3B-Instruct"
    qwen_device: str = "auto"
    qwen_dtype: str = "auto"
    qwen_max_new_tokens: int = Field(default=2048, ge=64, le=8192)


settings = Settings()
