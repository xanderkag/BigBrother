"""Claude (Anthropic) backend.

Uses the official `anthropic` Python SDK. The SDK handles retries, rate-
limit awareness, image input encoding, and streaming — much less plumbing
than wiring httpx by hand.

Behaviour matches the other backends: same `ModelBackend` interface, JSON
parsing helpers shared with `qwen_vl.py` would be nice but for now each
backend is self-contained. Prompts come from the same `prompts/` modules
so all backends share their wording — only the model invocation differs.

Authentication: requires `ANTHROPIC_API_KEY` env var. Without it,
`is_ready()` returns False and every call raises — `/v1/providers/status`
shows "not configured" so the UI can warn the operator before the first
real request lands.
"""

import base64
import io
import json
import logging
import re
from typing import Any

from PIL import Image

from ..prompts import classify as classify_prompts
from ..prompts import extract as extract_prompts
from ..prompts import verify as verify_prompts
from ..schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend

log = logging.getLogger("inference-service.claude")


class ClaudeBackend(ModelBackend):
    name = "claude"

    def __init__(
        self,
        api_key: str,
        model_id: str,
        max_tokens: int = 2048,
        timeout_seconds: float = 120.0,
    ) -> None:
        self.api_key = api_key
        self.model_id = model_id
        self.max_tokens = max_tokens
        self.timeout_seconds = timeout_seconds
        self._client: Any = None
        self._ready = False
        if api_key:
            self._load()
        else:
            log.warning("ClaudeBackend: ANTHROPIC_API_KEY is empty; backend will be not_ready")

    def _load(self) -> None:
        # Lazy import so the package isn't required for stub-only deployments.
        try:
            from anthropic import Anthropic  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "ClaudeBackend requires the `anthropic` package. "
                "Add it to requirements-claude.txt or install with `pip install anthropic`."
            ) from e
        self._client = Anthropic(api_key=self.api_key, timeout=self.timeout_seconds)
        self._ready = True
        log.info("ClaudeBackend ready: %s", self.model_id)

    def is_ready(self) -> bool:
        return self._ready

    # --- Domain methods ---

    async def classify(self, text: str) -> ClassifyResponse:
        prompt = classify_prompts.build(text)
        raw = await self._complete_text(prompt)
        data = _parse_json(raw) or {}
        type_value = data.get("type") if isinstance(data.get("type"), str) else None
        confidence = float(data.get("confidence", 0.0) or 0.0)
        return ClassifyResponse(type=type_value, confidence=_clamp01(confidence))  # type: ignore[arg-type]

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
    ) -> ExtractResponse:
        prompt = extract_prompts.build(text=text, schema=schema, hint=hint)
        raw = await self._complete_text(prompt)
        data = _parse_json(raw) or {}
        extracted = data.get("extracted") if isinstance(data.get("extracted"), dict) else {}
        confidence = float(data.get("confidence", 0.0) or 0.0)
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        return ExtractResponse(
            extracted=extracted or {},
            confidence=_clamp01(confidence),
            issues=[str(i) for i in issues],
        )

    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
    ) -> VisionResponse:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        media_type, image_b64 = _encode_image_for_claude(image)
        instruction = prompt or (
            "Прочитай и точно перепиши весь видимый текст на изображении. "
            "Сохрани переносы строк и структуру таблиц (используй | для столбцов). "
            "Не комментируй, выводи только текст."
        )
        text = await self._complete_with_image(media_type, image_b64, instruction)
        # Claude doesn't expose a confidence score; we report a moderate default
        # and let doc-service combine with parser-side confidence.
        return VisionResponse(text=text, confidence=0.75)

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
    ) -> VerifyResponse:
        prompt = verify_prompts.build(extracted=extracted, raw_text=raw_text)
        raw = await self._complete_text(prompt)
        data = _parse_json(raw) or {}
        normalized = data.get("extracted") if isinstance(data.get("extracted"), dict) else extracted
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        return VerifyResponse(extracted=normalized or extracted, issues=[str(i) for i in issues])

    # --- Generation primitives ---

    async def _complete_text(self, prompt: str) -> str:
        return await self._complete([{"role": "user", "content": prompt}])

    async def _complete_with_image(
        self,
        media_type: str,
        image_b64: str,
        instruction: str,
    ) -> str:
        return await self._complete(
            [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": instruction},
                    ],
                }
            ]
        )

    async def _complete(self, messages: list[dict[str, Any]]) -> str:
        # The Anthropic SDK is sync; we run it in a thread executor so we don't
        # block FastAPI's event loop on long generations. For higher throughput
        # under load, swap to the async client (`AsyncAnthropic`) — keeping
        # sync here for simpler error handling in the scaffold.
        import asyncio

        def _call() -> str:
            response = self._client.messages.create(
                model=self.model_id,
                max_tokens=self.max_tokens,
                messages=messages,
            )
            # Response content is a list of blocks; for text-only generation
            # it's typically one text block. Concatenate just in case.
            parts: list[str] = []
            for block in response.content:
                if getattr(block, "type", None) == "text":
                    parts.append(getattr(block, "text", ""))
            return "".join(parts).strip()

        return await asyncio.to_thread(_call)


def _encode_image_for_claude(image: Image.Image) -> tuple[str, str]:
    """Encode a PIL image into (media_type, base64-string) for Claude vision.

    Always JPEG-encode for size — Claude accepts PNG/GIF/WEBP but JPEG is
    smallest for typical document scans (white background + black text).
    """
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=90, optimize=True)
    return "image/jpeg", base64.b64encode(buf.getvalue()).decode("ascii")


def _parse_json(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from a model's free-form output.

    Same approach as qwen_vl.py — try strict parse, then locate the
    outermost {...} block. Keeps the two backends' output handling
    in lockstep even though their generation paths differ.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def _clamp01(x: float) -> float:
    if x != x:  # NaN guard
        return 0.0
    return max(0.0, min(1.0, x))
