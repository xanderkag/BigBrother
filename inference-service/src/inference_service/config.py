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

    # A1 (2026-05-19): hard cap on simultaneous model calls
    # (extract/classify/vision/verify); set per backend rate limit / GPU
    # capacity. 0 disables (no admission control). Callers wait inside the
    # semaphore — we don't 503 early, because upstream doc-service BullMQ
    # already has its own concurrency limit (default 2) and would just retry.
    max_concurrent_calls: int = Field(default=16, ge=0)

    # A1 (2026-05-19): route-level admission gate. В отличие от
    # `max_concurrent_calls` (backend-уровневый семафор, queues), этот гейт
    # **rejects** запросы выше лимита — отдаёт `503 Retry-After: 2`,
    # чтобы upstream видел saturation сразу, а не висел на `await sem`.
    # Default 8 ≈ 2x BullMQ concurrency (4 worker'а x 2 in-flight) с
    # запасом на бурсты. 0 — отключить гейт (для совместимости / dev).
    max_concurrent_inflight: int = Field(default=8, ge=0)

    # Активный backend. `openai_compat` — универсальный клиент к любому
    # OpenAI-API-совместимому серверу (Ollama, vLLM, llama.cpp, LM Studio,
    # OpenAI proper). Это **предпочтительный путь** для локальных моделей:
    # одна реализация, любой движок инференса. `qwen` оставлен для тех,
    # кто всё ещё хочет грузить transformers внутри сервиса.
    backend: Literal["stub", "claude", "openai", "openai_compat", "qwen"] = "stub"

    # --- Anthropic / Claude ---
    # API key is read separately from the backend selection because we report
    # "configured" / "not configured" via /v1/providers/status regardless of
    # which backend is currently active. Lets the UI tell the operator at a
    # glance which providers are usable.
    anthropic_api_key: str = ""
    anthropic_model_id: str = "claude-opus-4-7-20260301"  # latest as of 2026-05; override via env when newer ships
    anthropic_max_tokens: int = Field(default=2048, ge=64, le=8192)
    anthropic_timeout_seconds: float = Field(default=120.0, ge=5.0)

    # --- OpenAI / OpenAI-compatible (universal) ---
    # Используется и для `backend=openai` (cloud OpenAI), и для
    # `backend=openai_compat` (любой локальный или альтернативный сервер).
    #
    # Конкретные пресеты:
    #   OpenAI cloud:
    #     OPENAI_BASE_URL=                   # пусто — SDK ходит на api.openai.com
    #     OPENAI_MODEL=gpt-4o-mini
    #     OPENAI_API_KEY=sk-...
    #
    #   Ollama (dev, локально):
    #     OPENAI_BASE_URL=http://ollama:11434/v1
    #     OPENAI_MODEL=qwen2.5-vl:7b  # или llama3.2-vision:11b, minicpm-v
    #     OPENAI_API_KEY=               # не нужен; SDK подставит placeholder
    #
    #   vLLM (prod GPU):
    #     OPENAI_BASE_URL=http://vllm:8000/v1
    #     OPENAI_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
    #
    #   LM Studio (с хоста):
    #     OPENAI_BASE_URL=http://host.docker.internal:1234/v1
    #     OPENAI_MODEL=qwen2.5-vl
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_max_tokens: int = Field(default=2048, ge=64, le=16384)
    openai_timeout_seconds: float = Field(default=120.0, ge=5.0)

    # --- Qwen-VL specific. Read only by the qwen backend. ---
    # Tip: для локального инференса лучше использовать `backend=openai_compat`
    # + Ollama (см. docker-compose.local-models.yml). Этот путь оставлен для
    # совместимости с теми, кому нужен transformers напрямую (например,
    # custom-fine-tune Qwen).
    qwen_model_id: str = "Qwen/Qwen2.5-VL-3B-Instruct"
    qwen_device: str = "auto"
    qwen_dtype: str = "auto"
    qwen_max_new_tokens: int = Field(default=2048, ge=64, le=8192)

    # --- ASR (speech-to-text) — «OCR for audio» ---
    # ASR — это просто ещё один способ превратить вход в ТЕКСТ, после чего
    # downstream-пайплайн (classify → extract → validate) не меняется.
    #
    # Модель-агностично и endpoint-конфигурируемо: транскрайбер ходит на
    # **внешний** OpenAI-совместимый ASR-сервер по контракту
    # `POST {ASR_BASE_URL}/audio/transcriptions` (multipart, returns `{text}`).
    # Так говорят большинство локальных ASR-серверов (faster-whisper-server,
    # whisper.cpp server, vLLM-whisper, и т.п.). «Простая модель на сервере»,
    # которую развернут в другом окружении, реализует ровно этот контракт —
    # тогда подключение = только env, без правок кода.
    #
    # Гейтинг:
    #   - asr_enabled=false (default) → /v1/transcribe отвечает 503, ничего
    #     не меняется в остальном сервисе.
    #   - asr_base_url пустой → транскрайбер `is_available()=false`, даже если
    #     флаг включён (404/503 с понятной причиной).
    #
    # Ключ обычно НЕ нужен для локального сервера — оставляем пустым.
    # Примеры:
    #   faster-whisper-server (локально, dev):
    #     ASR_ENABLED=true
    #     ASR_BASE_URL=http://faster-whisper:8000/v1
    #     ASR_MODEL=Systran/faster-whisper-large-v3
    #   GigaAM / кастомный сервер (прод, другое окружение):
    #     ASR_BASE_URL=http://asr-server:9000/v1
    #     ASR_MODEL=gigaam
    asr_enabled: bool = False
    asr_base_url: str = ""
    asr_model: str = ""
    asr_api_key: str = ""
    asr_timeout_seconds: float = Field(default=300.0, ge=5.0)


settings = Settings()
