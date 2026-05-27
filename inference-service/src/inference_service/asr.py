"""ASR (speech-to-text) — «OCR for audio».

Транскрайбер — это HTTP-клиент к **внешнему** ASR-серверу. Он не зависит
от выбранного `backend` (Claude/Qwen/stub): аудио → ASR-сервер → текст,
после чего downstream-пайплайн остаётся прежним.

Контракт (model-agnostic, endpoint-configurable):
    POST {ASR_BASE_URL}/audio/transcriptions
    Content-Type: multipart/form-data
    fields:
        file     — аудио-байты (filename + content-type из MIME запроса)
        model    — ASR_MODEL (имя модели на сервере)
        language — опционально (ISO 639-1)
    response (200, application/json):
        {"text": "...", "duration": <float?>}  # duration опционален

Это **OpenAI-совместимый** `/v1/audio/transcriptions` контракт, на котором
говорят faster-whisper-server, whisper.cpp server, vLLM-whisper и большинство
локальных ASR-серверов. «Простая модель на сервере» в другом окружении
реализует ровно этот контракт → подключение = только env, без правок кода.

Ключ (`ASR_API_KEY`) обычно пустой для локального сервера; если задан —
уходит как `Authorization: Bearer <key>`.
"""

import logging
from typing import Any

import httpx

from .config import settings
from .schemas import TranscribeResponse

log = logging.getLogger("inference-service.asr")


# Минимальный маппинг MIME → (filename, content_type) для multipart-поля
# `file`. Имя файла само по себе серверу не важно, но расширение помогает
# некоторым серверам выбрать декодер; content-type дублирует MIME.
_MIME_EXT = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/flac": "flac",
    "audio/webm": "webm",
}


class AsrUnavailableError(RuntimeError):
    """ASR сконфигурирован неполно (нет base_url) или выключен флагом."""


class AsrTranscriber:
    """Клиент к OpenAI-совместимому ASR-серверу.

    `is_available()` — структурная проверка (включён флаг И задан base_url).
    Реальные ошибки коннекта поднимаются на вызове `transcribe`.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        base_url: str,
        model: str,
        api_key: str,
        timeout_seconds: float,
    ) -> None:
        self._enabled = enabled
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._timeout = timeout_seconds

    def is_available(self) -> bool:
        return self._enabled and bool(self._base_url)

    def _filename_and_type(self, mime_type: str) -> tuple[str, str]:
        ext = _MIME_EXT.get(mime_type.lower().split(";", 1)[0].strip(), "bin")
        return f"audio.{ext}", mime_type

    async def transcribe(
        self,
        *,
        audio_bytes: bytes,
        mime_type: str,
        language: str | None = None,
    ) -> TranscribeResponse:
        if not self.is_available():
            raise AsrUnavailableError(
                "ASR not available: set ASR_ENABLED=true and ASR_BASE_URL"
            )

        url = f"{self._base_url}/audio/transcriptions"
        filename, content_type = self._filename_and_type(mime_type)

        # OpenAI-совместимый multipart: file + model (+ language).
        files = {"file": (filename, audio_bytes, content_type)}
        data: dict[str, str] = {}
        if self._model:
            data["model"] = self._model
        if language:
            data["language"] = language

        headers: dict[str, str] = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(url, files=files, data=data, headers=headers)
            resp.raise_for_status()
            payload = self._parse_payload(resp)

        text = payload.get("text")
        if not isinstance(text, str):
            raise ValueError(
                f"ASR server response missing string `text` field: {payload!r}"
            )

        duration = payload.get("duration")
        duration_s = float(duration) if isinstance(duration, (int, float)) else None

        return TranscribeResponse(
            text=text.strip(),
            duration_s=duration_s,
            # OpenAI transcriptions-контракт не отдаёт per-clip confidence;
            # оставляем None — doc-service подставит дефолт downstream.
            confidence=None,
        )

    @staticmethod
    def _parse_payload(resp: httpx.Response) -> dict[str, Any]:
        # Большинство серверов отдают JSON. Некоторые при response_format=text
        # вернут plain text — оборачиваем в {"text": ...} fail-soft.
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype:
            body = resp.json()
            if isinstance(body, dict):
                return body
            raise ValueError(f"ASR server returned non-object JSON: {body!r}")
        return {"text": resp.text}


_transcriber: AsrTranscriber | None = None


def get_transcriber() -> AsrTranscriber:
    """FastAPI dependency — singleton, построенный из settings."""
    global _transcriber
    if _transcriber is None:
        _transcriber = AsrTranscriber(
            enabled=settings.asr_enabled,
            base_url=settings.asr_base_url,
            model=settings.asr_model,
            api_key=settings.asr_api_key,
            timeout_seconds=settings.asr_timeout_seconds,
        )
    return _transcriber


def reset_transcriber() -> None:
    """Test helper — сбросить кэш, чтобы следующий get_transcriber()
    перечитал текущие settings (monkeypatch)."""
    global _transcriber
    _transcriber = None
