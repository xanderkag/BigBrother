from abc import ABC, abstractmethod
from typing import Any

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
    """

    name: str

    @abstractmethod
    def is_ready(self) -> bool:
        """True once the backend can serve requests (weights loaded, etc.)."""

    @abstractmethod
    async def classify(self, text: str) -> ClassifyResponse:
        ...

    @abstractmethod
    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
    ) -> ExtractResponse:
        """Извлечь структурированные данные из текста.

        `prompt_override`: если задан, заменяет встроенный prompt
        (`prompts/extract.build()`). Используется когда админ через UI
        document_types настроил кастомную инструкцию для своего типа
        документа. Backend сам решает, как использовать override —
        обычно: «вставить как system prompt, к нему прилепить text+schema».
        """
        ...

    @abstractmethod
    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
    ) -> VisionResponse:
        ...

    @abstractmethod
    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
    ) -> VerifyResponse:
        ...
