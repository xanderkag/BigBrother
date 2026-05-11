from functools import lru_cache

from .backends.base import ModelBackend
from .config import settings


@lru_cache(maxsize=1)
def get_backend() -> ModelBackend:
    """Lazy-loaded singleton backend.

    Heavy backends (Qwen weights, OpenAI-compat connecting to remote
    server) import their SDKs inside the branch so the stub container can
    run without those deps at all.
    """
    if settings.backend == "stub":
        from .backends.stub import StubBackend

        return StubBackend()

    if settings.backend == "claude":
        from .backends.claude import ClaudeBackend

        return ClaudeBackend(
            api_key=settings.anthropic_api_key,
            model_id=settings.anthropic_model_id,
            max_tokens=settings.anthropic_max_tokens,
            timeout_seconds=settings.anthropic_timeout_seconds,
        )

    if settings.backend == "openai":
        # `openai` == cloud OpenAI без `base_url`. Используется тот же
        # OpenAICompatibleBackend — без base_url он ходит на api.openai.com.
        from .backends.openai_compatible import OpenAICompatibleBackend

        return OpenAICompatibleBackend(
            base_url="",
            model_id=settings.openai_model,
            api_key=settings.openai_api_key,
            max_tokens=settings.openai_max_tokens,
            timeout_seconds=settings.openai_timeout_seconds,
        )

    if settings.backend == "openai_compat":
        # Локальный или альтернативный OpenAI-совместимый сервер
        # (Ollama, vLLM, llama.cpp, LM Studio, SGLang, TGI, etc).
        from .backends.openai_compatible import OpenAICompatibleBackend

        return OpenAICompatibleBackend(
            base_url=settings.openai_base_url,
            model_id=settings.openai_model,
            api_key=settings.openai_api_key,
            max_tokens=settings.openai_max_tokens,
            timeout_seconds=settings.openai_timeout_seconds,
        )

    if settings.backend == "qwen":
        from .backends.qwen_vl import QwenVlBackend

        return QwenVlBackend(
            model_id=settings.qwen_model_id,
            device=settings.qwen_device,
            dtype=settings.qwen_dtype,
            max_new_tokens=settings.qwen_max_new_tokens,
        )

    raise RuntimeError(f"unknown backend: {settings.backend}")


def get_providers_status() -> dict[str, object]:
    """Snapshot of provider configuration for /v1/providers/status.

    Reports configured-ness (do we have credentials/weights?) separately
    from active-ness (is this the backend currently serving requests?).
    The operator UI uses both: configured providers are switch candidates,
    the active one is highlighted.

    No SDK initialisation here — this endpoint must respond in
    milliseconds even when Qwen would take minutes to load.
    """
    # openai_compat считается configured, если задан и base_url, и model.
    # base_url пустой → это «облачный OpenAI», его освещает запись
    # `openai`. Так что openai_compat = только локальные/альтернативные.
    openai_compat_configured = bool(settings.openai_base_url and settings.openai_model)
    return {
        "active": settings.backend,
        "available": {
            "stub": {
                "configured": True,
                "model": None,
                "description": "Deterministic fallback. CI/dev only — no real inference.",
            },
            "claude": {
                "configured": bool(settings.anthropic_api_key),
                "model": settings.anthropic_model_id if settings.anthropic_api_key else None,
                "description": "Anthropic Claude via API. Requires ANTHROPIC_API_KEY.",
            },
            "openai": {
                "configured": bool(settings.openai_api_key) and not settings.openai_base_url,
                "model": settings.openai_model if settings.openai_api_key else None,
                "description": (
                    "OpenAI cloud (api.openai.com). Requires OPENAI_API_KEY. "
                    "Если задан OPENAI_BASE_URL — конфиг попадёт в openai_compat вместо."
                ),
            },
            "openai_compat": {
                "configured": openai_compat_configured,
                "model": settings.openai_model if openai_compat_configured else None,
                "description": (
                    "OpenAI-совместимый локальный сервер: Ollama / vLLM / llama.cpp / LM Studio. "
                    "Требует OPENAI_BASE_URL + OPENAI_MODEL. Лучший путь для локальных моделей."
                ),
            },
            "qwen": {
                "configured": True,  # weights resolved at runtime; no API key needed
                "model": settings.qwen_model_id,
                "description": (
                    "Qwen-VL напрямую через transformers. Требует GPU + [qwen] extras. "
                    "Для большинства задач предпочтительнее backend=openai_compat + Ollama/vLLM."
                ),
            },
        },
    }
