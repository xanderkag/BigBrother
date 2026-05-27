import base64
import binascii

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from ..admission import AdmissionGate, get_admission_gate
from ..asr import AsrTranscriber, AsrUnavailableError, get_transcriber
from ..auth import require_api_key
from ..schemas import TranscribeRequest, TranscribeResponse

router = APIRouter()

# Cap incoming audio at ~50MB after base64 decode — matches the doc-service
# upload ceiling. Voice messages / call snippets are small; longer recordings
# should be chunked by the caller before sending.
MAX_AUDIO_BYTES = 50 * 1024 * 1024


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    body: TranscribeRequest,
    _: None = Depends(require_api_key),
    transcriber: AsrTranscriber = Depends(get_transcriber),
    gate: AdmissionGate = Depends(get_admission_gate),
) -> TranscribeResponse:
    # Gate ASR behind config: if disabled or no endpoint configured, fail
    # clearly with 503 so the caller (doc-service) knows it's not wired, not
    # a transient error.
    if not transcriber.is_available():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ASR not enabled (set ASR_ENABLED=true and ASR_BASE_URL)",
        )

    try:
        audio_bytes = base64.b64decode(body.audio_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"audio_base64 is not valid base64: {e}",
        ) from e

    if len(audio_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="audio_base64 decoded to zero bytes",
        )
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"audio too large: {len(audio_bytes)} bytes (max {MAX_AUDIO_BYTES})",
        )

    async with gate.acquire():
        try:
            return await transcriber.transcribe(
                audio_bytes=audio_bytes,
                mime_type=body.mime_type,
                language=body.language,
            )
        except AsrUnavailableError as e:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
            ) from e
        except httpx.HTTPError as e:
            # Upstream ASR server unreachable / errored. 502 — the gateway
            # (this service) got a bad response from the ASR backend.
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"ASR server error: {e}",
            ) from e
        except ValueError as e:
            # Malformed ASR response (missing `text`, non-JSON, …).
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"ASR server returned unexpected response: {e}",
            ) from e
