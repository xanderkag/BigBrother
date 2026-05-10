"""Qwen2.5-VL backend.

Lazy-imports torch/transformers so the stub-only image doesn't need them.
First instantiation downloads weights to HF_HOME (default /app/.hf-cache);
size ranges from ~7GB (3B) to ~30GB (72B).

The four domain methods all funnel through the same chat-style call to
the model. Prompts are domain-specific text templates (see prompts/), the
model is asked for JSON, and we extract+validate the JSON before returning.
On parse failure we report the issue rather than letting a downstream
client crash.
"""

import base64  # noqa: F401  — kept for symmetry with future helpers
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

log = logging.getLogger("inference-service.qwen")


class QwenVlBackend(ModelBackend):
    name = "qwen-vl"

    def __init__(
        self,
        model_id: str,
        device: str = "auto",
        dtype: str = "auto",
        max_new_tokens: int = 2048,
    ) -> None:
        self.model_id = model_id
        self.device = device
        self.dtype = dtype
        self.max_new_tokens = max_new_tokens
        self._ready = False
        self._model: Any = None
        self._processor: Any = None
        self._load()

    def _load(self) -> None:
        log.info("loading Qwen2.5-VL: %s", self.model_id)
        # Imports kept inside to avoid pulling torch into the stub image.
        from transformers import (  # type: ignore[import-not-found]
            AutoProcessor,
            Qwen2_5_VLForConditionalGeneration,
        )

        self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            self.model_id,
            torch_dtype=self.dtype if self.dtype != "auto" else "auto",
            device_map=self.device,
        )
        self._processor = AutoProcessor.from_pretrained(self.model_id)
        self._ready = True
        log.info("Qwen2.5-VL ready")

    def is_ready(self) -> bool:
        return self._ready

    # --- Domain methods ---

    async def classify(self, text: str) -> ClassifyResponse:
        prompt = classify_prompts.build(text)
        raw = await self._generate_text(prompt)
        data = _parse_json(raw)
        if data is None:
            return ClassifyResponse(type=None, confidence=0.0)
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
        raw = await self._generate_text(prompt)
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
        instruction = prompt or (
            "Прочитай и точно перепиши весь видимый текст на изображении. "
            "Сохрани переносы строк и структуру таблиц (используй | для столбцов). "
            "Не комментируй, выводи только текст."
        )
        text = await self._generate_with_image(image, instruction)
        # Confidence isn't directly available from a generative VLM; return
        # a moderate default. doc-service combines this with parser-side score.
        return VisionResponse(text=text, confidence=0.7)

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
    ) -> VerifyResponse:
        prompt = verify_prompts.build(extracted=extracted, raw_text=raw_text)
        raw = await self._generate_text(prompt)
        data = _parse_json(raw) or {}
        normalized = data.get("extracted") if isinstance(data.get("extracted"), dict) else extracted
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        return VerifyResponse(extracted=normalized or extracted, issues=[str(i) for i in issues])

    # --- Generation primitives ---

    async def _generate_text(self, prompt: str) -> str:
        return await self._generate_with_messages(
            [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            images=None,
        )

    async def _generate_with_image(self, image: Image.Image, instruction: str) -> str:
        return await self._generate_with_messages(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": instruction},
                    ],
                }
            ],
            images=[image],
        )

    async def _generate_with_messages(
        self,
        messages: list[dict[str, Any]],
        images: list[Image.Image] | None,
    ) -> str:
        from qwen_vl_utils import process_vision_info  # type: ignore[import-not-found]
        import torch  # type: ignore[import-not-found]

        text = self._processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        image_inputs, video_inputs = process_vision_info(messages)
        inputs = self._processor(
            text=[text],
            images=image_inputs if images else None,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        )
        # Move tensors to the model's device. accelerate's device_map="auto"
        # places different layers on different devices for big models, but
        # the input tensors live on the embedding layer's device.
        inputs = {k: v.to(self._model.device) if hasattr(v, "to") else v for k, v in inputs.items()}

        with torch.no_grad():
            output_ids = self._model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
            )
        generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
        out = self._processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        return out.strip()


def _parse_json(text: str) -> dict[str, Any] | None:
    """Extract a JSON object from a model's free-form output.

    Models often wrap JSON in markdown code fences or add prose around it.
    Strategy: try strict parse first, then locate the outermost {...} block
    and parse that.
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
