"""VANGA-LLM-2: per-request backend resolution.

The route layer used to depend on a single env-selected backend singleton
(`get_backend`). `resolve_backend` lets a request carry an explicit
backend / base_url / api_key (doc-service resolves these from
provider_settings), so cloud ↔ local ↔ gpu switches per-instance without
restarting the service. These tests pin the contract:

  - no override  → the env singleton (unchanged behaviour);
  - override     → a backend built for that tuple, memoised by tuple.
"""

import os

# Match conftest: settings read at import, force stub env backend.
os.environ.setdefault("BACKEND", "stub")
os.environ.setdefault("API_KEY", "")

import pytest

from inference_service.backends.openai_compatible import OpenAICompatibleBackend
from inference_service.backends.stub import StubBackend
from inference_service.config import settings
from inference_service.deps import get_backend, resolve_backend


def test_no_override_returns_env_singleton() -> None:
    # No override → exactly the env singleton object (identity, not just type).
    # Identity is the real invariant; the concrete kind depends on the env
    # (.env may set any BACKEND), so we don't assert a specific class here.
    assert resolve_backend() is get_backend()
    assert resolve_backend(None, None, None) is get_backend()


def test_override_openai_compat_uses_request_base_url() -> None:
    b = resolve_backend(backend="openai_compat", base_url="http://gpu-vllm:8000/v1")
    assert isinstance(b, OpenAICompatibleBackend)
    # Request base_url wins over the env preset (which is empty in tests).
    assert b.base_url == "http://gpu-vllm:8000/v1"


def test_override_is_memoised_by_tuple() -> None:
    # Same (kind, base_url, api_key) → same instance (LRU cache), so repeated
    # per-request overrides reuse the client/SDK rather than reconnecting.
    a = resolve_backend(backend="openai_compat", base_url="http://ollama:11434/v1")
    b = resolve_backend(backend="openai_compat", base_url="http://ollama:11434/v1")
    assert a is b
    # Different upstream endpoint → different instance (local vs gpu coexist).
    c = resolve_backend(backend="openai_compat", base_url="http://gpu:8000/v1")
    assert c is not a
    assert c.base_url == "http://gpu:8000/v1"


def test_default_backend_is_honoured_without_override() -> None:
    # The route passes its DI-injected backend as `default`. With no override,
    # resolve_backend returns exactly that object — this is what keeps
    # app.dependency_overrides[get_backend] working (tests inject a backend).
    sentinel = StubBackend()
    assert resolve_backend(default=sentinel) is sentinel


def test_override_wins_over_default() -> None:
    # An explicit override is honoured even when a DI default is supplied.
    sentinel = StubBackend()
    b = resolve_backend(
        backend="openai_compat", base_url="http://ollama:11434/v1", default=sentinel
    )
    assert b is not sentinel


# ── MTI-3: no_key_configured для облачных бэкендов без ключа ──────────────────


def test_claude_without_key_raises_no_key_configured(monkeypatch) -> None:
    # LLM-ключ приходит в body.api_key (из UI Providers). Если его нет НИ в
    # запросе, НИ в env ANTHROPIC_API_KEY — внятная ошибка, а не пустой SDK.
    monkeypatch.setattr(settings, "anthropic_api_key", "", raising=False)
    with pytest.raises(ValueError, match="no_key_configured"):
        resolve_backend(backend="claude")


def test_claude_uses_request_key_over_env(monkeypatch) -> None:
    # Ключ из body приоритетнее env-fallback (MTI-3 §Acceptance).
    monkeypatch.setattr(settings, "anthropic_api_key", "env-key", raising=False)
    b = resolve_backend(backend="claude", api_key="body-key-from-ui")
    assert b.api_key == "body-key-from-ui"


def test_openai_cloud_without_key_raises(monkeypatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "", raising=False)
    with pytest.raises(ValueError, match="no_key_configured"):
        resolve_backend(backend="openai")


def test_openai_compat_local_needs_no_key() -> None:
    # Локальный OpenAI-совместимый (Ollama/vLLM) работает без ключа — ошибки нет.
    b = resolve_backend(backend="openai_compat", base_url="http://ollama:11434/v1")
    assert isinstance(b, OpenAICompatibleBackend)
    assert isinstance(b, OpenAICompatibleBackend)


def test_base_url_without_backend_defaults_to_openai_compat() -> None:
    # Footgun guard (review VANGA-LLM-2): base_url set but backend omitted
    # (admin set extra.upstream_base_url but not extra.backend) must build an
    # openai_compat backend at that url — NOT fall back to settings.backend
    # ('stub' on Asha), which would silently discard base_url and serve canned
    # stub output with HTTP 200.
    b = resolve_backend(base_url="http://gpu-vllm:8000/v1")
    assert isinstance(b, OpenAICompatibleBackend)
    assert b.base_url == "http://gpu-vllm:8000/v1"


def test_override_empty_base_url_falls_back_to_env_preset() -> None:
    # backend override but no base_url → openai_compat falls back to the env
    # OPENAI_BASE_URL preset (whatever it is in this environment). Still a
    # distinct openai_compat backend, not the stub singleton.
    b = resolve_backend(backend="openai_compat")
    assert isinstance(b, OpenAICompatibleBackend)
    assert b.base_url == settings.openai_base_url.rstrip("/")
