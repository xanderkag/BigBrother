from fastapi import APIRouter, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from ..metrics import registry

router = APIRouter()


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    """Prometheus scrape endpoint.

    Public on purpose (matches doc-service `/metrics`): Prometheus
    doesn't carry our Bearer token. Gate at the network layer if
    needed (corp nginx `allow ... ; deny all ;`).

    `include_in_schema=False` hides it from Swagger UI — it's not
    part of the domain API and would clutter the docs.
    """
    return Response(content=generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
