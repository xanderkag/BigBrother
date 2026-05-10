import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .deps import get_backend
from .routes import classify, extract, verify, vision

logging.basicConfig(level=settings.log_level.upper())
log = logging.getLogger("inference-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager-init the backend so the readiness probe can flip green only after
    # weights are loaded (or the stub is ready). Lifespan exceptions surface
    # as a non-zero exit code, which is what we want for orchestrators.
    backend = get_backend()
    log.info("backend ready: %s", backend.name)
    app.state.backend = backend
    yield


app = FastAPI(
    title="inference-service",
    version="0.1.0",
    description="Domain-shaped inference API for document understanding (classify / extract / vision-ocr / verify).",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, str]:
    backend = getattr(app.state, "backend", None)
    if backend is None or not backend.is_ready():
        return {"status": "not_ready"}
    return {"status": "ready", "backend": backend.name}


app.include_router(classify.router, prefix="/v1", tags=["classify"])
app.include_router(extract.router, prefix="/v1", tags=["extract"])
app.include_router(vision.router, prefix="/v1", tags=["vision"])
app.include_router(verify.router, prefix="/v1", tags=["verify"])
