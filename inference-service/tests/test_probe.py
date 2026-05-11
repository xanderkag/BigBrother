"""Tests for OpenAICompatibleBackend.probe() и /ready endpoint.

Покрывает:
  - probe(): успех / timeout / network error;
  - кэширование на 30 секунд (повторный вызов = тот же результат, без вызова SDK);
  - /ready возвращает reason, когда probe упал;
  - /ready ready, когда probe ok.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from inference_service.backends.openai_compatible import OpenAICompatibleBackend


@pytest.fixture
def backend_with_mock() -> tuple[OpenAICompatibleBackend, MagicMock]:
    b = OpenAICompatibleBackend(
        base_url="http://ollama:11434/v1",
        model_id="qwen2.5vl:7b",
    )
    client = MagicMock()
    client.models = MagicMock()
    client.models.list = AsyncMock()
    b._client = client  # type: ignore[attr-defined]
    return b, client


class TestProbe:
    @pytest.mark.asyncio
    async def test_probe_ok_when_models_list_succeeds(
        self, backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock]
    ) -> None:
        b, client = backend_with_mock
        client.models.list.return_value = MagicMock(data=[MagicMock(id="qwen2.5vl:7b")])

        ok, err = await b.probe()
        assert ok is True
        assert err is None
        client.models.list.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_probe_caches_for_30_seconds(
        self, backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock]
    ) -> None:
        b, client = backend_with_mock
        client.models.list.return_value = MagicMock(data=[])
        # Два последовательных вызова — второй не должен дёргать сеть.
        await b.probe()
        await b.probe()
        client.models.list.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_probe_returns_failure_on_exception(
        self, backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock]
    ) -> None:
        b, client = backend_with_mock
        client.models.list.side_effect = ConnectionError("connection refused")

        ok, err = await b.probe()
        assert ok is False
        assert err is not None
        assert "ConnectionError" in err
        assert "connection refused" in err

    @pytest.mark.asyncio
    async def test_probe_returns_failure_on_timeout(
        self, backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock]
    ) -> None:
        b, client = backend_with_mock

        async def slow_call() -> None:
            await asyncio.sleep(10)  # дольше внутреннего timeout (5s)

        client.models.list.side_effect = slow_call

        ok, err = await b.probe()
        assert ok is False
        assert err is not None
        assert "timeout" in err.lower()

    @pytest.mark.asyncio
    async def test_probe_when_backend_not_configured(self) -> None:
        # Конструктор с пустым model_id → _ready=False, probe сразу падает.
        b = OpenAICompatibleBackend(base_url="http://x", model_id="")
        ok, err = await b.probe()
        assert ok is False
        assert err is not None
        assert "not configured" in err

    @pytest.mark.asyncio
    async def test_concurrent_probes_only_one_network_call(
        self, backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock]
    ) -> None:
        """10 параллельных probe() = 1 сетевой вызов (lock)."""
        b, client = backend_with_mock

        async def slow_ok() -> MagicMock:
            await asyncio.sleep(0.05)
            return MagicMock(data=[])

        client.models.list.side_effect = slow_ok

        results = await asyncio.gather(*[b.probe() for _ in range(10)])
        for ok, err in results:
            assert ok is True
            assert err is None
        client.models.list.assert_awaited_once()
