"""Deterministic stub backend.

Goal: let doc-service (and CI) exercise the full pipeline end-to-end
without GPU, model downloads, or non-determinism. Behaviour intentionally
mirrors what a real VLM would return *for trivial cases*: it can detect
keyword-classifiable documents, parrot text from /vision-ocr (returning a
recognizable placeholder), and pass-through /verify.

This is NOT a serious extractor — never use it in production.
"""

import json
import os
import re
from pathlib import Path
from typing import Any

from ..schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend


def _load_classifier_rules() -> list[tuple[str, re.Pattern[str], float]]:
    """Load classifier rules from shared/classifier-rules.json (A6 fix).

    Search order:
      1. CLASSIFIER_RULES_PATH env var — Docker override / custom mount.
      2. Relative to __file__: repo_root/shared/ (works in dev/CI where the
         full repo checkout is available).
      3. Hardcoded fallback (Docker without shared/ mount; stub is never used
         in production so this path doesn't matter for real data).
    """
    candidates: list[Path] = []
    if env_path := os.getenv("CLASSIFIER_RULES_PATH"):
        candidates.append(Path(env_path))
    # Dev/CI: __file__ is inside repo at inference-service/src/…/backends/stub.py
    # parents[4] = repo root (backends → inference_service → src → inference-service → repo)
    candidates.append(Path(__file__).parents[4] / "shared" / "classifier-rules.json")

    for path in candidates:
        if path.exists():
            try:
                raw: list[dict[str, object]] = json.loads(path.read_text("utf-8"))
                return [
                    (str(r["slug"]), re.compile(str(r["pattern"]), re.IGNORECASE), float(str(r["weight"])))
                    for r in raw
                ]
            except (KeyError, ValueError):
                pass  # malformed JSON — try next candidate

    # Hardcoded fallback — kept in sync with shared/classifier-rules.json.
    # If you update the JSON, update this list too (and vice versa).
    return [
        ("UPD",         re.compile(r"универсальный\s+передаточный\s+документ|\bУПД\b", re.IGNORECASE), 1.0),
        ("CMR",         re.compile(r"\bCMR\b|международная\s+товарно-транспортная", re.IGNORECASE), 1.0),
        ("TTN",         re.compile(r"транспортная\s+накладная|товарно-транспортная\s+накладная|\bТТН\b", re.IGNORECASE), 1.0),
        ("factInvoice", re.compile(r"счет-фактура|счёт-фактура", re.IGNORECASE), 1.0),
        ("AKT",         re.compile(r"\bакт\b\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании", re.IGNORECASE), 0.95),
        ("invoice",     re.compile(r"\bсч[её]т\s+на\s+оплату\b|\bсч[её]т\s+№", re.IGNORECASE), 0.9),
        ("invoice",     re.compile(r"\bсч[её]т\b", re.IGNORECASE), 0.6),
    ]


_RULES: list[tuple[str, re.Pattern[str], float]] = _load_classifier_rules()


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
        include_debug: bool = False,
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
