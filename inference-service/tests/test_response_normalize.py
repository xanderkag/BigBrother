"""Тесты нормализации extract-ответа (response.py).

Регрессия real-doc bench 2026-05-25: phi4 терял обёртку `extracted` и
изобретал не-канонические ключи; данные молча выбрасывались. Эти кейсы —
точные shape'ы из eval/real/qwenvl-real-v1-2026-05-25.json.
"""

from __future__ import annotations

from inference_service.prompts.response import (
    canonicalize_extracted,
    normalize_extract_response,
    unwrap_envelope,
)


def test_envelope_intact_is_noop() -> None:
    data = {"extracted": {"number": "A-1"}, "confidence": 0.9, "issues": []}
    assert normalize_extract_response(data) == data


def test_recovers_missing_envelope() -> None:
    # Doc 01 из bench: phi4 отдал поля прямо на верхнем уровне.
    raw = {
        "seller": {"name": "ООО Ромашка", "inn": "7811472920"},
        "buyer": {"name": "ИП Иванов", "inn": "7704217370"},
        "invoice_details": {
            "invoice_number": "0134905056-0281",
            "date": "18.05.2026",
            "total_amount": 522.00,
        },
    }
    out = normalize_extract_response(raw)
    ext = out["extracted"]
    assert ext["seller"]["inn"] == "7811472920"
    assert ext["buyer"]["inn"] == "7704217370"
    # invoice_details.* поднялись в канонические number/date/total
    assert ext["number"] == "0134905056-0281"
    assert ext["total"] == 522.00
    assert "invoice_details" not in ext


def test_payment_details_maps_to_seller_bank() -> None:
    raw = {
        "seller": {"inn": "7811472920"},
        "payment_details": {
            "account_number": "40702810200000598886",
            "bank_name": "АО Банк",
            "bic": "044525068",
            "recipient_account_number": "30101810645374525068",
        },
    }
    ext = normalize_extract_response(raw)["extracted"]
    assert ext["seller"]["account"] == "40702810200000598886"
    assert ext["seller"]["bank"] == "АО Банк"
    assert ext["seller"]["bik"] == "044525068"
    assert ext["seller"]["corr_account"] == "30101810645374525068"
    assert "payment_details" not in ext


def test_invoice_wrapper_section_hoisted() -> None:
    # Doc 02 из bench: всё под ключом invoice.
    raw = {
        "invoice": {"number": "2605-341781-69610", "total_amount": 23272.00},
        "seller": {"name": "Поставщик"},
        "buyer": {"name": "Покупатель"},
    }
    ext = normalize_extract_response(raw)["extracted"]
    assert ext["number"] == "2605-341781-69610"
    assert ext["total"] == 23272.00
    assert "invoice" not in ext


def test_flat_party_inn_aliases() -> None:
    # Счёт-фактура/УКД: плоские seller_inn/buyer_inn.
    raw = {
        "extracted": {
            "number": "9",
            "seller_inn": "7811472920",
            "buyer_inn": "9715360914",
            "seller_name": "ООО Продавец",
        }
    }
    ext = normalize_extract_response(raw)["extracted"]
    assert ext["seller"]["inn"] == "7811472920"
    assert ext["buyer"]["inn"] == "9715360914"
    assert ext["seller"]["name"] == "ООО Продавец"
    assert "seller_inn" not in ext


def test_party1_party2_to_seller_buyer() -> None:
    raw = {
        "extracted": {
            "party1": {"name": "Исполнитель", "inn": "1111111111"},
            "party2": {"name": "Заказчик", "inn": "2222222222"},
        }
    }
    ext = normalize_extract_response(raw)["extracted"]
    assert ext["seller"]["inn"] == "1111111111"
    assert ext["buyer"]["inn"] == "2222222222"
    assert "party1" not in ext


def test_positions_alias_to_items() -> None:
    raw = {"extracted": {"number": "X", "positions": [{"name": "товар", "qty": 1}]}}
    ext = normalize_extract_response(raw)["extracted"]
    assert isinstance(ext["items"], list)
    assert ext["items"][0]["name"] == "товар"


def test_canonical_key_wins_over_alias() -> None:
    # Если есть и канонический number, и invoice_details.invoice_number —
    # канонический не затирается.
    raw = {
        "extracted": {
            "number": "CANON-1",
            "invoice_details": {"invoice_number": "STRAY-2"},
        }
    }
    ext = normalize_extract_response(raw)["extracted"]
    assert ext["number"] == "CANON-1"


def test_idempotent() -> None:
    raw = {
        "seller": {"inn": "1"},
        "invoice_details": {"invoice_number": "N"},
    }
    once = normalize_extract_response(raw)
    twice = normalize_extract_response(once)
    assert once == twice


def test_empty_response_safe() -> None:
    # Пустой ответ нечего восстанавливать — backend сам подставит {} через
    # свой `else {}`. Главное — не падаем и не выдумываем данные.
    assert normalize_extract_response({}).get("extracted", {}) == {}
    assert normalize_extract_response({"confidence": 0.0}).get("extracted", {}) == {}
    assert normalize_extract_response("garbage") == {"extracted": {}}  # type: ignore[arg-type]


def test_unwrap_keeps_envelope_meta() -> None:
    raw = {
        "confidence": 0.8,
        "field_confidence": {"number": 1.0},
        "number": "A",
    }
    out = unwrap_envelope(raw)
    assert out["confidence"] == 0.8
    assert out["field_confidence"] == {"number": 1.0}
    assert out["extracted"]["number"] == "A"


def test_canonicalize_noop_on_clean() -> None:
    clean = {"number": "1", "seller": {"inn": "x"}, "items": [{"name": "a"}]}
    assert canonicalize_extracted(dict(clean)) == clean
