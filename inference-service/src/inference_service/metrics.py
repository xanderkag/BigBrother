"""Prometheus metrics for inference-service.

Exposes a `/metrics` endpoint scraped by Prometheus. Pairs with the
doc-service metrics on the other side of the wire — together they give
end-to-end visibility into the document pipeline.

The `backend` label is included on every metric so dashboards can break
out latency by which model served the request (useful while we A/B
between Claude and a local Qwen).
"""

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram

# Dedicated registry instead of the global default — keeps tests clean
# (no leakage between TestClient invocations) and lets us mount multiple
# registries side-by-side in future deployments.
registry = CollectorRegistry()

requests_total = Counter(
    "inference_requests_total",
    "Total HTTP requests served, split by endpoint, backend, and outcome.",
    labelnames=("endpoint", "backend", "outcome"),
    registry=registry,
)

request_duration_seconds = Histogram(
    "inference_request_duration_seconds",
    "HTTP request handler duration. Covers the full inference call including SDK round-trip.",
    labelnames=("endpoint", "backend"),
    # Inference latency ranges from ~50ms (stub) to 30-60s (Qwen 7B cold).
    # Buckets chosen to capture both ends and the typical 1-10s band.
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120),
    registry=registry,
)

# A1 (2026-05-19): admission-control inflight gauge. Incremented when a
# backend enters its `_admit` contextmanager, decremented on exit. Operators
# see saturation directly — if this gauge hits MAX_CONCURRENT_CALLS and
# stays there, requests are queueing on the semaphore.
inflight_calls = Gauge(
    "inference_inflight_calls",
    "Concurrent in-flight model calls (extract/classify/vision/verify), by backend.",
    labelnames=("backend",),
    registry=registry,
)

# A1 (2026-05-19): route-level admission gate metrics. Отдельно от
# `inflight_calls` (backend-уровневый), потому что эти два уровня могут
# расходиться: gate ограничивает HTTP-параллелизм, backend семафор
# моделирует ограничение модели (rate-limit или GPU slot). Operators видят
# обе линии в дашборде и понимают, где именно затык.
inference_gate_inflight = Gauge(
    "inference_gate_inflight",
    "Currently held route-level admission slots (limit - available).",
    registry=registry,
)

inference_gate_rejections_total = Counter(
    "inference_gate_rejections_total",
    "Requests rejected by the admission gate with HTTP 503.",
    registry=registry,
)
