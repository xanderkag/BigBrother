"""Admission-control / concurrency tests for A1 closure.

Verifies that:
  - When `max_concurrent_calls` > 0, the backend's `_admit` contextmanager
    caps concurrent in-flight calls (semaphore semantics).
  - When `max_concurrent_calls` == 0, there's no cap — all callers run
    in parallel.
  - The inflight Prometheus gauge tracks acquire/release correctly,
    including on exception.
  - The route-level AdmissionGate rejects with 503 + Retry-After when
    saturated (vs the backend semaphore which queues).

These tests use a custom ProbeBackend whose `extract` blocks on an
asyncio.Event so we can deterministically observe how many tasks are
inside `_admit` at any given moment without flaky timing.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from inference_service.backends.base import ModelBackend
from inference_service.metrics import inference_gate_rejections_total, inflight_calls
from inference_service.schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)


class ProbeBackend(ModelBackend):
    """Test backend whose extract() blocks on an event so we can observe
    how many concurrent callers are inside `_admit` at once.

    `inside_count` is incremented inside the admission region and
    decremented on exit. `peak` records the high-water mark — that's what
    the semaphore is supposed to cap.
    """

    name = "probe"

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.inside_count = 0
        self.peak = 0
        self.entered = asyncio.Event()
        self._entries = 0

    def is_ready(self) -> bool:
        return True

    async def classify(self, text: str, model_override: str | None = None) -> ClassifyResponse:  # noqa: ARG002
        async with self._admit():
            return ClassifyResponse(type=None, confidence=0.0)

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
        include_debug: bool = False,
        model_override: str | None = None,
        image_base64: str | None = None,
    ) -> ExtractResponse:
        async with self._admit():
            self.inside_count += 1
            self.peak = max(self.peak, self.inside_count)
            self._entries += 1
            # Signal that at least one task has entered (first entry only).
            self.entered.set()
            try:
                await self.release.wait()
                return ExtractResponse(extracted={}, confidence=1.0, issues=[])
            finally:
                self.inside_count -= 1

    async def vision_ocr(
        self, image_bytes: bytes, prompt: str | None, model_override: str | None = None
    ) -> VisionResponse:  # noqa: ARG002
        async with self._admit():
            return VisionResponse(text="", confidence=0.0)

    async def verify(
        self, extracted: dict[str, Any], raw_text: str, model_override: str | None = None
    ) -> VerifyResponse:  # noqa: ARG002
        async with self._admit():
            return VerifyResponse(extracted=extracted, issues=[])


@pytest.mark.asyncio
async def test_semaphore_caps_concurrent_calls() -> None:
    """С max_concurrent_calls=2 третий extract стоит в очереди пока один
    из первых двух не освободит слот."""
    with patch("inference_service.backends.base.settings") as mock_settings:
        mock_settings.max_concurrent_calls = 2
        backend = ProbeBackend()

        async def _call() -> ExtractResponse:
            return await backend.extract(text="x", schema={}, hint=None)

        tasks = [asyncio.create_task(_call()) for _ in range(3)]

        # Give the loop a moment to schedule the tasks. The semaphore should
        # let exactly 2 of them inside `_admit` and park the third.
        await asyncio.sleep(0.05)

        assert backend.inside_count == 2, (
            f"expected exactly 2 concurrent extracts, got {backend.inside_count}"
        )
        assert backend.peak == 2

        # Release the inner await; tasks finish in order they were admitted.
        backend.release.set()
        results = await asyncio.gather(*tasks)
        assert len(results) == 3
        # Third task did enter eventually (semaphore queued, not rejected).
        assert backend._entries == 3
        # Peak should remain at 2 — even after the third entered, the first
        # two would have already released their slot.
        assert backend.peak == 2


@pytest.mark.asyncio
async def test_zero_disables_cap() -> None:
    """max_concurrent_calls=0 → нет ограничения, все три задачи бегут параллельно."""
    with patch("inference_service.backends.base.settings") as mock_settings:
        mock_settings.max_concurrent_calls = 0
        backend = ProbeBackend()

        async def _call() -> ExtractResponse:
            return await backend.extract(text="x", schema={}, hint=None)

        tasks = [asyncio.create_task(_call()) for _ in range(3)]
        await asyncio.sleep(0.05)

        assert backend.inside_count == 3, (
            f"with cap=0 all 3 should run in parallel, got {backend.inside_count}"
        )
        assert backend.peak == 3

        backend.release.set()
        await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_inflight_gauge_decrements_on_exception() -> None:
    """Если backend кидает внутри `_admit` — gauge всё равно уменьшается."""
    with patch("inference_service.backends.base.settings") as mock_settings:
        mock_settings.max_concurrent_calls = 4

        class BrokenBackend(ProbeBackend):
            name = "broken-probe"

            async def extract(  # type: ignore[override]
                self,
                text: str,
                schema: dict[str, Any],
                hint: str | None,
                prompt_override: str | None = None,
                include_debug: bool = False,
                model_override: str | None = None,
                image_base64: str | None = None,
            ) -> ExtractResponse:
                async with self._admit():
                    raise RuntimeError("boom")

        backend = BrokenBackend()
        before = inflight_calls.labels(backend="broken-probe")._value.get()  # type: ignore[attr-defined]

        with pytest.raises(RuntimeError, match="boom"):
            await backend.extract(text="x", schema={}, hint=None)

        after = inflight_calls.labels(backend="broken-probe")._value.get()  # type: ignore[attr-defined]
        assert after == before, f"gauge leak: before={before} after={after}"


@pytest.mark.asyncio
async def test_semaphore_is_per_instance() -> None:
    """Разные экземпляры backend'а имеют отдельные семафоры (не sharing
    через class-level attribute)."""
    with patch("inference_service.backends.base.settings") as mock_settings:
        mock_settings.max_concurrent_calls = 1
        a = ProbeBackend()
        b = ProbeBackend()

        # Один call на каждый — оба должны успешно войти, потому что у
        # каждого свой semaphore размера 1.
        task_a = asyncio.create_task(a.extract(text="x", schema={}, hint=None))
        task_b = asyncio.create_task(b.extract(text="x", schema={}, hint=None))
        await asyncio.sleep(0.05)

        assert a.inside_count == 1
        assert b.inside_count == 1

        a.release.set()
        b.release.set()
        await asyncio.gather(task_a, task_b)


# ─── Route-level AdmissionGate ────────────────────────────────────────────────
# В отличие от backend-семафора, gate отвергает запросы поверх лимита
# с 503 + Retry-After, а не очередит их. Этот блок тестов проверяет, что
# (1) 5 параллельных /v1/extract при лимите 2 + slow backend дают 2 успеха
# и 3 отказа, (2) метрика inference_gate_rejections_total растёт на 3.


class SlowExtractBackend(ModelBackend):
    """Backend that just sleeps `sleep_seconds` inside extract.

    Used to hold gate slots long enough for follow-up requests to race
    into rejection. classify/vision/verify implemented trivially.
    """

    name = "slow"

    def __init__(self, sleep_seconds: float = 0.1) -> None:
        self.sleep_seconds = sleep_seconds

    def is_ready(self) -> bool:
        return True

    async def classify(self, text: str, model_override: str | None = None) -> ClassifyResponse:  # noqa: ARG002
        return ClassifyResponse(type=None, confidence=0.0)

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
        include_debug: bool = False,
        model_override: str | None = None,
        image_base64: str | None = None,
        reasoning_effort: str | None = None,
    ) -> ExtractResponse:
        await asyncio.sleep(self.sleep_seconds)
        return ExtractResponse(extracted={}, confidence=1.0, issues=[])

    async def vision_ocr(
        self, image_bytes: bytes, prompt: str | None, model_override: str | None = None
    ) -> VisionResponse:  # noqa: ARG002
        return VisionResponse(text="", confidence=0.0)

    async def verify(
        self, extracted: dict[str, Any], raw_text: str, model_override: str | None = None
    ) -> VerifyResponse:  # noqa: ARG002
        return VerifyResponse(extracted=extracted, issues=[])


@pytest.mark.asyncio
async def test_route_admission_gate_rejects_excess_with_503() -> None:
    """Gate at limit=2 + slow backend: 5 concurrent /v1/extract → 2 succeed, 3 get 503."""
    from inference_service.admission import AdmissionGate, get_admission_gate
    from inference_service.deps import get_backend
    from inference_service.main import app

    # Override gate to size 2.
    gate_override = AdmissionGate(limit=2)
    backend_override = SlowExtractBackend(sleep_seconds=0.2)

    app.dependency_overrides[get_admission_gate] = lambda: gate_override
    app.dependency_overrides[get_backend] = lambda: backend_override

    # Snapshot rejection counter before — it's a process-wide registry so other
    # tests may have bumped it.
    before = inference_gate_rejections_total._value.get()  # type: ignore[attr-defined]

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            payload = {"text": "hi", "schema": {"type": "object"}}
            responses = await asyncio.gather(
                *[client.post("/v1/extract", json=payload) for _ in range(5)],
                return_exceptions=True,
            )
    finally:
        app.dependency_overrides.pop(get_admission_gate, None)
        app.dependency_overrides.pop(get_backend, None)

    # Filter to actual httpx Responses (no transport errors).
    real_responses = [r for r in responses if isinstance(r, httpx.Response)]
    assert len(real_responses) == 5, f"expected 5 HTTP responses, got {responses}"

    statuses = [r.status_code for r in real_responses]
    succeeded = [s for s in statuses if s == 200]
    rejected = [r for r in real_responses if r.status_code == 503]

    assert len(succeeded) == 2, f"expected 2 successes, got statuses={statuses}"
    assert len(rejected) == 3, f"expected 3 rejections, got statuses={statuses}"

    # Every 503 must carry Retry-After (the contract that lets doc-service
    # back off rather than retry hot).
    for r in rejected:
        assert r.headers.get("retry-after") == "2", (
            f"rejection missing Retry-After: headers={dict(r.headers)}"
        )

    after = inference_gate_rejections_total._value.get()  # type: ignore[attr-defined]
    assert after - before == 3, f"rejection counter delta expected 3, got {after - before}"


@pytest.mark.asyncio
async def test_route_admission_gate_zero_disables() -> None:
    """limit=0 → gate отключён, все запросы проходят."""
    from inference_service.admission import AdmissionGate, get_admission_gate
    from inference_service.deps import get_backend
    from inference_service.main import app

    gate_override = AdmissionGate(limit=0)
    backend_override = SlowExtractBackend(sleep_seconds=0.05)

    app.dependency_overrides[get_admission_gate] = lambda: gate_override
    app.dependency_overrides[get_backend] = lambda: backend_override

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            payload = {"text": "hi", "schema": {"type": "object"}}
            responses = await asyncio.gather(
                *[client.post("/v1/extract", json=payload) for _ in range(5)],
            )
    finally:
        app.dependency_overrides.pop(get_admission_gate, None)
        app.dependency_overrides.pop(get_backend, None)

    statuses = [r.status_code for r in responses]
    assert all(s == 200 for s in statuses), f"limit=0 should pass all, got {statuses}"
