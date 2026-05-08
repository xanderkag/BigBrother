"""End-to-end route tests against the stub backend."""

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image


def _png_bytes(width: int = 32, height: int = 32) -> bytes:
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready(client: TestClient) -> None:
    r = client.get("/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready"
    assert body["backend"] == "stub"


def test_classify_invoice(client: TestClient) -> None:
    r = client.post("/v1/classify", json={"text": "Счёт № 123 от 15.01.2026"})
    assert r.status_code == 200
    data = r.json()
    assert data["type"] in ("invoice",)
    assert data["confidence"] > 0


def test_classify_ttn(client: TestClient) -> None:
    r = client.post("/v1/classify", json={"text": "ТРАНСПОРТНАЯ НАКЛАДНАЯ № 9"})
    assert r.status_code == 200
    assert r.json()["type"] == "TTN"


def test_classify_returns_null_on_noise(client: TestClient) -> None:
    r = client.post("/v1/classify", json={"text": "hello world"})
    assert r.status_code == 200
    assert r.json()["type"] is None


def test_extract_returns_stub_shape(client: TestClient) -> None:
    r = client.post(
        "/v1/extract",
        json={"text": "Счёт № 1", "schema": {"type": "object"}, "hint": "invoice"},
    )
    assert r.status_code == 200
    data = r.json()
    assert "extracted" in data
    assert "confidence" in data
    assert "issues" in data


def test_vision_ocr_accepts_png(client: TestClient) -> None:
    img_b64 = base64.b64encode(_png_bytes()).decode()
    r = client.post("/v1/vision-ocr", json={"image_base64": img_b64})
    assert r.status_code == 200
    data = r.json()
    assert "text" in data
    assert "confidence" in data


def test_vision_ocr_rejects_invalid_base64(client: TestClient) -> None:
    r = client.post("/v1/vision-ocr", json={"image_base64": "not-base64!@#"})
    assert r.status_code == 400


def test_vision_ocr_rejects_empty(client: TestClient) -> None:
    r = client.post("/v1/vision-ocr", json={"image_base64": ""})
    # Empty string fails the schema's min_length=1 — Pydantic returns 422.
    assert r.status_code in (400, 422)


def test_verify_passes_through_extracted(client: TestClient) -> None:
    payload = {"extracted": {"number": "123", "date": "2026-01-15"}, "raw_text": "Счёт № 123"}
    r = client.post("/v1/verify", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert data["extracted"] == payload["extracted"]
    assert isinstance(data["issues"], list)
