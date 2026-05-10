from fastapi import APIRouter, Depends

from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend
from ..schemas import VerifyRequest, VerifyResponse

router = APIRouter()


@router.post("/verify", response_model=VerifyResponse)
async def verify(
    body: VerifyRequest,
    _: None = Depends(require_api_key),
    backend: ModelBackend = Depends(get_backend),
) -> VerifyResponse:
    return await backend.verify(extracted=body.extracted, raw_text=body.raw_text)
