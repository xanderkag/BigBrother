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

from ..config import settings
from ..prompts import classify as classify_prompts
from ..prompts import extract as extract_prompts
from ..prompts import verify as verify_prompts
from ..prompts.response import normalize_extract_response
from ..schemas import (
    ClassifyResponse,
    ExtractDebug,
    Usage,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend

log = logging.getLogger("inference-service.openai-compat")


def _usage_of(u: dict[str, int] | None) -> Usage | None:
    """OpenAI-usage → наш Usage. None = сервер не вернул usage (не выдумываем нули)."""
    if not u:
        return None
    return Usage(prompt_tokens=u.get("prompt_tokens"), output_tokens=u.get("completion_tokens"))


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

    async def classify(
        self,
        text: str,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
        catalog: str | None = None,
        file_name: str | None = None,
        keyword_hint: str | None = None,
        max_tokens: int | None = None,
    ) -> ClassifyResponse:
        # Catalog-режим: динамический список типов, модель возвращает голый slug.
        # Не JSON-режим — reasoning-модели надёжнее выдают короткий slug plaintext.
        if catalog:
            messages = classify_prompts.build_catalog_messages(
                text=text,
                catalog=catalog,
                file_name=file_name,
                keyword_hint=keyword_hint,
            )
            async with self._admit():
                raw, usage = await self._complete_with_usage(
                    messages,
                    json_mode=False,
                    model_override=model_override,
                    reasoning_effort=reasoning_effort,
                    max_tokens=max_tokens or 30,
                )
            slug = _extract_slug(raw)
            # confidence: голый slug не несёт числа. Возвращаем 1.0 когда модель
            # выбрала тип (детерминированный temp=0 выбор), 0.0 на unknown/пусто.
            # doc-service всё равно валидирует slug по каталогу и решает финально.
            conf = 0.0 if (slug is None or slug == "unknown") else 1.0
            return ClassifyResponse(type=slug, confidence=conf, usage=_usage_of(usage))

        prompt = classify_prompts.build(text)
        async with self._admit():
            raw, usage = await self._complete_text_with_usage(
                prompt,
                json_mode=True,
                model_override=model_override,
                reasoning_effort=reasoning_effort,
            )
        data = _parse_json(raw) or {}
        type_value = data.get("type") if isinstance(data.get("type"), str) else None
        confidence = _safe_float(data.get("confidence"))
        return ClassifyResponse(type=type_value, confidence=_clamp01(confidence), usage=_usage_of(usage))  # type: ignore[arg-type]

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
        prompt = extract_prompts.build(
            text=text, schema=schema, hint=hint, prompt_override=prompt_override
        )
        async with self._admit():
            started = time.monotonic()
            if image_base64:
                # extraction-from-image: тот же extract-prompt + схема, но
                # модель видит изображение страницы и извлекает поля напрямую
                # из картинки. json_mode остаётся включённым — структурный
                # JSON на выходе. Сообщение строим как в vision_ocr
                # (image_url content-block), но с extract-инструкцией.
                data_url = _decoded_image_to_data_url(image_base64)
                messages: list[dict[str, Any]] = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": data_url}},
                            {"type": "text", "text": prompt},
                        ],
                    }
                ]
                raw, usage = await self._complete_with_usage(
                    messages,
                    json_mode=True,
                    model_override=model_override,
                    reasoning_effort=reasoning_effort,
                )
            else:
                # Версия _complete_text с usage: возвращает (text, usage_dict | None).
                raw, usage = await self._complete_text_with_usage(
                    prompt,
                    json_mode=True,
                    model_override=model_override,
                    reasoning_effort=reasoning_effort,
                )
            duration_ms = int((time.monotonic() - started) * 1000)
        # Восстанавливаем потерянную обёртку `extracted` + канонизируем stray-ключи
        # (phi4 теряет конверт / изобретает invoice_details.* — bench 2026-05-25).
        data = normalize_extract_response(_parse_json(raw) or {})
        extracted = data.get("extracted") if isinstance(data.get("extracted"), dict) else {}
        confidence = _safe_float(data.get("confidence"))
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        # F2: per-field confidence (см. claude.py для подробностей).
        raw_fc = data.get("field_confidence")
        field_confidence: dict[str, float] = {}
        if isinstance(raw_fc, dict):
            for k, v in raw_fc.items():
                if not isinstance(k, str):
                    continue
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    continue
                if 0.0 <= f <= 1.0:
                    field_confidence[k] = f
        if field_confidence and isinstance(extracted, dict):
            extracted["_field_confidence"] = field_confidence
        debug = (
            ExtractDebug(
                prompt=prompt,
                raw_response=raw,
                # Если был model_override — пишем в debug фактически
                # использованную модель, не self.model_id из env.
                model=model_override or self.model_id,
                backend=self.name,
                duration_ms=duration_ms,
                prompt_tokens=usage.get("prompt_tokens") if usage else None,
                output_tokens=usage.get("completion_tokens") if usage else None,
            )
            if include_debug
            else None
        )
        return ExtractResponse(
            extracted=extracted or {},
            confidence=_clamp01(confidence),
            field_confidence=field_confidence,
            issues=[str(i) for i in issues],
            debug=debug,
            # Токены — ВСЕГДА, не только при include_debug: иначе чанки multipass
            # (include_debug=False) невидимы и «токены/док» врут.
            usage=_usage_of(usage),
        )

    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
        model_override: str | None = None,
    ) -> VisionResponse:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        data_url = _image_to_data_url(image)
        # 2026-05-18: усиленный prompt после refusal Qwen 32B VL на EAC scan'е.
        # Без force-инструкции модель отказывалась «Извините, я не могу
        # просматривать изображения...». Текущий prompt explicitly запрещает
        # отказы и refusal-фразы. Если всё-таки откажется — detect ниже.
        instruction = prompt or (
            "Ты — OCR-движок. Твоя единственная задача — точно "
            "транскрибировать ВЕСЬ видимый на изображении текст.\n\n"
            "ПРАВИЛА:\n"
            "1. Не отказывай, не извиняйся, не объясняй что ты можешь или "
            "не можешь сделать — изображение УЖЕ получено и ОБЯЗАНО быть "
            "транскрибировано.\n"
            "2. Сохраняй переносы строк и структуру таблиц (используй | "
            "для разделителей столбцов).\n"
            "3. Не пиши предисловий типа «На изображении...» — сразу текст.\n"
            "4. Если текст на иностранном языке — транскрибируй как есть, "
            "без перевода.\n"
            "5. Если изображение пустое или нечитаемое — верни единственное "
            "слово EMPTY (без точек, без объяснений).\n\n"
            "Сейчас транскрибируй текст:"
        )
        async with self._admit():
            text = await self._complete_with_image(data_url, instruction, model_override=model_override)

        # Refusal detection — если модель всё-таки отказала, понижаем
        # confidence до 0.1 чтобы fallback chain (tesseract) подобрал.
        refusal_patterns = [
            "извините",
            "я не могу",
            "не могу просмат",
            "не могу обра",
            "i cannot",
            "i'm sorry",
            "i apologize",
            "i am unable",
            "as an ai",
        ]
        text_lower = text[:500].lower()
        is_refusal = any(p in text_lower for p in refusal_patterns)
        confidence = 0.1 if is_refusal else 0.75

        # OpenAI API не возвращает confidence — фиксированное значение,
        # которое doc-service комбинирует с парсер-уровневым.
        return VisionResponse(text=text, confidence=confidence)

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
    ) -> VerifyResponse:
        prompt = verify_prompts.build(extracted=extracted, raw_text=raw_text)
        async with self._admit():
            raw, usage = await self._complete_text_with_usage(
                prompt,
                json_mode=True,
                model_override=model_override,
                reasoning_effort=reasoning_effort,
            )
        data = _parse_json(raw) or {}
        normalized = data.get("extracted") if isinstance(data.get("extracted"), dict) else extracted
        issues = data.get("issues") if isinstance(data.get("issues"), list) else []
        return VerifyResponse(
            extracted=normalized or extracted,
            issues=[str(i) for i in issues],
            usage=_usage_of(usage),
        )

    # --- Generation primitives ---

    async def _complete_text(
        self,
        prompt: str,
        json_mode: bool = False,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
    ) -> str:
        text, _ = await self._complete_with_usage(
            [{"role": "user", "content": prompt}],
            json_mode=json_mode,
            model_override=model_override,
            reasoning_effort=reasoning_effort,
        )
        return text

    async def _complete_text_with_usage(
        self,
        prompt: str,
        json_mode: bool = False,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
    ) -> tuple[str, dict[str, int] | None]:
        return await self._complete_with_usage(
            [{"role": "user", "content": prompt}],
            json_mode=json_mode,
            model_override=model_override,
            reasoning_effort=reasoning_effort,
        )

    async def _complete_with_image(
        self,
        data_url: str,
        instruction: str,
        model_override: str | None = None,
    ) -> str:
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
            model_override=model_override,
        )

    async def _complete(
        self,
        messages: list[dict[str, Any]],
        json_mode: bool,
        model_override: str | None = None,
    ) -> str:
        text, _ = await self._complete_with_usage(messages, json_mode, model_override=model_override)
        return text

    async def _complete_with_usage(
        self,
        messages: list[dict[str, Any]],
        json_mode: bool,
        model_override: str | None = None,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
    ) -> tuple[str, dict[str, int] | None]:
        # json_mode = response_format={"type": "json_object"} — поддерживают
        # все современные OpenAI-compat серверы (OpenAI, vLLM, Ollama 0.5+,
        # LM Studio). Если backend не поддерживает — упадёт 400; ловим и
        # пробуем без режима. Это даёт мягкую совместимость со старыми
        # llama.cpp-серверами.
        # Если caller передал model_override (например doc-service выбрал
        # конкретного провайдера из provider_settings) — используем его,
        # иначе фолбэк на self.model_id из env. Это позволяет одному
        # backend-инстансу обслуживать разные модели на лету (Phi-4 /
        # Gemma / Mistral / etc через тот же inference-service).
        effective_model = model_override or self.model_id
        if model_override and model_override != self.model_id:
            log.info("openai_compatible: using model_override=%s (env default=%s)",
                     model_override, self.model_id)
        kwargs: dict[str, Any] = {
            "model": effective_model,
            "messages": messages,
            # Caller-override (classify catalog-режим шлёт ~30 — голый slug
            # короткий, не жжём токены на длинный вывод). Иначе backend default.
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": 0.0,  # детерминированно для классификации/извлечения
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        # reasoning_effort (доходит из provider_settings.extra через doc-service):
        # для thinking-моделей "none" подавляет hidden reasoning-токены —
        # qwen3.6: ~110s → ~0.5s, JSON остаётся в message.content (не уходит в
        # reasoning-поле). Шлём через extra_body, чтобы значение всегда попадало
        # на провод, даже если SDK ужесточит enum (Ollama принимает "none",
        # что не входит в стандартный OpenAI-набор low/medium/high). Для
        # не-reasoning моделей (phi4) param приходит None — kwargs не трогаем.
        if reasoning_effort:
            kwargs["extra_body"] = {"reasoning_effort": reasoning_effort}

        try:
            response = await self._client.chat.completions.create(**kwargs)
        except Exception as e:  # noqa: BLE001
            if json_mode and _looks_like_json_mode_not_supported(e):
                log.info("backend rejected response_format=json_object, retrying without")
                kwargs.pop("response_format", None)
                response = await self._client.chat.completions.create(**kwargs)
            elif reasoning_effort and _looks_like_reasoning_effort_not_supported(e):
                # Бэкенд не знает reasoning_effort — повторяем без него
                # (мягкая совместимость; thinking-модель станет медленной, но
                # не упадёт). Известные нам серверы (Ollama 0.24+) принимают.
                log.info("backend rejected reasoning_effort, retrying without")
                kwargs.pop("extra_body", None)
                response = await self._client.chat.completions.create(**kwargs)
            elif (overflow := _parse_context_overflow(e)) is not None:
                # Промпт + фиксированный max_tokens не влезли в окно модели.
                # Ужимаем бюджет ВЫВОДА под остаток окна и повторяем один раз.
                # Раньше это была смерть задачи: апстрим 400 → наш 500 → 3
                # бесполезных ретрая воркера с тем же исходом.
                ctx_limit, prompt_tokens = overflow
                fitted = ctx_limit - prompt_tokens - _CONTEXT_SAFETY_MARGIN
                if fitted < _MIN_OUTPUT_TOKENS:
                    # Один только промпт съел окно — ретраить нечем. Падаем, но
                    # с внятной причиной в логе (раньше был голый 500).
                    log.error(
                        "context overflow: prompt %s tokens vs window %s — "
                        "output budget would be %s (<%s), giving up",
                        prompt_tokens, ctx_limit, fitted, _MIN_OUTPUT_TOKENS,
                    )
                    raise
                log.warning(
                    "context overflow: prompt %s + max_tokens %s > window %s; "
                    "retrying with max_tokens=%s",
                    prompt_tokens, kwargs.get("max_tokens"), ctx_limit, fitted,
                )
                kwargs["max_tokens"] = fitted
                response = await self._client.chat.completions.create(**kwargs)
            else:
                raise

        choice = response.choices[0] if response.choices else None
        if choice is None or choice.message is None:
            return "", None
        content = (choice.message.content or "").strip()
        usage_obj = getattr(response, "usage", None)
        usage = None
        if usage_obj is not None:
            prompt_t = getattr(usage_obj, "prompt_tokens", None)
            completion_t = getattr(usage_obj, "completion_tokens", None)
            if prompt_t is not None or completion_t is not None:
                usage = {}
                if prompt_t is not None:
                    usage["prompt_tokens"] = int(prompt_t)
                if completion_t is not None:
                    usage["completion_tokens"] = int(completion_t)
        return content, usage


# Запас токенов при пересчёте бюджета вывода: провайдеры считают промпт
# «не меньше чем» (at least N), плюс шаблон чата добавляет служебные токены.
_CONTEXT_SAFETY_MARGIN = 64
# Ниже этого вывод бессмысленен (JSON-ответ не поместится) — честно падаем,
# вместо того чтобы вернуть заведомо обрезанный мусор.
_MIN_OUTPUT_TOKENS = 256


def _parse_context_overflow(err: Exception) -> tuple[int, int] | None:
    """Разбирает 400 «превышено контекстное окно» → (лимит_окна, токенов_промпта).

    Симптом (боевой, vision-модель qwen3-vl на :8101, окно 16384):
        This model's maximum context length is 16384 tokens. However, you
        requested 8192 output tokens and your prompt contains at least 8193
        input tokens, for a total of at least 16385 tokens.

    Причина: `max_tokens` фиксирован (OPENAI_MAX_TOKENS=8192), а промпт скана
    вырастает с размером страницы. Как только промпт перевалил за
    (окно - max_tokens), апстрим отвечает 400 → inference отдавал 500 →
    задача падала насовсем (3 ретрая впустую, все с тем же исходом).

    Возвращает None, если это не про контекст (тогда обработка не меняется).
    Поддержаны обе формулировки: vLLM/Ollama («prompt contains at least N
    input tokens») и классическая OpenAI («your messages resulted in N tokens»).
    """
    msg = str(err)
    if "context length" not in msg and "context_length" not in msg:
        return None
    m_ctx = re.search(r"maximum context length is (\d+)", msg)
    if not m_ctx:
        return None
    m_prompt = re.search(
        r"prompt contains at least (\d+)|your messages resulted in (\d+)", msg
    )
    if not m_prompt:
        return None
    prompt_tokens = int(m_prompt.group(1) or m_prompt.group(2))
    return int(m_ctx.group(1)), prompt_tokens


def _looks_like_json_mode_not_supported(err: Exception) -> bool:
    """Эвристика: упало из-за response_format=json_object?

    Полагаемся на текст ошибки, потому что разные серверы возвращают разные
    HTTP-коды (400/422/500). Если в сообщении упоминается json/response_format
    — повторяем без режима.
    """
    msg = str(err).lower()
    return any(kw in msg for kw in ("response_format", "json_object", "json mode"))


def _looks_like_reasoning_effort_not_supported(err: Exception) -> bool:
    """Эвристика: упало из-за reasoning_effort? Старые серверы могут не знать
    этот param. Полагаемся на текст ошибки (коды разнятся 400/422/500)."""
    msg = str(err).lower()
    return "reasoning_effort" in msg or "reasoning effort" in msg


def _downscale_for_vision(image: Image.Image) -> Image.Image:
    """Ужать длинную сторону картинки до settings.vision_max_image_px.

    Vision-latency прямо пропорциональна числу vision-токенов, а оно — площади
    картинки. Полноразмерный 200-DPI скан (A4 ≈ 1654x2339) молотится дольше без
    выигрыша в точности. Только УМЕНЬШАЕМ (апскейла нет); 0/выключено или уже
    меньше лимита → возвращаем как есть. LANCZOS — качество ресайза для текста.
    """
    max_px = settings.vision_max_image_px
    if max_px <= 0:
        return image
    longest = max(image.width, image.height)
    if longest <= max_px:
        return image
    scale = max_px / longest
    new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(new_size, Image.LANCZOS)


def _image_to_data_url(image: Image.Image) -> str:
    """Encode PIL image as a data URL (base64). JPEG for size.

    OpenAI vision API принимает либо публичный URL, либо data URL. Локальные
    серверы (Ollama, vLLM) поддерживают тот же формат. Картинка даунскейлится
    до vision_max_image_px (см. _downscale_for_vision) — снижает vision-latency.
    """
    image = _downscale_for_vision(image)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=90, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _decoded_image_to_data_url(image_base64: str) -> str:
    """Decode an incoming base64 image (PNG/JPEG bytes from doc-service) and
    re-encode it through `_image_to_data_url` for a consistent JPEG data URL.

    Re-encoding via PIL also validates the payload — a malformed base64/image
    raises here instead of producing a broken `image_url` the model silently
    ignores. Caller is inside `extract`, so the error surfaces as a normal
    extract failure (job retries / fails-soft upstream).
    """
    raw = base64.b64decode(image_base64)
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    return _image_to_data_url(image)


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


def _extract_slug(raw: str) -> str | None:
    """Достать голый slug из ответа модели в catalog-режиме.

    Модель просят вернуть ТОЛЬКО slug, но reasoning-модели иногда добавляют
    обвязку («Тип: invoice», «```\ninvoice\n```», markdown, точку). Берём
    первый токен, похожий на slug (буквы/цифры/_/-), lowercase-сравнение с
    `unknown` оставляем doc-service'у (он валидирует по каталогу). Пусто → None.
    """
    if not raw:
        return None
    text = raw.strip().strip("`").strip()
    if not text:
        return None
    # Первый «словоподобный» токен (slug'и: invoice, commercial_invoice,
    # factInvoice, УПД-подобных latin-only тут нет — каталог на latin-slug'ах).
    m = re.search(r"[A-Za-z][A-Za-z0-9_\-]*", text)
    if not m:
        return None
    return m.group(0)


def _safe_float(value, default: float = 0.0) -> float:
    """Coerce model output to float. Models (mistral, qwen) occasionally
    emit confidence as a nested object/list; never raise, fall back."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return default
    return default


def _clamp01(x: float) -> float:
    if x != x:  # NaN guard
        return 0.0
    return max(0.0, min(1.0, x))
