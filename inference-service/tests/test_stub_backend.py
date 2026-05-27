"""Stub backend unit tests — backend in isolation, no FastAPI."""

import pytest

from inference_service.backends.stub import StubBackend


@pytest.fixture
def stub() -> StubBackend:
    return StubBackend()


@pytest.mark.asyncio
async def test_classify_invoice(stub: StubBackend) -> None:
    r = await stub.classify("Счёт на оплату № 99 от 01.03.2026")
    assert r.type == "invoice"
    assert r.confidence > 0.5


@pytest.mark.asyncio
async def test_classify_upd(stub: StubBackend) -> None:
    r = await stub.classify("Универсальный передаточный документ № 1")
    assert r.type == "UPD"


@pytest.mark.asyncio
async def test_classify_returns_null(stub: StubBackend) -> None:
    r = await stub.classify("plain ascii noise")
    assert r.type is None
    assert r.confidence == 0.0


@pytest.mark.asyncio
async def test_extract_returns_mock_for_known_hint(stub: StubBackend) -> None:
    # Stub теперь возвращает детерминированный mock канонической формы для
    # известных типов (389f0f8) — это нужно для смоук-теста pipeline'а
    # (items[]/per-line validators/resolution) без реальной LLM.
    r = await stub.extract(text="x", schema={}, hint="invoice")
    assert r.extracted != {}
    assert r.extracted["number"] == "СЧ-MOCK-001"
    assert isinstance(r.extracted["items"], list)
    assert r.confidence == 0.7
    assert any("stub" in i.lower() for i in r.issues)


@pytest.mark.asyncio
async def test_extract_is_empty_for_unknown_hint(stub: StubBackend) -> None:
    # hint вне известного набора → пустой extracted + confidence 0 + issue.
    r = await stub.extract(text="x", schema={}, hint="unknown-type")
    assert r.extracted == {}
    assert r.confidence == 0.0
    assert any("stub" in i.lower() for i in r.issues)


@pytest.mark.asyncio
async def test_vision_ocr_returns_placeholder(stub: StubBackend) -> None:
    r = await stub.vision_ocr(image_bytes=b"x" * 1024, prompt=None)
    assert "stub" in r.text
    assert "1024 bytes" in r.text


@pytest.mark.asyncio
async def test_verify_passes_through(stub: StubBackend) -> None:
    payload = {"a": 1, "b": "two"}
    r = await stub.verify(extracted=payload, raw_text="raw")
    assert r.extracted == payload
    assert r.issues == []
