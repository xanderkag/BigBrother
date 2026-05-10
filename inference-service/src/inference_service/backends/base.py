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
    ) -> ExtractResponse:
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
