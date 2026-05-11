"""OpenAI-compatible backend — универсальный клиент к любому inference-серверу,
выставляющему OpenAI Chat Completions API.

Покрывает разом:
    - **Ollama** (`http://ollama:11434/v1`) — самый дружелюбный путь для
      dev-стенда. `ollama pull qwen2.5-vl:7b` + всё работает на CPU/Metal/CUDA.
    - **vLLM** (`http://vllm:8000/v1`) — production GPU serving с high
      throughput и continuous batching.
    - **llama.cpp** (`http://llama-cpp:8080/v1`) — CPU-only quantized, для
      минимального железа.
    - **LM Studio** (`http://host.docker.internal:1234/v1`) — desktop GUI,
      удобно «потыкать» модель с UI оператора.
    - **OpenAI proper** (без `base_url`) — если кто-то всё-таки хочет
      облако.

Поскольку SDK — официальный openai-python, image input ('image_url' с
data URL) кодируется автоматически. JSON-режим (`response_format`) тоже
включается легко, что важно для extract'а: chat-модель должна вернуть
**только** JSON.

Готовность (`is_ready()`): мы не проверяем коннект на старте — это
сделало бы провайдер «not_ready» до первого запроса. Вместо этого
считаем готовым, если задан `base_url`. Реальные ошибки коннекта
поднимаются на конкретном вызове, и инфра-уровень дальше делает
retry / показывает админу.
"""

import asyncio
import base64
import io
import json
import logging
import re
import time
from typing import Any

from PIL import Image

from ..prompts import classify as classify_prompts
from ..prompts import extract as extract_prompts
from ..prompts import verify as verify_prompts
from ..schemas import (
    ClassifyResponse,
    ExtractDebug,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend

log = logging.getLogger("inference-service.openai-compat")


class OpenAICompatibleBackend(ModelBackend):
    """Один backend под все OpenAI-API-совместимые серверы.

    Ключевые параметры:
        base_url: URL без `/chat/completions` суффикса — SDK добавляет
                  его сам. Например, `http://ollama:11434/v1`. Если
                  пусто — SDK ходит в `https://api.openai.com/v1`.
        model:    идентификатор модели в этом сервере. Ollama: `llama3.2-vision:11b`,
                  vLLM: `Qwen/Qwen2.5-VL-7B-Instruct`, OpenAI: `gpt-4o-mini`.
        api_key:  для большинства локальных серверов можно `'sk-no-key'`
                  или вообще не нужен — но openai SDK требует не-пустой.
                  По умолчанию ставим placeholder, чтобы Ollama жил без
                  настройки.
    """

    name = "openai-compat"

    # Probe TTL — реальный пинг сервера дорогой (HTTP round-trip), часто
    # дёргать /ready не нужно. 30 секунд достаточно: модель в Ollama не
    # выгрузится быстрее, а если упала — узнаем в следующем окне.
    _PROBE_TTL_SECONDS = 30.0

    def __init__(
        self,
        base_url: str,
        model_id: str,
        api_key: str = "",
        max_tokens: int = 2048,
        timeout_seconds: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/") or ""
        self.model_id = model_id
        # openai SDK падает на пустой строке. Большинство локальных
        # серверов не проверяет токен, так что подставляем плейсхолдер.
        self.api_key = api_key or "sk-local-no-key"
        self.max_tokens = max_tokens
        self.timeout_seconds = timeout_seconds
        self._client: Any = None
        self._ready = False
        # Кэш для probe() — async-результат + момент последнего успеха.
        self._probe_cache: tuple[bool, str | None, float] | None = None
        self._probe_lock = asyncio.Lock()
        if model_id:
            self._load()
        else:
            log.warning("OpenAICompatibleBackend: model_id empty; backend will be not_ready")

    def _load(self) -> None:
        try:
            # Async SDK — у нас FastAPI/async pipeline, синхронные
            # вызовы блокировали бы event loop на каждый /extract.
            from openai import AsyncOpenAI  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "OpenAICompatibleBackend requires the `openai` package (>=1.0). "
                "Install with `pip install openai` (it's in requirements.txt)."
            ) from e

        # base_url пустой → OpenAI облако; иначе локальный сервер.
        kwargs: dict[str, Any] = {"api_key": self.api_key, "timeout": self.timeout_seconds}
        if self.base_url:
            kwargs["base_url"] = self.base_url
        self._client = AsyncOpenAI(**kwargs)
        self._ready = True
        log.info(
            "OpenAICompatibleBackend ready: base_url=%s model=%s",
            self.base_url or "<openai-default>",
            self.model_id,
        )

    def is_ready(self) -> bool:
        """Структурная готовность: задана модель, клиент создан. НЕ говорит
        о реальном коннекте — для этого probe()."""
        return self._ready

    async def probe(self) -> tuple[bool, str | None]:
        """Реальный пинг сервера: пытается дёрнуть `models.list()` со
        своим api_key и base_url. Возвращает (ok, error_message).

        Используется readiness-пробником `/ready`, чтобы клиентский UI и
        Kubernetes-orchestrator видели не «backend задан», а «модель
        правда отвечает». Результат кэшируется на 30 секунд.

        Под капотом большинство OpenAI-compat серверов экспонируют
        `/v1/models` (Ollama, vLLM, llama.cpp ≥0.3, LM Studio).
        Cтарый llama.cpp может ответить 404 — обрабатываем как failure.
        """
        if not self._ready:
            return False, "backend not configured (empty model_id)"

        now = time.monotonic()
        if self._probe_cache:
            ok, err, at = self._probe_cache
            if now - at < self._PROBE_TTL_SECONDS:
                return ok, err

        # Lock, чтобы 10 параллельных /ready не дёргали бэкенд 10 раз.
        async with self._probe_lock:
            if self._probe_cache:
                ok, err, at = self._probe_cache
                if time.monotonic() - at < self._PROBE_TTL_SECONDS:
                    return ok, err

            try:
                # Короткий timeout — на проверке здоровья ждать минуту глупо.
                models = await asyncio.wait_for(self._client.models.list(), timeout=5.0)
                # Опционально: убедимся, что наша модель есть в списке.
                # Не делаем этого жёстко: Ollama иногда возвращает странные
                # имена, OpenAI cloud — сотни моделей с шумом. Достаточно
                # факта, что сервер ответил.
                _ = models  # consume
                self._probe_cache = (True, None, time.monotonic())
                return True, None
            except asyncio.TimeoutError:
                msg = f"probe timeout (5s) — сервер {self.base_url or '<openai>'} не отвечает"
                self._probe_cache = (False, msg, time.monotonic())
                return False, msg
            except Exception as e:  # noqa: BLE001
                msg = f"probe failed: {type(e).__name__}: {e}"
                self._probe_cache = (False, msg, time.monotonic())
                return False, msg

    # --- Domain methods ---

    async def classify(self, text: str) -> ClassifyResponse:
        prompt = classify_prompts.build(text)
        raw = await self._complete_text(prompt, json_mode=True)
        data = _parse_json(raw) or {}
        type_value = data.get("type") if isinstance(data.get("type"), str) else None
        confidence = float(data.get("confidence", 0.0) or 0.0)
        return ClassifyResponse(type=type_value, confidence=_clamp01(confidence))  # type: ignore[arg-type]

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
        include_debug: bool = False,
    ) -> ExtractResponse:
        prompt = extract_prompts.build(
            text=text, schema=schema, hint=hint, prompt_override=prompt_override
        )
        raw = await self._complete_text(prompt, json_mode=True)
        data = _parse_json(raw) or {}
        extracted = data.get("extracted") if isinstance(data.get("extracted"), dict) else {}
        confidence = float(data.get("confidence", 0.0) or 0.0)
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        debug = (
            ExtractDebug(prompt=prompt, raw_response=raw, model=self.model_id, backend=self.name)
            if include_debug
            else None
        )
        return ExtractResponse(
            extracted=extracted or {},
            confidence=_clamp01(confidence),
            issues=[str(i) for i in issues],
            debug=debug,
        )

    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
    ) -> VisionResponse:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        data_url = _image_to_data_url(image)
        instruction = prompt or (
            "Прочитай и точно перепиши весь видимый текст на изображении. "
            "Сохрани переносы строк и структуру таблиц (используй | для столбцов). "
            "Не комментируй, выводи только текст."
        )
        text = await self._complete_with_image(data_url, instruction)
        # OpenAI API не возвращает confidence — фиксированное значение,
        # которое doc-service комбинирует с парсер-уровневым.
        return VisionResponse(text=text, confidence=0.75)

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
    ) -> VerifyResponse:
        prompt = verify_prompts.build(extracted=extracted, raw_text=raw_text)
        raw = await self._complete_text(prompt, json_mode=True)
        data = _parse_json(raw) or {}
        normalized = data.get("extracted") if isinstance(data.get("extracted"), dict) else extracted
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        return VerifyResponse(extracted=normalized or extracted, issues=[str(i) for i in issues])

    # --- Generation primitives ---

    async def _complete_text(self, prompt: str, json_mode: bool = False) -> str:
        return await self._complete(
            [{"role": "user", "content": prompt}],
            json_mode=json_mode,
        )

    async def _complete_with_image(self, data_url: str, instruction: str) -> str:
        return await self._complete(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": instruction},
                    ],
                }
            ],
            json_mode=False,
        )

    async def _complete(
        self,
        messages: list[dict[str, Any]],
        json_mode: bool,
    ) -> str:
        # json_mode = response_format={"type": "json_object"} — поддерживают
        # все современные OpenAI-compat серверы (OpenAI, vLLM, Ollama 0.5+,
        # LM Studio). Если backend не поддерживает — упадёт 400; ловим и
        # пробуем без режима. Это даёт мягкую совместимость со старыми
        # llama.cpp-серверами.
        kwargs: dict[str, Any] = {
            "model": self.model_id,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": 0.0,  # детерминированно для классификации/извлечения
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            response = await self._client.chat.completions.create(**kwargs)
        except Exception as e:  # noqa: BLE001
            if json_mode and _looks_like_json_mode_not_supported(e):
                log.info("backend rejected response_format=json_object, retrying without")
                kwargs.pop("response_format", None)
                response = await self._client.chat.completions.create(**kwargs)
            else:
                raise

        choice = response.choices[0] if response.choices else None
        if choice is None or choice.message is None:
            return ""
        content = choice.message.content or ""
        return content.strip()


def _looks_like_json_mode_not_supported(err: Exception) -> bool:
    """Эвристика: упало из-за response_format=json_object?

    Полагаемся на текст ошибки, потому что разные серверы возвращают разные
    HTTP-коды (400/422/500). Если в сообщении упоминается json/response_format
    — повторяем без режима.
    """
    msg = str(err).lower()
    return any(kw in msg for kw in ("response_format", "json_object", "json mode"))


def _image_to_data_url(image: Image.Image) -> str:
    """Encode PIL image as a data URL (base64). JPEG for size.

    OpenAI vision API принимает либо публичный URL, либо data URL. Локальные
    серверы (Ollama, vLLM) поддерживают тот же формат.
    """
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=90, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _parse_json(text: str) -> dict[str, Any] | None:
    """Same parser as другие backends. JSON-mode не гарантирует чистый JSON
    у всех серверов (особенно при потоковой генерации), оставляем fallback."""
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
