import base64
import binascii

from fastapi import APIRouter, Depends, HTTPException, status

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend
from ..schemas import VisionRequest, VisionResponse

router = APIRouter()

# Cap incoming images at ~25MB after base64 decode. Larger pages should be
# downscaled by the caller before sending — most VLMs hit context/memory
# limits well before this anyway.
MAX_IMAGE_BYTES = 25 * 1024 * 1024


@router.post("/vision-ocr", response_model=VisionResponse)
async def vision_ocr(
    body: VisionRequest,
    _: None = Depends(require_api_key),
    backend: ModelBackend = Depends(get_backend),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> VisionResponse:
    try:
        image_bytes = base64.b64decode(body.image_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"image_base64 is not valid base64: {e}",
        ) from e

    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="image_base64 decoded to zero bytes",
        )
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"image too large: {len(image_bytes)} bytes (max {MAX_IMAGE_BYTES})",
        )

    async with gate.acquire():
        return await backend.vision_ocr(
            image_bytes=image_bytes, prompt=body.prompt, model_override=body.model
        )
