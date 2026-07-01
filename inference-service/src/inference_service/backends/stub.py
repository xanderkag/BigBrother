"""Deterministic stub backend.

Goal: let doc-service (and CI) exercise the full pipeline end-to-end
without GPU, model downloads, or non-determinism. Behaviour intentionally
mirrors what a real VLM would return *for trivial cases*: it can detect
keyword-classifiable documents, parrot text from /vision-ocr (returning a
recognizable placeholder), and pass-through /verify.

This is NOT a serious extractor — never use it in production.
"""

import json
import os
import re
from pathlib import Path
from typing import Any

from ..schemas import (
    ClassifyResponse,
    ExtractResponse,
    VerifyResponse,
    VisionResponse,
)
from .base import ModelBackend


def _load_classifier_rules() -> list[tuple[str, re.Pattern[str], float]]:
    """Load classifier rules from shared/classifier-rules.json (A6 fix).

    Search order:
      1. CLASSIFIER_RULES_PATH env var — Docker override / custom mount.
      2. Relative to __file__: repo_root/shared/ (works in dev/CI where the
         full repo checkout is available).
      3. Hardcoded fallback (Docker without shared/ mount; stub is never used
         in production so this path doesn't matter for real data).
    """
    candidates: list[Path] = []
    if env_path := os.getenv("CLASSIFIER_RULES_PATH"):
        candidates.append(Path(env_path))
    # Dev/CI: __file__ is inside repo at inference-service/src/…/backends/stub.py
    # parents[4] = repo root (backends → inference_service → src → inference-service → repo)
    candidates.append(Path(__file__).parents[4] / "shared" / "classifier-rules.json")

    for path in candidates:
        if path.exists():
            try:
                raw: list[dict[str, object]] = json.loads(path.read_text("utf-8"))
                return [
                    (str(r["slug"]), re.compile(str(r["pattern"]), re.IGNORECASE), float(str(r["weight"])))
                    for r in raw
                ]
            except (KeyError, ValueError):
                pass  # malformed JSON — try next candidate

    # Hardcoded fallback — kept in sync with shared/classifier-rules.json.
    # If you update the JSON, update this list too (and vice versa).
    return [
        ("UPD",         re.compile(r"универсальный\s+передаточный\s+документ|\bУПД\b", re.IGNORECASE), 1.0),
        ("CMR",         re.compile(r"\bCMR\b|международная\s+товарно-транспортная", re.IGNORECASE), 1.0),
        ("TTN",         re.compile(r"транспортная\s+накладная|товарно-транспортная\s+накладная|\bТТН\b", re.IGNORECASE), 1.0),
        ("factInvoice", re.compile(r"счет-фактура|счёт-фактура", re.IGNORECASE), 1.0),
        ("AKT",         re.compile(r"\bакт\b\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании", re.IGNORECASE), 0.95),
        ("invoice",     re.compile(r"\bсч[её]т\s+на\s+оплату\b|\bсч[её]т\s+№", re.IGNORECASE), 0.9),
        ("invoice",     re.compile(r"\bсч[её]т\b", re.IGNORECASE), 0.6),
        # F18 (SLAI ТЗ): путевой лист (4-С грузовой, 4-П легковой, ПЛ-1 такси).
        # NB: Python re тоже не очень любит \b с кириллицей в re.IGNORECASE,
        # хотя проблема меньше чем у JS. Убираем \b — специфичности биграмм
        # "путевой лист" достаточно (нет других документов с такой парой).
        ("waybill",     re.compile(r"путевой\s+лист|форма\s+4-С|форма\s+4-П|форма\s+ПЛ-1", re.IGNORECASE), 1.0),
        # F17 (SLAI ТЗ): новая ТН формы 2013 (Пост. Прав. РФ № 272). Weight 1.1
        # выше чем TTN (1.0) чтобы при совпадении обоих паттернов выигрывал
        # специфичный (ссылка на постановление есть только в новой форме).
        ("transport_invoice", re.compile(
            # Python re \w поддерживает Unicode по умолчанию, но для синхронизации
            # с JS-regex используем тот же [а-яА-Я]+ — единая логика на обеих
            # сторонах.
            r"Постановлен[а-яА-Я]+\s+Правительства\s+РФ.{0,80}272"
            r"|приложение\s+№\s*4\s+к\s+Правилам\s+перевозок\s+грузов"
            r"|условия\s+перевозки.{0,500}стоимость\s+услуг\s+перевозки",
            re.IGNORECASE | re.DOTALL,
        ), 1.1),
        # F16 (SLAI ТЗ): заявка на перевозку
        ("transport_request", re.compile(
            r"заявка\s+(?:№|на\s+перевозку|на\s+транспортные\s+услуги|на\s+автоперевозку)"
            r"|заявка-договор\s+на\s+перевозку",
            re.IGNORECASE,
        ), 1.0),
    ]


_RULES: list[tuple[str, re.Pattern[str], float]] = _load_classifier_rules()


class StubBackend(ModelBackend):
    name = "stub"

    def is_ready(self) -> bool:
        return True

    async def classify(
        self,
        text: str,
        model_override: str | None = None,  # noqa: ARG002 — stub игнорит
        reasoning_effort: str | None = None,  # noqa: ARG002 — stub игнорит
        catalog: str | None = None,  # noqa: ARG002 — stub игнорит
        file_name: str | None = None,  # noqa: ARG002
        keyword_hint: str | None = None,  # noqa: ARG002
        max_tokens: int | None = None,  # noqa: ARG002
    ) -> ClassifyResponse:
        del model_override, reasoning_effort, catalog, file_name, keyword_hint, max_tokens
        async with self._admit():
            head = text[:4000]
            best: tuple[str, float] | None = None
            for kind, rx, weight in _RULES:
                if rx.search(head) and (best is None or weight > best[1]):
                    best = (kind, weight)
            if best is None:
                return ClassifyResponse(type=None, confidence=0.0)
            return ClassifyResponse(type=best[0], confidence=best[1])  # type: ignore[arg-type]

    async def extract(
        self,
        text: str,
        schema: dict[str, Any],
        hint: str | None,
        prompt_override: str | None = None,
        include_debug: bool = False,
        model_override: str | None = None,  # noqa: ARG002 — stub игнорит
        image_base64: str | None = None,  # noqa: ARG002 — stub игнорит
        reasoning_effort: str | None = None,  # noqa: ARG002 — stub игнорит
    ) -> ExtractResponse:
        del model_override, image_base64, reasoning_effort
        # Stub mode: для смоук-тестирования pipeline'а возвращаем mock-данные
        # для известных типов документов. Это позволяет проверить ветки
        # llm_extract / multipass / items[] / per-line validators / resolution
        # без реальной LLM-модели.
        #
        # Mock — это НЕ реальное извлечение. Данные синтетические и
        # детерминированные (одинаковые для всех документов одного типа).
        # Для прода используйте Claude/OpenAI/Qwen-бэкенды.
        async with self._admit():
            mock = _build_mock_extract(hint)
            note = f"stub backend mock-extract (hint={hint}, mocked={bool(mock)}"
            if prompt_override:
                note += f", prompt_override len={len(prompt_override)}"
            note += ")"
            return ExtractResponse(
                extracted=mock or {},
                confidence=0.7 if mock else 0.0,
                issues=[note],
            )

    async def vision_ocr(
        self,
        image_bytes: bytes,
        prompt: str | None,
        model_override: str | None = None,  # noqa: ARG002 — stub игнорит
    ) -> VisionResponse:
        del model_override
        # Return a placeholder so downstream code can be tested for shape.
        # Confidence is deliberately low so the doc-service router knows
        # this is not real OCR output.
        async with self._admit():
            return VisionResponse(
                text=f"[stub vision-ocr: {len(image_bytes)} bytes received]",
                confidence=0.1,
            )

    async def verify(
        self,
        extracted: dict[str, Any],
        raw_text: str,
        model_override: str | None = None,  # noqa: ARG002 — stub игнорит
        reasoning_effort: str | None = None,  # noqa: ARG002 — stub игнорит
    ) -> VerifyResponse:
        del model_override, reasoning_effort
        # Pass-through: real verify would normalize dates, money, etc.
        async with self._admit():
            return VerifyResponse(extracted=extracted, issues=[])


# ─── Mock-extract для смоук-тестирования pipeline'а ──────────────────────────
# Возвращает синтетические данные канонического shape (Phase A: items[] из 19
# полей). НЕ запускать в проде. Активно только в BACKEND=stub режиме.


def _mock_items(count: int = 3) -> list[dict[str, Any]]:
    """Несколько строк items[] с реалистичными цифрами для проверки
    per-line валидаторов: суммы сходятся с шапкой, ставки НДС валидны,
    единицы из словаря, qty × price == total_without_vat."""
    items = []
    base_lines = [
        ("A-001", "Молоко Простоквашино 3.2% 1л", "шт", 24, 78.50, 10),
        ("A-002", "Кефир Простоквашино 2.5% 0.9л", "шт", 12, 65.00, 10),
        ("B-100", "Сыр Российский 50% 1кг", "кг", 5, 450.00, 10),
    ]
    for i, (code, name, unit, qty, price, vat_rate) in enumerate(base_lines[:count]):
        total_no_vat = round(qty * price, 2)
        vat_amount = round(total_no_vat * vat_rate / 100, 2)
        total_with_vat = round(total_no_vat + vat_amount, 2)
        items.append({
            "line_no": i + 1,
            "code": code,
            "name": name,
            "unit": unit,
            "qty": qty,
            "price": price,
            "vat_rate": vat_rate,
            "vat_amount": vat_amount,
            "total_without_vat": total_no_vat,
            "total_with_vat": total_with_vat,
            "currency": "RUB",
        })
    return items


def _build_mock_extract(hint: str | None) -> dict[str, Any] | None:
    """Mock канонической формы для разных типов. Возвращает None если hint
    не из известных — caller тогда вернёт пустой extracted."""
    if hint in ("invoice", "factInvoice", "UPD"):
        items = _mock_items(3)
        total_no_vat = sum(i["total_without_vat"] for i in items)
        vat = sum(i["vat_amount"] for i in items)
        return {
            "number": "СЧ-MOCK-001",
            "date": "2026-05-15",
            "seller": {"name": "ООО Простоквашино", "inn": "7707083893", "kpp": "770701001"},
            "buyer": {"name": "ООО ТАЙПИТ", "inn": "5024169813", "kpp": "502401001"},
            "currency": "RUB",
            "total": round(total_no_vat + vat, 2),
            "total_without_vat": round(total_no_vat, 2),
            "vat": round(vat, 2),
            "vat_rate": 10,
            "items": items,
        }
    if hint == "TTN":
        items = _mock_items(2)
        return {
            "number": "TTN-MOCK-001",
            "date": "2026-05-15",
            "shipper": {"name": "ООО Простоквашино", "inn": "7707083893"},
            "consignee": {"name": "ООО ТАЙПИТ", "inn": "5024169813"},
            "vehicle": {"plate": "А123ВВ77", "driver": "Сидоров П.Р."},
            "loading_point": "Москва, Тверская 1",
            "unloading_point": "Красногорск, Ильинский б-р 11",
            "items": items,
        }
    if hint == "AKT":
        items = [
            {
                "line_no": 1, "name": "Транспортные услуги Москва-СПб",
                "unit": "усл", "qty": 1, "price": 45000.0,
                "vat_rate": 20, "vat_amount": 9000.0,
                "total_without_vat": 45000.0, "total_with_vat": 54000.0,
                "currency": "RUB",
            },
        ]
        return {
            "number": "AKT-MOCK-001",
            "date": "2026-05-15",
            "party_a": {"name": "ИП Перевозкин", "inn": "500100732259"},
            "party_b": {"name": "ООО ТАЙПИТ", "inn": "5024169813"},
            "total": 54000.0,
            "total_without_vat": 45000.0,
            "vat": 9000.0,
            "vat_rate": 20,
            "items": items,
        }
    return None
