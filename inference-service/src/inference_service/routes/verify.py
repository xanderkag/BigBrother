from fastapi import APIRouter, Depends

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend, resolve_backend
from ..schemas import VerifyRequest, VerifyResponse

router = APIRouter()


@router.post("/verify", response_model=VerifyResponse)
async def verify(
    body: VerifyRequest,
    _: None = Depends(require_api_key),
    default_backend: ModelBackend = Depends(get_backend),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> VerifyResponse:
    # VANGA-LLM-2: per-request backend override on top of the DI default.
    backend = resolve_backend(
        body.backend, body.base_url, body.api_key, default=default_backend
    )
    async with gate.acquire():
        return await backend.verify(
            extracted=body.extracted,
            raw_text=body.raw_text,
            reasoning_effort=body.reasoning_effort,
        )
