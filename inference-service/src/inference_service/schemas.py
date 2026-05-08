from typing import Any, Literal

from pydantic import BaseModel, Field

DocumentType = Literal["invoice", "factInvoice", "UPD", "TTN", "CMR", "AKT"]


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
    hint: DocumentType | None = None

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
