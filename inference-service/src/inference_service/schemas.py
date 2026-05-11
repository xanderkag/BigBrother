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

    # Allow population by both "schema" (the public name) and "schema_" (Python attr).
    # `schema` is a reserved attribute on BaseModel in Pydantic v1; the alias keeps
    # the public contract while sidestepping the historical name clash.
    model_config = {"populate_by_name": True}


class ExtractResponse(BaseModel):
    extracted: dict[str, Any]
    confidence: float = Field(ge=0.0, le=1.0)
    issues: list[str] = Field(default_factory=list)


# --- /v1/vision-ocr ---

class VisionRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    prompt: str | None = None


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
