from fastapi import APIRouter, Depends

from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend
from ..schemas import ExtractRequest, ExtractResponse

router = APIRouter()


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    body: ExtractRequest,
    _: None = Depends(require_api_key),
    backend: ModelBackend = Depends(get_backend),
) -> ExtractResponse:
    return await backend.extract(
        text=body.text,
        schema=body.schema_,
        hint=body.hint,
        prompt_override=body.prompt_override,
        include_debug=body.include_debug,
        model_override=body.model,
    )
