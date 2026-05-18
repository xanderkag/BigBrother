from typing import Any, Literal

from pydantic import BaseModel, Field

# Six builtin types we have hardcoded prompts/schemas for. Used as a hint in
# /v1/classify response (модель должна выбрать ровно один из них). На /v1/extract
# hint — свободная строка (`DocumentTypeSlug`), потому что админ может через
# Document Type Registry заводить любые пользовательские типы.
BuiltinDocumentType = Literal["invoice", "factInvoice", "UPD", "TTN", "CMR", "AKT"]
DocumentType = BuiltinDocumentType  # backwards-compat alias
DocumentTypeSlug = str


# --- /v1/classify ---

class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1)
    # Опциональный per-request model override. Если задан — backend использует
    # эту модель вместо OPENAI_MODEL из env (актуально для openai_compatible —
    # doc-service передаёт сюда значение из provider_settings.model, что
    # позволяет роутить разные документы в Phi-4 / Gemma / Mistral / etc.
    # на лету без рестарта inference-service).
    model: str | None = None


class ClassifyResponse(BaseModel):
    type: DocumentType | None
    confidence: float = Field(ge=0.0, le=1.0)


# --- /v1/extract ---

class ExtractRequest(BaseModel):
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

class VisionRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    prompt: str | None = None
    # См. ClassifyRequest.model — для openai_compatible backend'ов с vision.
    model: str | None = None


class VisionResponse(BaseModel):
    text: str
    confidence: float = Field(ge=0.0, le=1.0)


# --- /v1/verify ---

class VerifyRequest(BaseModel):
    extracted: dict[str, Any]
    raw_text: str


class VerifyResponse(BaseModel):
    extracted: dict[str, Any]
    issues: list[str] = Field(default_factory=list)
