import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from .config import settings
from .deps import get_backend
from .metrics import request_duration_seconds, requests_total
from .routes import (
    classify,
    extract,
    metrics as metrics_route,
    providers,
    transcribe,
    verify,
    vision,
)

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


@app.middleware("http")
async def prometheus_middleware(request: Request, call_next):
    """Auto-instrument every HTTP request with a histogram + counter.

    `endpoint` label uses the route path template (`/v1/classify`) rather
    than the raw URL so label cardinality stays bounded — even if every
    job has a unique id, all GET /jobs/<uuid> calls collapse to a single
    bucket.

    `backend` is the currently active backend, captured at request time
    (not at boot) so a runtime backend swap shows up correctly.
    """
    # Skip metrics endpoint itself — recursive observation is noisy.
    path = request.url.path
    if path in ("/metrics", "/health", "/ready"):
        return await call_next(request)

    backend = getattr(app.state, "backend", None)
    backend_name = backend.name if backend else "unknown"
    # Use the matched route template if available, raw path otherwise.
    route = request.scope.get("route")
    endpoint = getattr(route, "path", path) if route else path

    started = time.perf_counter()
    outcome = "exception"  # default — overwritten on normal return; guards
    # against UnboundLocalError if a BaseException (e.g. CancelledError) skips
    # the `except Exception` branch but still runs `finally`.
    try:
        response = await call_next(request)
        outcome = "success" if response.status_code < 400 else "error"
        return response
    except Exception:
        outcome = "exception"
        raise
    finally:
        elapsed = time.perf_counter() - started
        request_duration_seconds.labels(endpoint=endpoint, backend=backend_name).observe(elapsed)
        requests_total.labels(endpoint=endpoint, backend=backend_name, outcome=outcome).inc()


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness: процесс жив. Не пингует upstream — must быть мгновенным."""
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, object]:
    """Readiness: backend сконфигурирован И отвечает.

    Для backend'ов с асинхронным `probe()` (openai_compat) — дёргает
    его и возвращает реальный статус коннекта к модели. Для остальных
    (stub, claude, qwen) — структурная проверка `is_ready()`.

    Используется Kubernetes-orchestrator'ом и UI doc-service'а, чтобы
    отличить cold-start (модель ещё грузится) от нормальной работы.
    """
    backend = getattr(app.state, "backend", None)
    if backend is None:
        return {"status": "not_ready", "reason": "backend not initialised"}

    if not backend.is_ready():
        return {"status": "not_ready", "backend": backend.name, "reason": "backend.is_ready=false"}

    # Реальный пинг для backend'ов, которые умеют (probe → optional method).
    probe = getattr(backend, "probe", None)
    if callable(probe):
        ok, err = await probe()
        if not ok:
            return {
                "status": "not_ready",
                "backend": backend.name,
                "reason": err or "probe failed",
            }

    return {"status": "ready", "backend": backend.name}


app.include_router(classify.router, prefix="/v1", tags=["classify"])
app.include_router(extract.router, prefix="/v1", tags=["extract"])
app.include_router(vision.router, prefix="/v1", tags=["vision"])
app.include_router(transcribe.router, prefix="/v1", tags=["transcribe"])
app.include_router(verify.router, prefix="/v1", tags=["verify"])
app.include_router(providers.router, prefix="/v1", tags=["providers"])
app.include_router(metrics_route.router)  # exposed at /metrics, no prefix
