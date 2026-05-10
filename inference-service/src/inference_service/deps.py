from functools import lru_cache

from .backends.base import ModelBackend
from .config import settings


@lru_cache(maxsize=1)
def get_backend() -> ModelBackend:
    """Lazy-loaded singleton backend.

    The Qwen backend imports torch + transformers, which we don't want to
    pull in for the stub. Imports stay inside the branches so the stub
    container can run without the heavy ML deps installed at all.
    """
    if settings.backend == "stub":
        from .backends.stub import StubBackend

        return StubBackend()

    if settings.backend == "qwen":
        from .backends.qwen_vl import QwenVlBackend

        return QwenVlBackend(
            model_id=settings.qwen_model_id,
            device=settings.qwen_device,
            dtype=settings.qwen_dtype,
            max_new_tokens=settings.qwen_max_new_tokens,
        )

    raise RuntimeError(f"unknown backend: {settings.backend}")
