"""OpenAICompatibleBackend unit tests.

Cтратегия — мокаем `openai.AsyncOpenAI` через `unittest.mock`, чтобы:
  - не требовать живой Ollama / OpenAI ключа;
  - проверить корректность кодирования сообщений (text-only, image data URL);
  - убедиться, что response_format=json_object выставляется для
    classify/extract/verify и не выставляется для vision_ocr;
  - убедиться в graceful fallback'е при ошибке «json mode not supported»;
  - проверить парсинг JSON-ответа модели (включая обёрнутый в markdown).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from inference_service.backends.openai_compatible import OpenAICompatibleBackend


def _make_response(content: str) -> Any:
    """Имитируем форму ответа openai SDK: response.choices[0].message.content."""
    return SimpleNamespace(
        choices=[
            SimpleNamespace(message=SimpleNamespace(content=content)),
        ],
    )


@pytest.fixture
def backend_with_mock_client() -> tuple[OpenAICompatibleBackend, MagicMock]:
    """Construct backend, stub out the openai client с AsyncMock."""
    b = OpenAICompatibleBackend(
        base_url="http://ollama:11434/v1",
        model_id="qwen2.5vl:7b",
    )
    mock_client = MagicMock()
    mock_client.chat = MagicMock()
    mock_client.chat.completions = MagicMock()
    mock_client.chat.completions.create = AsyncMock()
    b._client = mock_client  # type: ignore[attr-defined]
    return b, mock_client


@pytest.mark.asyncio
async def test_classify_passes_json_mode(backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock]) -> None:
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response(
        '{"type": "invoice", "confidence": 0.92}'
    )
    r = await b.classify("Счёт на оплату № 1")
    assert r.type == "invoice"
    assert r.confidence == pytest.approx(0.92)

    args = client.chat.completions.create.call_args
    assert args.kwargs["model"] == "qwen2.5vl:7b"
    assert args.kwargs["response_format"] == {"type": "json_object"}
    assert args.kwargs["temperature"] == 0.0
    # text-only сообщение
    assert args.kwargs["messages"][0]["role"] == "user"
    assert isinstance(args.kwargs["messages"][0]["content"], str)


@pytest.mark.asyncio
async def test_extract_returns_structured(backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock]) -> None:
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response(
        '{"extracted": {"number": "A-1", "total": 1000}, '
        '"confidence": 0.85, "issues": []}'
    )
    r = await b.extract(text="some text", schema={"type": "object"}, hint="invoice")
    assert r.extracted == {"number": "A-1", "total": 1000}
    assert r.confidence == pytest.approx(0.85)
    assert r.issues == []


@pytest.mark.asyncio
async def test_extract_tolerates_markdown_wrapped_json(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    """Многие открытые модели заворачивают JSON в ```json блок."""
    b, client = backend_with_mock_client
    wrapped = '```json\n{"extracted": {"number": "X"}, "confidence": 0.5, "issues": []}\n```'
    client.chat.completions.create.return_value = _make_response(wrapped)
    r = await b.extract(text="t", schema={}, hint=None)
    assert r.extracted == {"number": "X"}


@pytest.mark.asyncio
async def test_extract_recovers_unwrapped_phi4_response(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    """bench 2026-05-25: phi4 теряет обёртку `extracted` и складывает поля на
    верхний уровень под не-каноническими ключами. Backend должен восстановить
    данные (раньше — молча выбрасывал, ИНН 0/8)."""
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response(
        '{"seller": {"inn": "7811472920"}, "buyer": {"inn": "7704217370"}, '
        '"invoice_details": {"invoice_number": "0134905056-0281", "total_amount": 522.0}, '
        '"confidence": 0.8}'
    )
    r = await b.extract(text="t", schema={"type": "object"}, hint="invoice")
    assert r.extracted["seller"]["inn"] == "7811472920"
    assert r.extracted["buyer"]["inn"] == "7704217370"
    assert r.extracted["number"] == "0134905056-0281"
    assert r.extracted["total"] == 522.0
    assert "invoice_details" not in r.extracted


@pytest.mark.asyncio
async def test_vision_ocr_sends_image_url_no_json_mode(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response("plain extracted text from image")

    # Маленький валидный PNG-байт (1x1 white) через PIL
    from PIL import Image
    import io
    img = Image.new("RGB", (1, 1), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    r = await b.vision_ocr(image_bytes=buf.getvalue(), prompt=None)
    assert r.text == "plain extracted text from image"

    args = client.chat.completions.create.call_args
    # vision_ocr не использует json_mode (модель возвращает свободный текст).
    assert "response_format" not in args.kwargs
    # Сообщение содержит и image_url (data URL), и text.
    content = args.kwargs["messages"][0]["content"]
    assert isinstance(content, list)
    types = [part["type"] for part in content]
    assert "image_url" in types
    assert "text" in types
    image_part = next(p for p in content if p["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")


def _png_base64() -> str:
    """1x1 white PNG, base64-encoded (как doc-service шлёт image_base64)."""
    import base64
    import io

    from PIL import Image

    img = Image.new("RGB", (1, 1), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.mark.asyncio
async def test_extract_with_image_builds_multimodal_message(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    """extraction-from-image: при image_base64 extract строит multimodal-
    сообщение (image_url + extract-prompt) и сохраняет json_mode=True."""
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response(
        '{"extracted": {"number": "IMG-1", "total": 999}, "confidence": 0.9, "issues": []}'
    )
    r = await b.extract(
        text="ocr text fallback",
        schema={"type": "object"},
        hint="invoice",
        image_base64=_png_base64(),
    )
    assert r.extracted == {"number": "IMG-1", "total": 999}
    assert r.confidence == pytest.approx(0.9)

    args = client.chat.completions.create.call_args
    # json_mode остаётся включённым — структурный JSON на выходе.
    assert args.kwargs["response_format"] == {"type": "json_object"}
    content = args.kwargs["messages"][0]["content"]
    assert isinstance(content, list)
    types = [part["type"] for part in content]
    assert "image_url" in types
    assert "text" in types
    image_part = next(p for p in content if p["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")
    # extract-prompt (а не OCR-инструкция) попал в text-блок.
    text_part = next(p for p in content if p["type"] == "text")
    assert "invoice" in text_part["text"] or "JSON" in text_part["text"]


@pytest.mark.asyncio
async def test_extract_text_only_still_sends_string_content(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    """Без image_base64 extract остаётся text-only (content — строка)."""
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response(
        '{"extracted": {"number": "T-1"}, "confidence": 0.8, "issues": []}'
    )
    r = await b.extract(text="some text", schema={"type": "object"}, hint="invoice")
    assert r.extracted == {"number": "T-1"}
    args = client.chat.completions.create.call_args
    assert isinstance(args.kwargs["messages"][0]["content"], str)


@pytest.mark.asyncio
async def test_falls_back_when_json_mode_not_supported(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    """Старый llama.cpp не поддерживает response_format — backend должен
    повторить запрос без него, а не упасть."""
    b, client = backend_with_mock_client

    call_count = {"n": 0}

    async def _flaky(**kwargs: Any) -> Any:
        call_count["n"] += 1
        if call_count["n"] == 1 and kwargs.get("response_format"):
            raise RuntimeError("Server does not support response_format json_object")
        return _make_response('{"type": "UPD", "confidence": 0.9}')

    client.chat.completions.create.side_effect = _flaky

    r = await b.classify("УПД № 1")
    assert r.type == "UPD"
    assert call_count["n"] == 2  # первый — с json_mode, второй — без


@pytest.mark.asyncio
async def test_propagates_non_json_mode_errors(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.chat.completions.create.side_effect = RuntimeError("connection refused")
    with pytest.raises(RuntimeError, match="connection refused"):
        await b.classify("text")


@pytest.mark.asyncio
async def test_verify_passes_through_when_model_returns_garbage(
    backend_with_mock_client: tuple[OpenAICompatibleBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.chat.completions.create.return_value = _make_response("not json at all")
    payload = {"number": "X", "total": 100}
    r = await b.verify(extracted=payload, raw_text="raw")
    # Контракт: при невалидном выводе модели возвращаем исходный extracted.
    assert r.extracted == payload


def test_is_not_ready_without_model_id() -> None:
    """Пустой model_id — backend не пытается строить клиента."""
    b = OpenAICompatibleBackend(base_url="http://x:1/v1", model_id="")
    assert b.is_ready() is False


def test_is_ready_with_model_id() -> None:
    b = OpenAICompatibleBackend(base_url="http://x:1/v1", model_id="qwen2.5vl:7b")
    assert b.is_ready() is True
