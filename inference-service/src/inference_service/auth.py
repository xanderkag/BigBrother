from fastapi import Header, HTTPException, status

from .config import settings


async def require_api_key(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency. No-op if API_KEY is unset (dev mode).

    Compares against the configured key in constant time to avoid
    timing-based discrimination of valid prefixes.
    """
    if not settings.api_key:
        return

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization: Bearer <key> required",
        )

    provided = authorization[len("bearer ") :].strip()
    if not _consteq(provided, settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid api key")


def _consteq(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a.encode(), b.encode()):
        result |= x ^ y
    return result == 0
