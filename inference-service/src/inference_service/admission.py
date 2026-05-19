"""Bounded admission control for hot LLM endpoints.

A1 (2026-05-19): дополнение к backend-level семафору. Backend-уровневый
`_admit` оборачивает каждый вызов в `asyncio.Semaphore` и **очередит**
ожидающих — это нормально пока очередь короткая, но при бурсте
upstream-клиент видит долгие latency'ы без диагностики.

Этот gate — admission control на уровне HTTP-роутов. Когда лимит
исчерпан, мы немедленно отдаём `503 Service Unavailable` с
`Retry-After: 2`, и вызывающий (doc-service BullMQ worker) сам решает,
ждать ему или попробовать другой backend. Это даёт:

  - Видимость в метриках (`inference_gate_rejections_total`) — операторы
    видят саму саму saturation, а не «всё медленно».
  - Защиту от очередей-в-памяти, которые невидимо растут под `await sem`.

Cheap probes (`/health`, `/ready`, `/metrics`, `/v1/providers/status`) не
закрываются gate'ом — иначе симптом saturation скроется от scrape'а.
"""

import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import HTTPException, status

from .config import settings
from .metrics import inference_gate_inflight, inference_gate_rejections_total


class AdmissionGate:
    """Bounded counter of in-flight HTTP-level inference requests.

    Differs from the backend-level `_admit` semaphore: that one queues,
    this one rejects. The two compose — a successful gate acquisition
    still goes through the backend semaphore (which may itself queue
    briefly behind the model's natural concurrency limit).
    """

    def __init__(self, limit: int) -> None:
        self._sem = asyncio.Semaphore(limit)
        self._limit = limit

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def available(self) -> int:
        # asyncio.Semaphore exposes _value privately; we read it for metrics only.
        return self._sem._value  # noqa: SLF001

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[None]:
        # 0 disables the gate — fast-path skips both rejection and metrics.
        if self._limit <= 0:
            yield
            return
        # Non-blocking try-acquire: if no slot is free, raise 503 immediately
        # rather than `await sem.acquire()` which would queue.
        if self._sem.locked() and self._sem._value <= 0:  # noqa: SLF001
            inference_gate_rejections_total.inc()
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="inference gate full; retry shortly",
                headers={"Retry-After": "2"},
            )
        async with self._sem:
            inference_gate_inflight.set(self._limit - self.available)
            try:
                yield
            finally:
                inference_gate_inflight.set(self._limit - self.available)


_gate: AdmissionGate | None = None


def get_admission_gate() -> AdmissionGate:
    """FastAPI dependency — singleton gate sized from settings.

    Lazy so tests can override `settings.max_concurrent_inflight` via
    monkeypatch + `reset_admission_gate()` between cases.
    """
    global _gate
    if _gate is None:
        _gate = AdmissionGate(settings.max_concurrent_inflight)
    return _gate


def reset_admission_gate() -> None:
    """Test helper — drop the cached gate so the next `get_admission_gate()`
    rebuilds with whatever `settings.max_concurrent_inflight` currently is."""
    global _gate
    _gate = None
