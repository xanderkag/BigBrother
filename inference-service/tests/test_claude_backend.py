"""ClaudeBackend unit tests — covers the AsyncAnthropic migration (A1).

We mock `anthropic.AsyncAnthropic` so the suite doesn't require an API key
or network access. The mock SDK shape mirrors the real one — `messages.create`
is an AsyncMock returning an object with `.content` (list of blocks each
having `.type`/`.text`) and `.usage` (input/output token counts).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from inference_service.backends.claude import ClaudeBackend


def _make_text_response(content: str, usage: dict[str, int] | None = None) -> Any:
    """Build a fake anthropic SDK response shape."""
    blocks = [SimpleNamespace(type="text", text=content)]
    usage_obj = None
    if usage is not None:
        usage_obj = SimpleNamespace(**usage)
    return SimpleNamespace(content=blocks, usage=usage_obj)


@pytest.fixture
def backend_with_mock_client() -> tuple[ClaudeBackend, MagicMock]:
    """Construct the backend without invoking the real SDK loader."""
    # api_key="" — backend пропускает _load(), мы поставим клиент руками.
    b = ClaudeBackend(api_key="", model_id="claude-test", max_tokens=128)
    # is_ready() будет False — поставим вручную, чтобы proxy через probe
    # вёл себя нормально. Для unit-теста этого достаточно.
    b._ready = True
    mock_client = MagicMock()
    mock_client.messages = MagicMock()
    mock_client.messages.create = AsyncMock()
    b._client = mock_client
    return b, mock_client


@pytest.mark.asyncio
async def test_classify_uses_async_client(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.messages.create.return_value = _make_text_response(
        '{"type": "invoice", "confidence": 0.91}'
    )
    r = await b.classify("Счёт № 1")
    assert r.type == "invoice"
    assert r.confidence == pytest.approx(0.91)
    # И главное — мы дёрнули async-метод, а не оборачивали в to_thread.
    client.messages.create.assert_awaited_once()


@pytest.mark.asyncio
async def test_extract_passes_cacheable_system_prompt(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    """F8: extract() должен подавать system как список с cache_control."""
    b, client = backend_with_mock_client
    client.messages.create.return_value = _make_text_response(
        '{"extracted": {"number": "A-1"}, "confidence": 0.8, "issues": []}',
        usage={
            "input_tokens": 1500,
            "output_tokens": 80,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    )
    r = await b.extract(text="text", schema={"type": "object"}, hint="invoice")
    assert r.extracted == {"number": "A-1"}
    assert r.confidence == pytest.approx(0.8)

    args = client.messages.create.call_args
    assert args.kwargs["model"] == "claude-test"
    # system должен быть списком с cache_control=ephemeral
    system = args.kwargs.get("system")
    assert isinstance(system, list)
    assert system[0]["cache_control"] == {"type": "ephemeral"}


@pytest.mark.asyncio
async def test_extract_handles_field_confidence(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.messages.create.return_value = _make_text_response(
        '{"extracted": {"number": "X"}, "confidence": 0.7, '
        '"field_confidence": {"number": 0.95, "garbage": "nope"}, "issues": []}'
    )
    r = await b.extract(text="t", schema={}, hint=None)
    # Валидная пара number→0.95 пройдёт, garbage→"nope" отфильтруется.
    assert r.field_confidence == {"number": 0.95}
    assert r.extracted.get("_field_confidence") == {"number": 0.95}


@pytest.mark.asyncio
async def test_vision_ocr_sends_image_block(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.messages.create.return_value = _make_text_response("hello world")

    import io
    from PIL import Image
    img = Image.new("RGB", (8, 8), color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    r = await b.vision_ocr(image_bytes=buf.getvalue(), prompt=None)
    assert r.text == "hello world"

    args = client.messages.create.call_args
    msg = args.kwargs["messages"][0]
    assert msg["role"] == "user"
    parts = msg["content"]
    types = [p["type"] for p in parts]
    assert "image" in types
    assert "text" in types
    image_block = next(p for p in parts if p["type"] == "image")
    assert image_block["source"]["type"] == "base64"
    assert image_block["source"]["media_type"] == "image/jpeg"


@pytest.mark.asyncio
async def test_verify_passes_through_on_garbage(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    b, client = backend_with_mock_client
    client.messages.create.return_value = _make_text_response("not json at all")
    payload = {"number": "X"}
    r = await b.verify(extracted=payload, raw_text="raw")
    assert r.extracted == payload


@pytest.mark.asyncio
async def test_extract_propagates_exceptions(
    backend_with_mock_client: tuple[ClaudeBackend, MagicMock],
) -> None:
    """Если AsyncAnthropic кидает — _admit должен корректно отпустить
    семафор, а исключение пробросится дальше."""
    b, client = backend_with_mock_client
    client.messages.create.side_effect = RuntimeError("anthropic API down")
    with pytest.raises(RuntimeError, match="anthropic API down"):
        await b.extract(text="t", schema={}, hint=None)
