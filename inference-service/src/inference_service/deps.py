from functools import lru_cache

from .backends.base import ModelBackend
from .config import settings


@lru_cache(maxsize=16)
def _cached_backend(kind: str, base_url: str, api_key: str) -> ModelBackend:
    """Build (and memoise) a backend for an explicit (kind, base_url, api_key).

    Heavy backends (Qwen weights, OpenAI-compat connecting to a remote
    server) import their SDKs inside the branch so the stub container can
    run without those deps at all.

    Empty-string `base_url` / `api_key` mean «fall back to the env preset
    for that field». Cached (LRU 16) so repeated per-request overrides
    reuse the same client/SDK instance instead of reconnecting every call.
    `model` is NOT a key here — it is applied per-call via `model_override`,
    so one openai_compat client serves many models.
    """
    if kind == "stub":
        from .backends.stub import StubBackend

        return StubBackend()

    if kind == "claude":
        from .backends.claude import ClaudeBackend

        # MTI-3: LLM-ключ приходит в body.api_key (из UI Providers doc-service),
        # env ANTHROPIC_API_KEY — dev-fallback. Если нет НИ там, НИ там — раньше
        # в SDK уходил пустой ключ и падало криптично уже на вызове. Теперь —
        # внятная ошибка сразу (приёмка MTI-3 §Acceptance).
        key = api_key or settings.anthropic_api_key
        if not key:
            raise ValueError(
                "no_key_configured: нет ключа Anthropic — ни в запросе (body.api_key "
                "из UI Providers), ни в ANTHROPIC_API_KEY (dev-fallback)"
            )
        return ClaudeBackend(
            api_key=key,
            model_id=settings.anthropic_model_id,
            max_tokens=settings.anthropic_max_tokens,
            timeout_seconds=settings.anthropic_timeout_seconds,
        )

    if kind == "openai":
        # `openai` == cloud OpenAI без `base_url`. Используется тот же
        # OpenAICompatibleBackend — без base_url он ходит на api.openai.com.
        from .backends.openai_compatible import OpenAICompatibleBackend

        key = api_key or settings.openai_api_key
        if not key:
            raise ValueError(
                "no_key_configured: нет ключа OpenAI — ни в запросе (body.api_key), "
                "ни в OPENAI_API_KEY (dev-fallback)"
            )
        return OpenAICompatibleBackend(
            base_url=base_url,  # обычно "" → api.openai.com
            model_id=settings.openai_model,
            api_key=key,
            max_tokens=settings.openai_max_tokens,
            timeout_seconds=settings.openai_timeout_seconds,
        )

    if kind == "openai_compat":
        # Локальный или альтернативный OpenAI-совместимый сервер
        # (Ollama, vLLM, llama.cpp, LM Studio, SGLang, TGI, etc).
        # base_url="" → env-пресет (settings.openai_base_url); непустой —
        # per-request upstream (напр. GPU-vLLM у одного инстанса, локальный
        # Ollama у другого) без рестарта сервиса.
        from .backends.openai_compatible import OpenAICompatibleBackend

        return OpenAICompatibleBackend(
            base_url=base_url or settings.openai_base_url,
            model_id=settings.openai_model,
            api_key=api_key or settings.openai_api_key,
            max_tokens=settings.openai_max_tokens,
            timeout_seconds=settings.openai_timeout_seconds,
        )

    if kind == "qwen":
        from .backends.qwen_vl import QwenVlBackend

        return QwenVlBackend(
            model_id=settings.qwen_model_id,
            device=settings.qwen_device,
            dtype=settings.qwen_dtype,
            max_new_tokens=settings.qwen_max_new_tokens,
        )

    raise RuntimeError(f"unknown backend: {kind}")


@lru_cache(maxsize=1)
def get_backend() -> ModelBackend:
    """Lazy-loaded singleton backend from env (`settings.backend`).

    This is the default when a request carries no per-request override —
    behaviour identical to before VANGA-LLM-2. Delegates to
    `_cached_backend`; empty base_url/api_key make it fall back to the
    env presets for the active kind.
    """
    return _cached_backend(settings.backend, "", "")


def resolve_backend(
    backend: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    *,
    default: ModelBackend | None = None,
) -> ModelBackend:
    """Per-request backend resolution (VANGA-LLM-2).

    No override (backend/base_url/api_key all falsy) → `default` if the route
    passed its DI-injected backend (`Depends(get_backend)`), else the env
    singleton. Keeping the DI-injected default is what preserves
    `app.dependency_overrides[get_backend]` (tests inject a controlled
    backend) — the override just layers on top.

    When a request carries a `backend`/`base_url`/`api_key` (doc-service
    resolved it from `provider_settings` of the calling instance), build/reuse
    a backend for that tuple so cloud ↔ local ↔ gpu switches per-instance
    **without restarting** the inference-service.

    Trust: only doc-service reaches this route (require_api_key). The
    override values originate from admin-controlled provider_settings, not
    from arbitrary external callers — so accepting base_url/api_key here is
    the same trust level as accepting the document text.
    """
    if not backend and not base_url and not api_key:
        return default if default is not None else get_backend()
    # A per-request base_url is meaningful ONLY for an OpenAI-compatible
    # upstream. If the caller supplied base_url but omitted the kind (e.g.
    # admin set provider_settings.extra.upstream_base_url but not .backend),
    # default to openai_compat — NOT settings.backend, which on Asha is 'stub'
    # and would silently discard base_url and serve canned stub output. Bare
    # api_key (no base_url) keeps the env kind: it just swaps the cloud key.
    kind = backend or ("openai_compat" if base_url else settings.backend)
    # NOTE: a per-request kind="qwen" would build QwenVlBackend here, whose
    # __init__ blocks on from_pretrained (weight load) on the event loop. That
    # path is unsupported (qwen is loaded once via env, never hot-swapped
    # per-request) and unreachable on CPU hosts; doc-service only ever sends
    # "openai_compat"/"claude"/"openai" via extra.backend.
    return _cached_backend(kind, base_url or "", api_key or "")


def get_providers_status() -> dict[str, object]:
    """Snapshot of provider configuration for /v1/providers/status.

    Reports configured-ness (do we have credentials/weights?) separately
    from active-ness (is this the backend currently serving requests?).
    The operator UI uses both: configured providers are switch candidates,
    the active one is highlighted.

    No SDK initialisation here — this endpoint must respond in
    milliseconds even when Qwen would take minutes to load.
    """
    # openai_compat считается configured, если задан и base_url, и model.
    # base_url пустой → это «облачный OpenAI», его освещает запись
    # `openai`. Так что openai_compat = только локальные/альтернативные.
    openai_compat_configured = bool(settings.openai_base_url and settings.openai_model)
    return {
        "active": settings.backend,
        # ASR (speech-to-text) — independent of the model backend. Reported
        # so the operator UI can tell whether the audio ingestion path is wired.
        "asr": {
            "enabled": settings.asr_enabled,
            "configured": settings.asr_enabled and bool(settings.asr_base_url),
            "model": settings.asr_model or None,
            "description": (
                "Speech-to-text via external OpenAI-compatible /audio/transcriptions "
                "server. Requires ASR_ENABLED=true + ASR_BASE_URL. Model-agnostic."
            ),
        },
        "available": {
            "stub": {
                "configured": True,
                "model": None,
                "description": "Deterministic fallback. CI/dev only — no real inference.",
            },
            "claude": {
                "configured": bool(settings.anthropic_api_key),
                "model": settings.anthropic_model_id if settings.anthropic_api_key else None,
                "description": "Anthropic Claude via API. Requires ANTHROPIC_API_KEY.",
            },
            "openai": {
                "configured": bool(settings.openai_api_key) and not settings.openai_base_url,
                "model": settings.openai_model if settings.openai_api_key else None,
                "description": (
                    "OpenAI cloud (api.openai.com). Requires OPENAI_API_KEY. "
                    "Если задан OPENAI_BASE_URL — конфиг попадёт в openai_compat вместо."
                ),
            },
            "openai_compat": {
                "configured": openai_compat_configured,
                "model": settings.openai_model if openai_compat_configured else None,
                "description": (
                    "OpenAI-совместимый локальный сервер: Ollama / vLLM / llama.cpp / LM Studio. "
                    "Требует OPENAI_BASE_URL + OPENAI_MODEL. Лучший путь для локальных моделей."
                ),
            },
            "qwen": {
                "configured": True,  # weights resolved at runtime; no API key needed
                "model": settings.qwen_model_id,
                "description": (
                    "Qwen-VL напрямую через transformers. Требует GPU + [qwen] extras. "
                    "Для большинства задач предпочтительнее backend=openai_compat + Ollama/vLLM."
                ),
            },
        },
    }
