"""Tests for the ASR /v1/transcribe route + AsrTranscriber.

The external ASR HTTP server is mocked via `httpx.MockTransport`, so no
network and no real model. We verify:
  - availability gating (flag off / no base_url → not available, route 503),
  - the transcriber builds the right OpenAI-compatible multipart request,
  - it parses {text, duration} from the response,
  - the route validates base64 + empty body.
"""

import base64

import httpx
import pytest
from fastapi.testclient import TestClient

from inference_service import asr as asr_module
from inference_service.asr import AsrTranscriber, reset_transcriber
from inference_service.main import app


def _b64(data: bytes = b"\x00\x01\x02\x03fake-audio") -> str:
    return base64.b64encode(data).decode()


# --- AsrTranscriber.is_available gating ---

def test_not_available_when_disabled() -> None:
    t = AsrTranscriber(
        enabled=False, base_url="http://asr:9000/v1", model="m", api_key="", timeout_seconds=5
    )
    assert t.is_available() is False


def test_not_available_when_no_base_url() -> None:
    t = AsrTranscriber(
        enabled=True, base_url="", model="m", api_key="", timeout_seconds=5
    )
    assert t.is_available() is False


def test_available_when_enabled_and_base_url() -> None:
    t = AsrTranscriber(
        enabled=True, base_url="http://asr:9000/v1", model="m", api_key="", timeout_seconds=5
    )
    assert t.is_available() is True


# --- transcribe() request shape + response parsing (mocked HTTP) ---

@pytest.mark.asyncio
async def test_transcribe_builds_request_and_parses_text(monkeypatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["content_type"] = request.headers.get("content-type", "")
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = request.content
        return httpx.Response(200, json={"text": " привет мир ", "duration": 3.5})

    # Patch the AsyncClient used inside the module so our MockTransport is wired.
    real_async_client = httpx.AsyncClient

    def fake_async_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(asr_module.httpx, "AsyncClient", fake_async_client)

    t = AsrTranscriber(
        enabled=True,
        base_url="http://asr:9000/v1",
        model="whisper-large-v3",
        api_key="secret-key",
        timeout_seconds=30,
    )
    res = await t.transcribe(audio_bytes=b"RIFFxxxxWAVE", mime_type="audio/wav", language="ru")

    # Endpoint is the OpenAI-compatible transcriptions path.
    assert captured["url"] == "http://asr:9000/v1/audio/transcriptions"
    assert captured["method"] == "POST"
    assert "multipart/form-data" in captured["content_type"]
    assert captured["auth"] == "Bearer secret-key"
    # Multipart body carries model + language + the file.
    body = captured["body"]
    assert b"whisper-large-v3" in body
    assert b'name="language"' in body and b"ru" in body
    assert b'name="file"' in body
    assert b"audio.wav" in body  # filename derived from MIME

    # Response parsed; text trimmed; duration surfaced; confidence None.
    assert res.text == "привет мир"
    assert res.duration_s == 3.5
    assert res.confidence is None


@pytest.mark.asyncio
async def test_transcribe_handles_plain_text_response(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="just text", headers={"content-type": "text/plain"})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        asr_module.httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}),
    )
    t = AsrTranscriber(
        enabled=True, base_url="http://asr:9000/v1", model="m", api_key="", timeout_seconds=5
    )
    res = await t.transcribe(audio_bytes=b"xx", mime_type="audio/mpeg")
    assert res.text == "just text"


@pytest.mark.asyncio
async def test_transcribe_no_api_key_omits_auth_header(monkeypatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"text": "ok"})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        asr_module.httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}),
    )
    t = AsrTranscriber(
        enabled=True, base_url="http://asr:9000/v1", model="m", api_key="", timeout_seconds=5
    )
    await t.transcribe(audio_bytes=b"xx", mime_type="audio/ogg")
    assert captured["auth"] is None


# --- Route-level (TestClient) ---

# NOTE on test isolation: other test files (test_providers_status) reload
# `inference_service.config`, which swaps `config.settings` for a fresh object.
# `inference_service.asr` imported settings with `from .config import settings`,
# so `asr_module.settings` is the *stable* reference `get_transcriber()` actually
# reads. We patch THAT object (not config.settings) so these tests are immune to
# the reload, regardless of suite ordering.
@pytest.fixture(autouse=True)
def _reset(monkeypatch) -> None:
    # Pin no-auth dev mode (matches conftest API_KEY="") so route tests don't
    # inherit an api_key leaked by another test file's unrestored monkeypatch.
    monkeypatch.setattr(asr_module.settings, "api_key", "", raising=False)
    reset_transcriber()
    yield
    reset_transcriber()


def test_route_503_when_asr_disabled(monkeypatch) -> None:
    # Default settings → asr_enabled=False → route should 503.
    monkeypatch.setattr(asr_module.settings, "asr_enabled", False)
    reset_transcriber()
    with TestClient(app) as client:
        r = client.post(
            "/v1/transcribe", json={"audio_base64": _b64(), "mime_type": "audio/wav"}
        )
    assert r.status_code == 503


def test_route_rejects_invalid_base64(monkeypatch) -> None:
    monkeypatch.setattr(asr_module.settings, "asr_enabled", True)
    monkeypatch.setattr(asr_module.settings, "asr_base_url", "http://asr:9000/v1")
    reset_transcriber()
    with TestClient(app) as client:
        r = client.post(
            "/v1/transcribe", json={"audio_base64": "not-base64!@#", "mime_type": "audio/wav"}
        )
    assert r.status_code == 400


def test_route_rejects_empty_audio(monkeypatch) -> None:
    monkeypatch.setattr(asr_module.settings, "asr_enabled", True)
    monkeypatch.setattr(asr_module.settings, "asr_base_url", "http://asr:9000/v1")
    reset_transcriber()
    with TestClient(app) as client:
        # empty base64 string fails schema min_length → 422
        r = client.post("/v1/transcribe", json={"audio_base64": "", "mime_type": "audio/wav"})
    assert r.status_code in (400, 422)


def test_route_success_with_mocked_asr(monkeypatch) -> None:
    monkeypatch.setattr(asr_module.settings, "asr_enabled", True)
    monkeypatch.setattr(asr_module.settings, "asr_base_url", "http://asr:9000/v1")
    monkeypatch.setattr(asr_module.settings, "asr_model", "whisper-large-v3")
    reset_transcriber()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"text": "Счёт на оплату номер 5", "duration": 2.0})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        asr_module.httpx,
        "AsyncClient",
        lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}),
    )

    with TestClient(app) as client:
        r = client.post(
            "/v1/transcribe",
            json={"audio_base64": _b64(), "mime_type": "audio/wav", "language": "ru"},
        )
    assert r.status_code == 200
    data = r.json()
    assert data["text"] == "Счёт на оплату номер 5"
    assert data["duration_s"] == 2.0
    assert data["confidence"] is None
