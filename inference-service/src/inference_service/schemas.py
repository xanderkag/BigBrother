from typing import Any, Literal

from pydantic import BaseModel, Field

# --- VANGA-LLM-2: per-request backend override ---
# Mixed into request models that hit the model backend (classify / extract /
# vision / verify). All optional; when all None the route uses the env
# singleton (`get_backend()`) — behaviour identical to before.
#
#   backend  — "stub"|"claude"|"openai"|"openai_compat"|"qwen". doc-service
#              resolves it from provider_settings.extra.backend of the calling
#              instance → cloud/local/gpu switch without restarting the service.
#   base_url — per-request upstream OpenAI-compatible endpoint (openai_compat):
#              e.g. one instance → local Ollama, another → GPU vLLM. "" / None
#              means use the env preset (OPENAI_BASE_URL).
#   api_key  — per-request upstream key (cloud/claude). None → env preset.
#
# Only doc-service reaches these routes (require_api_key), and the values come
# from admin-controlled provider_settings — same trust level as the doc text.
class BackendOverrideMixin(BaseModel):
    backend: str | None = None
    base_url: str | None = None
    api_key: str | None = None


# Six builtin types we have hardcoded prompts/schemas for. Used as a hint in
# /v1/classify response (модель должна выбрать ровно один из них). На /v1/extract
# hint — свободная строка (`DocumentTypeSlug`), потому что админ может через
# Document Type Registry заводить любые пользовательские типы.
BuiltinDocumentType = Literal["invoice", "factInvoice", "UPD", "TTN", "CMR", "AKT"]
DocumentType = BuiltinDocumentType  # backwards-compat alias
DocumentTypeSlug = str


# --- /v1/classify ---

class ClassifyRequest(BackendOverrideMixin):
    text: str = Field(min_length=1)
    # Опциональный per-request model override. Если задан — backend использует
    # эту модель вместо OPENAI_MODEL из env (актуально для openai_compatible —
    # doc-service передаёт сюда значение из provider_settings.model, что
    # позволяет роутить разные документы в Phi-4 / Gemma / Mistral / etc.
    # на лету без рестарта inference-service).
    model: str | None = None
    # reasoning/thinking knob (OpenAI-compat). "none" подавляет hidden
    # reasoning-токены у thinking-моделей (qwen3.6: ~110s → ~0.5s, JSON
    # остаётся в message.content). doc-service шлёт это из
    # provider_settings.extra.reasoning_effort. None → не передаётся в
    # backend, поведение не меняется (phi4 и прочие не-reasoning модели).
    reasoning_effort: str | None = None
    # --- Catalog-driven classify (production LLM classifier) ---
    # Когда задан `catalog` — backend строит каталог-промпт (`slug — description`
    # всех активных типов) и возвращает голый slug из каталога либо `unknown`
    # вместо жёсткого 6-типового enum. doc-service строит каталог динамически
    # из document_types и присылает сюда. Если catalog=None — старое поведение
    # (6 builtin типов JSON-режимом), backwards compat.
    catalog: str | None = Field(default=None, max_length=32000)
    # Имя загруженного файла — сигнал для модели (в user-сообщении).
    file_name: str | None = None
    # Подсказка быстрого keyword-классификатора (prior top slug). В user-сообщении.
    keyword_hint: str | None = None
    # Потолок токенов ответа (голый slug короткий → ~30). None → backend default.
    max_tokens: int | None = Field(default=None, ge=1, le=2048)


class ClassifyResponse(BaseModel):
    # str | None — в каталог-режиме возвращаем произвольный slug из динамического
    # каталога document_types (не только 6 builtin). Старые вызовы без catalog
    # по-прежнему получают один из 6 literal'ов (все — валидные строки).
    type: DocumentTypeSlug | None
    confidence: float = Field(ge=0.0, le=1.0)


# --- /v1/extract ---

class ExtractRequest(BackendOverrideMixin):
    text: str = Field(min_length=1)
    schema_: dict[str, Any] = Field(alias="schema")
    # Свободный slug: builtin или пользовательский из Document Type Registry.
    hint: DocumentTypeSlug | None = None
    # Кастомная инструкция, которую doc-service резолвит из `document_types.llm_prompt`.
    # Если задана — backend использует её вместо встроенного prompt'а для этого типа.
    # Опциональный max_length — защита от 1 MB prompt'ов из БД, ломающих токен-лимит.
    prompt_override: str | None = Field(default=None, max_length=16000)
    # Захватить ли в ответ финальный prompt и сырой текст ответа модели.
    # Используется doc-service для job debug-трассы. Не пишем по умолчанию —
    # ответ может вырасти на 10-50 KB (объём prompt+raw). Включаем когда
    # точно хотим видеть в UI.
    include_debug: bool = False
    # Опциональный per-request model override. Если задан — backend использует
    # эту модель вместо OPENAI_MODEL из env. См. ClassifyRequest.model выше.
    model: str | None = None
    # extraction-from-image (2026-05-25): base64-кодированное изображение
    # первой страницы документа. Если задано И backend vision-capable —
    # extract строит multimodal-сообщение (image + extract-prompt), и модель
    # извлекает поля НАПРЯМУЮ из картинки, а не из OCR-текста. Бенч показал
    # 90% exact / 96% critical на Qwen2.5-VL (vs 68% text-only). Если None —
    # классический text-only путь (поведение не меняется). doc-service шлёт
    # это поле только когда resolved-провайдер помечен vision=true.
    image_base64: str | None = None
    # См. ClassifyRequest.reasoning_effort — knob для thinking-моделей.
    reasoning_effort: str | None = None

    # Allow population by both "schema" (the public name) and "schema_" (Python attr).
    # `schema` is a reserved attribute on BaseModel in Pydantic v1; the alias keeps
    # the public contract while sidestepping the historical name clash.
    model_config = {"populate_by_name": True}


class ExtractDebug(BaseModel):
    """Отладочный след extract-вызова. Прозрачно для нашей бизнес-логики,
    нужно админу для понимания «что мы попросили / что модель ответила»
    + минимум метрик для log-агрегатора (latency/cost)."""
    prompt: str
    raw_response: str
    model: str
    backend: str
    # Метрики вызова. duration_ms — собственно время API-ответа модели
    # (без сетевой обвязки doc-service). Tokens — usage-данные от
    # backend'а, доступны не всегда: OpenAI-compat и Claude дают; Qwen-VL
    # через transformers и stub — None.
    duration_ms: int = 0
    prompt_tokens: int | None = None
    output_tokens: int | None = None


class ExtractResponse(BaseModel):
    extracted: dict[str, Any]
    confidence: float = Field(ge=0.0, le=1.0)
    # F2 (2026-05-17): per-field confidence. Ключи — field path
    # ("seller.inn", "total_with_vat"). Значения — float 0..1.
    # Заполняется LLM в `_RESPONSE_CONTRACT`. doc-service пропускает
    # это поле в webhook payload через `extracted._field_confidence`
    # (мы кладём туда же), чтобы SLAI matcher мог делать weighted scoring.
    field_confidence: dict[str, float] = Field(default_factory=dict)
    issues: list[str] = Field(default_factory=list)
    debug: ExtractDebug | None = None


# --- /v1/vision-ocr ---

class VisionRequest(BackendOverrideMixin):
    image_base64: str = Field(min_length=1)
    prompt: str | None = None
    # См. ClassifyRequest.model — для openai_compatible backend'ов с vision.
    model: str | None = None
    # См. ClassifyRequest.reasoning_effort.
    reasoning_effort: str | None = None


class VisionResponse(BaseModel):
    text: str
    confidence: float = Field(ge=0.0, le=1.0)


# --- /v1/transcribe (ASR) ---

class TranscribeRequest(BaseModel):
    audio_base64: str = Field(min_length=1)
    # MIME входного аудио (audio/wav, audio/mpeg, audio/mp4, audio/ogg, …).
    # Прокидывается транскрайбером в multipart filename/content-type, чтобы
    # ASR-сервер выбрал правильный декодер. Свободная строка — мы не
    # ограничиваем набор (валидация magic-bytes — на стороне doc-service).
    mime_type: str = Field(min_length=1)
    # Опциональная language-подсказка (ISO 639-1: "ru", "en"). Если задана —
    # уходит как поле `language` в OpenAI-совместимый transcriptions-запрос.
    # None → ASR-сервер сам определяет язык.
    language: str | None = None


class TranscribeResponse(BaseModel):
    text: str
    # Длительность аудио в секундах, если ASR-сервер её вернул. Не все
    # серверы заполняют — тогда None.
    duration_s: float | None = None
    # Уверенность транскрипции 0..1, если сервер её даёт. Whisper-серверы
    # обычно НЕ дают per-clip confidence → None. doc-service подставит
    # дефолт, чтобы downstream-пайплайн получил число.
    confidence: float | None = None


# --- /v1/verify ---

class VerifyRequest(BackendOverrideMixin):
    extracted: dict[str, Any]
    raw_text: str
    # См. ClassifyRequest.reasoning_effort.
    reasoning_effort: str | None = None


class VerifyResponse(BaseModel):
    extracted: dict[str, Any]
    issues: list[str] = Field(default_factory=list)
