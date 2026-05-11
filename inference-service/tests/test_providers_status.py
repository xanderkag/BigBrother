"""Tests for /v1/providers/status and ClaudeBackend init behaviour.

We don't make real Anthropic API calls — that requires a key and costs
tokens. The tests focus on:
  - status endpoint reports configured-ness flags correctly per env state
  - ClaudeBackend constructor with empty key stays not_ready and doesn't
    crash on import (lazy SDK import inside _load)
  - Active backend name is reflected in status payload
"""

import os

import pytest
from fastapi.testclient import TestClient


def _can_import_anthropic() -> bool:
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def _reload_app(monkeypatch_env: dict[str, str]) -> TestClient:
    """Fresh app + reloaded config under a controlled env.

    We invalidate Python's module cache for the few inference-service
    modules that read settings at import time. The lru_cache on
    get_backend is invalidated by re-importing.
    """
    import importlib

    for k, v in monkeypatch_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

    # Reload the modules that snapshot env at import time.
    import inference_service.config as cfg
    importlib.reload(cfg)
    import inference_service.deps as deps
    importlib.reload(deps)
    import inference_service.routes.providers as providers
    importlib.reload(providers)
    import inference_service.main as main
    importlib.reload(main)

    main.app.state.backend = deps.get_backend()
    return TestClient(main.app)


def test_status_reports_stub_active_with_no_keys() -> None:
    client = _reload_app({
        "BACKEND": "stub",
        "ANTHROPIC_API_KEY": "",
        "OPENAI_API_KEY": "",
        "API_KEY": "",
    })
    r = client.get("/v1/providers/status")
    assert r.status_code == 200
    body = r.json()
    assert body["active"] == "stub"
    assert body["available"]["stub"]["configured"] is True
    assert body["available"]["claude"]["configured"] is False
    assert body["available"]["claude"]["model"] is None  # never reveal model when not configured
    assert body["available"]["openai"]["configured"] is False
    # qwen has no API key — `configured` reflects "weights resolvable", which
    # is True at the config level (we trust HF cache or download).
    assert body["available"]["qwen"]["configured"] is True


def test_status_reports_claude_configured_when_key_set() -> None:
    client = _reload_app({
        "BACKEND": "stub",  # not active, but configured
        "ANTHROPIC_API_KEY": "sk-ant-fake-test-key",
        "API_KEY": "",
    })
    r = client.get("/v1/providers/status")
    body = r.json()
    assert body["available"]["claude"]["configured"] is True
    assert body["available"]["claude"]["model"] is not None
    # Active is unchanged — config flag and active backend are independent.
    assert body["active"] == "stub"


def test_status_respects_auth() -> None:
    client = _reload_app({
        "BACKEND": "stub",
        "API_KEY": "secret123",
    })
    # No header — 401.
    r = client.get("/v1/providers/status")
    assert r.status_code == 401
    # With header — 200.
    r = client.get("/v1/providers/status", headers={"Authorization": "Bearer secret123"})
    assert r.status_code == 200


def test_claude_backend_constructs_without_key_but_not_ready() -> None:
    """ClaudeBackend should not blow up on instantiation when key is empty —
    important because get_providers_status / app boot may evaluate config
    paths even when claude isn't the active backend."""
    from inference_service.backends.claude import ClaudeBackend

    backend = ClaudeBackend(api_key="", model_id="claude-test", max_tokens=512)
    assert backend.name == "claude"
    assert backend.is_ready() is False


@pytest.mark.skipif(
    not _can_import_anthropic(),
    reason="anthropic SDK not installed; skip live-init test",
)
def test_claude_backend_initialises_when_anthropic_installed() -> None:
    """If the anthropic package is installed (it is, per requirements-claude),
    instantiating with any non-empty key should succeed without making a
    network call. The actual auth check happens on first `messages.create`."""
    from inference_service.backends.claude import ClaudeBackend

    backend = ClaudeBackend(api_key="sk-ant-fake", model_id="claude-test", max_tokens=512)
    assert backend.is_ready() is True
