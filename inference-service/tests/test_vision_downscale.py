"""Vision-latency: даунскейл картинки перед отправкой в vision-модель.

Полноразмерный 200-DPI скан молотится дольше без выигрыша в точности —
ограничиваем длинную сторону до settings.vision_max_image_px (только вниз).
"""
from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from inference_service.backends import openai_compatible as oc


def _decode_data_url(data_url: str) -> Image.Image:
    assert data_url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    return Image.open(io.BytesIO(raw))


def test_downscale_shrinks_long_side(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oc.settings, "vision_max_image_px", 1600)
    # A4 @ 200 DPI ≈ 1654x2339 — длинная сторона 2339 > 1600.
    img = Image.new("RGB", (1654, 2339), "white")
    out = oc._downscale_for_vision(img)
    assert max(out.width, out.height) == 1600
    # Пропорции сохранены (в пределах округления).
    assert abs(out.width / out.height - 1654 / 2339) < 0.01


def test_downscale_never_upscales(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oc.settings, "vision_max_image_px", 1600)
    img = Image.new("RGB", (800, 600), "white")
    out = oc._downscale_for_vision(img)
    assert out.size == (800, 600)  # уже меньше лимита → без изменений


def test_downscale_disabled_with_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oc.settings, "vision_max_image_px", 0)
    img = Image.new("RGB", (4000, 3000), "white")
    out = oc._downscale_for_vision(img)
    assert out.size == (4000, 3000)  # ресайз выключен


def test_image_to_data_url_applies_downscale(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oc.settings, "vision_max_image_px", 1000)
    img = Image.new("RGB", (3000, 2000), "white")
    decoded = _decode_data_url(oc._image_to_data_url(img))
    assert max(decoded.width, decoded.height) == 1000
