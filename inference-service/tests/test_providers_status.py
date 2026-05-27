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


# Env keys these tests flip. We snapshot/restore them around every test so a
# reload (which mutates os.environ + the global module cache) can't leak a
# stale API_KEY into other test files that share the session-scoped app.
_ENV_KEYS = ("BACKEND", "API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")


def _reload_modules() -> "object":
    """Reload modules that snapshot env at import time, in dependency order.

    config first (rebuilds the settings singleton), then every module that
    binds `from .config import settings` at import — otherwise it keeps a
    stale reference to the pre-reload settings. `auth` must be reloaded before
    `routes.providers` (which imports `require_api_key`) and `main`.
    """
    import importlib

    import inference_service.config as cfg
    importlib.reload(cfg)
    import inference_service.auth as auth
    importlib.reload(auth)
    import inference_service.deps as deps
    importlib.reload(deps)
    import inference_service.routes.providers as providers
    importlib.reload(providers)
    import inference_service.main as main
    importlib.reload(main)
    return main


# Modules whose object identity in sys.modules other test files depend on:
# `test_concurrency` and `test_routes` do `from inference_service.main import
# app` and override deps on it. `_reload_app` swaps these for fresh objects;
# we restore the originals in teardown so later files get the shared app back.
_IDENTITY_MODULES = (
    "inference_service.main",
    "inference_service.deps",
    "inference_service.routes.providers",
)


@pytest.fixture(autouse=True)
def _restore_env():
    """Isolate each providers test's reload from the rest of the suite.

    Two leaks to plug:
      1. `importlib.reload(auth)` mutates the *existing* auth module dict in
         place, so the conftest session-scoped app's already-bound
         `require_api_key` (whose `__globals__` IS that dict) starts seeing our
         `API_KEY=secret123`. → restore env, then reload config+auth so
         `auth.settings.api_key` snaps back to the conftest default ("").
      2. `_reload_app` replaces `inference_service.{main,deps,...}` in
         sys.modules with fresh objects. Later files (`test_concurrency`,
         `test_routes`) import `main.app` and override deps on it — they must
         get the *original* shared app (with its cached backend + intact gate
         dependency identity), not our throwaway reload. → snapshot the
         original module objects and put them back."""
    import importlib
    import sys

    saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
    saved_modules = {name: sys.modules.get(name) for name in _IDENTITY_MODULES}
    try:
        yield
    finally:
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        import inference_service.config as cfg
        importlib.reload(cfg)
        import inference_service.auth as auth
        importlib.reload(auth)
        for name, mod in saved_modules.items():
            if mod is not None:
                sys.modules[name] = mod
        # The reloaded `deps` left a throwaway lru_cache; the restored original
        # `deps.get_backend` may still hold a backend built under our flipped
        # BACKEND env. Drop it so later tests rebuild against restored config.
        restored_deps = saved_modules["inference_service.deps"]
        if restored_deps is not None:
            restored_deps.get_backend.cache_clear()


def _reload_app(monkeypatch_env: dict[str, str]) -> TestClient:
    """Fresh app + reloaded config under a controlled env.

    We invalidate Python's module cache for the few inference-service
    modules that read settings at import time. The lru_cache on
    get_backend is invalidated by re-importing. Env mutations are reverted
    by the autouse `_restore_env_and_modules` fixture after each test.
    """
    for k, v in monkeypatch_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

    main = _reload_modules()
    import inference_service.deps as deps

    main.app.state.backend = deps.get_backend()  # type: ignore[attr-defined]
    return TestClient(main.app)  # type: ignore[attr-defined]


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
