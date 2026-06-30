import asyncio
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from ..config import settings
from ..metrics import inflight_calls
from ..schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)


class ModelBackend(ABC):
    """Backend contract — every implementation maps the four domain tasks
    to whatever underlying model/inference path it uses (Qwen-VL via
    transformers, OpenAI API, llama-cpp, deterministic stub, etc.).

    Routes never see the underlying model; swapping backends is a one-line
    change in deps.get_backend.

    Admission control (A1, 2026-05-19): each backend instance holds an
    `asyncio.Semaphore` capping concurrent expensive calls (extract /
    classify / vision_ocr / verify). Cheap probes (`is_ready`, the
    `/v1/providers/status` snapshot, `/health`) bypass. Size comes from
    `settings.max_concurrent_calls`; 0 disables the cap. The doc-service
    BullMQ worker upstream already has its own concurrency (default 2),
    so this caps the join — callers wait inside the semaphore rather than
    receive 503, matching the long-tail (30-90s) latency profile of real
    extracts.

    Different backends have different natural concurrency limits
    (Anthropic API rate limit vs local Qwen GPU slot count); subclasses
    are free to override `_make_semaphore` if they need a tighter cap.
    """

    name: str

    def _make_semaphore(self) -> asyncio.Semaphore | None:
        """Override in subclasses for per-backend tuning. Default reads the
        shared cap from settings. Return None to disable."""
        n = settings.max_concurrent_calls
        if n <= 0:
            return None
        return asyncio.Semaphore(n)

    def _get_semaphore(self) -> asyncio.Semaphore | None:
        """Lazy per-instance semaphore accessor.

        Lazy because (a) we don't force every subclass to call
        `super().__init__()` (the stub backend has no __init__), and (b)
        `asyncio.Semaphore` ideally lives on the running event loop —
        creating it on first use avoids cross-loop weirdness in tests that
        spin up their own loop.
        """
        # `__dict__` check — not `hasattr` — so we don't pick up a
        # class-level attribute and end up sharing across instances.
        if "_sem" not in self.__dict__:
            self._sem = self._make_semaphore()
        return self._sem

    @asynccontextmanager
    async def _admit(self) -> AsyncIterator[None]:
        """Acquire one admission slot for an expensive call; report inflight
        gauge. No-op fast path when the semaphore is disabled (size=0)."""
        sem = self._get_semaphore()
        gauge = inflight_calls.labels(backend=self.name)
        if sem is None:
            gauge.inc()
            try:
                yield
            finally:
                gauge.dec()
            return
        async with sem:
            gauge.inc()
            try:
                yield
            finally:
                gauge.dec()

    @abstractmethod
    def is_ready(self) -> bool:
        """True once the backend can serve requests (weights loaded, etc.)."""

    @abstractmethod
    async def classify(
        self,
        text: str,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
    ) -> ClassifyResponse:
        ...

    @abstractmethod
    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
        include_debug: bool = False,
        model_override: str | None = None,
        image_base64: str | None = None,
        reasoning_effort: str | None = None,
    ) -> ExtractResponse:
        """Извлечь структурированные данные из текста.

        `prompt_override`: если задан, заменяет встроенный prompt
        (`prompts/extract.build()`). Используется когда админ через UI
        document_types настроил кастомную инструкцию для своего типа
        документа. Backend сам решает, как использовать override —
        обычно: «вставить как system prompt, к нему прилепить text+schema».

        `image_base64`: если задан И backend поддерживает vision —
        extract строит multimodal-сообщение (изображение + extract-prompt)
        и модель извлекает поля напрямую из картинки. Text-only backends
        (или backend без vision) игнорируют параметр и работают по тексту.

        `include_debug`: если true, заполняет `ExtractResponse.debug`
        финальным prompt'ом и сырым ответом модели. Используется
        doc-service'ом для job-debug трассы в UI. Бэкенды без реальной
        LLM (stub) могут оставлять debug=None.
        """
        ...

    @abstractmethod
    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
        model_override: str | None = None,
    ) -> VisionResponse:
        ...

    @abstractmethod
    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
    ) -> VerifyResponse:
        ...
