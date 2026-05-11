from fastapi import APIRouter, Depends

from ..auth import require_api_key
from ..deps import get_providers_status

router = APIRouter()


@router.get("/providers/status")
async def providers_status(_: None = Depends(require_api_key)) -> dict[str, object]:
    """Lightweight inventory of LLM providers known to the service.

    Doc-service proxies this so its operator UI can show "Claude is
    configured but currently inactive — set BACKEND=claude in .env to
    switch" without round-tripping through actual inference.

    No secrets are returned: API keys are surfaced only as a boolean
    `configured` flag.
    """
    return get_providers_status()
