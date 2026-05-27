from fastapi import APIRouter, Depends

from ..admission import AdmissionGate, get_admission_gate
from ..auth import require_api_key
from ..backends.base import ModelBackend
from ..deps import get_backend
from ..schemas import VisionRequest, VisionResponse
from ._payload import decode_b64_payload

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
    image_bytes = decode_b64_payload(
        body.image_base64, field="image_base64", max_bytes=MAX_IMAGE_BYTES
    )

    async with gate.acquire():
        return await backend.vision_ocr(
            image_bytes=image_bytes, prompt=body.prompt, model_override=body.model
        )
