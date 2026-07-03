from fastapi import APIRouter, Depends

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend, resolve_backend
from ..schemas import ClassifyRequest, ClassifyResponse

router = APIRouter()


@router.post("/classify", response_model=ClassifyResponse)
async def classify(
    body: ClassifyRequest,
    _: None = Depends(require_api_key),
    default_backend: ModelBackend = Depends(get_backend),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> ClassifyResponse:
    # VANGA-LLM-2: per-request backend override on top of the DI default.
    backend = resolve_backend(
        body.backend, body.base_url, body.api_key, default=default_backend
    )
    async with gate.acquire():
        return await backend.classify(
            body.text,
            model_override=body.model,
            reasoning_effort=body.reasoning_effort,
            catalog=body.catalog,
            file_name=body.file_name,
            keyword_hint=body.keyword_hint,
            max_tokens=body.max_tokens,
        )
