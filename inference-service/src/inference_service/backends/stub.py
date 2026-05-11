"""Deterministic stub backend.

Goal: let doc-service (and CI) exercise the full pipeline end-to-end
without GPU, model downloads, or non-determinism. Behaviour intentionally
mirrors what a real VLM would return *for trivial cases*: it can detect
keyword-classifiable documents, parrot text from /vision-ocr (returning a
recognizable placeholder), and pass-through /verify.

This is NOT a serious extractor — never use it in production.
"""

import re
from typing import Any

from ..schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend

# Same rules as doc-service's KeywordClassifier. Duplicated deliberately —
# coupling the services through shared code is a worse problem than the
# duplication, and these few lines rarely change.
_RULES: list[tuple[str, re.Pattern[str], float]] = [
    ("UPD", re.compile(r"универсальный\s+передаточный\s+документ|\bУПД\b", re.IGNORECASE), 0.95),
    ("CMR", re.compile(r"\bCMR\b|международная\s+товарно-транспортная", re.IGNORECASE), 0.95),
    ("TTN", re.compile(r"транспортная\s+накладная|товарно-транспортная\s+накладная|\bТТН\b", re.IGNORECASE), 0.95),
    ("factInvoice", re.compile(r"счет-фактура|счёт-фактура", re.IGNORECASE), 0.95),
    ("AKT", re.compile(r"\bакт\b\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании", re.IGNORECASE), 0.9),
    ("invoice", re.compile(r"\bсч[её]т\s+на\s+оплату\b|\bсч[её]т\s+№", re.IGNORECASE), 0.85),
    ("invoice", re.compile(r"\bсч[её]т\b", re.IGNORECASE), 0.6),
]


class StubBackend(ModelBackend):
    name = "stub"

    def is_ready(self) -> bool:
        return True

    async def classify(self, text: str) -> ClassifyResponse:
        head = text[:4000]
        best: tuple[str, float] | None = None
        for kind, rx, weight in _RULES:
            if rx.search(head) and (best is None or weight > best[1]):
                best = (kind, weight)
        if best is None:
            return ClassifyResponse(type=None, confidence=0.0)
        return ClassifyResponse(type=best[0], confidence=best[1])  # type: ignore[arg-type]

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
    ) -> ExtractResponse:
        # The stub returns an empty extract with a "stub mode" issue so
        # callers know real extraction did not happen but the contract held.
        # `prompt_override` echoed in issues so интеграционные тесты могут
        # убедиться, что override доехал до самого backend'а.
        note = f"stub backend cannot extract (hint={hint}"
        if prompt_override:
            note += f", prompt_override len={len(prompt_override)}"
        note += ")"
        return ExtractResponse(extracted={}, confidence=0.0, issues=[note])

    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
    ) -> VisionResponse:
        # Return a placeholder so downstream code can be tested for shape.
        # Confidence is deliberately low so the doc-service router knows
        # this is not real OCR output.
        return VisionResponse(
            text=f"[stub vision-ocr: {len(image_bytes)} bytes received]",
            confidence=0.1,
        )

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
    ) -> VerifyResponse:
        # Pass-through: real verify would normalize dates, money, etc.
        return VerifyResponse(extracted=extracted, issues=[])
