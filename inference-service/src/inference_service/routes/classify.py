from fastapi import APIRouter, Depends

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend
from ..schemas import ClassifyRequest, ClassifyResponse

router = APIRouter()


@router.post("/classify", response_model=ClassifyResponse)
async def classify(
    body: ClassifyRequest,
    _: None = Depends(require_api_key),
    backend: ModelBackend = Depends(get_backend),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> ClassifyResponse:
    async with gate.acquire():
        return await backend.classify(
            body.text,
            model_override=body.model,
            reasoning_effort=body.reasoning_effort,
        )
