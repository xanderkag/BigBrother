from fastapi import APIRouter, Depends

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend, resolve_backend
from ..schemas import ExtractRequest, ExtractResponse

router = APIRouter()


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    body: ExtractRequest,
    _: None = Depends(require_api_key),
    default_backend: ModelBackend = Depends(get_backend),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> ExtractResponse:
    # VANGA-LLM-2: per-request backend override on top of the DI default.
    backend = resolve_backend(
        body.backend, body.base_url, body.api_key, default=default_backend
    )
    async with gate.acquire():
        return await backend.extract(
            text=body.text,
            schema=body.schema_,
            hint=body.hint,
            prompt_override=body.prompt_override,
            include_debug=body.include_debug,
            model_override=body.model,
            image_base64=body.image_base64,
            reasoning_effort=body.reasoning_effort,
        )
