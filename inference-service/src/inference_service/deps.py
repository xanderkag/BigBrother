from functools import lru_cache

from .backends.base import ModelBackend
from .config import settings


@lru_cache(maxsize=1)
def get_backend() -> ModelBackend:
    """Lazy-loaded singleton backend.

    Heavy backends (Qwen weights, future OpenAI) import their SDKs inside
    the branch so the stub container can run without those deps at all.
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
        # Placeholder — OpenAI backend lands in Phase 3.
        raise RuntimeError("openai backend not implemented yet; see TECH_DEBT")

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
                "configured": bool(settings.openai_api_key),
                "model": None,
                "description": "OpenAI (placeholder — backend not implemented yet).",
            },
            "qwen": {
                "configured": True,  # weights resolved at runtime; no API key needed
                "model": settings.qwen_model_id,
                "description": "Local Qwen-VL via transformers. Requires GPU + [qwen] extras.",
            },
        },
    }
