"""Нормализация сырого JSON-ответа модели на /v1/extract.

Зачем это нужно (real-doc bench 2026-05-25):
    Маленькие open-source модели (phi4 через Ollama) систематически
    нарушают response-контракт двумя способами:

      1. **Теряют обёртку `extracted`.** Возвращают поля прямо на верхнем
         уровне: `{"seller": {...}, "buyer": {...}, "invoice_details": {...}}`
         вместо `{"extracted": {...}, "confidence": ...}`. Старый код делал
         `data.get("extracted") -> {}` и МОЛЧА выбрасывал все данные
         (field_exact_match 41.7%, ИНН 0/8 — хотя модель их извлекла).

      2. **Изобретают не-канонические ключи.** ИНН попадает в
         `invoice_details.inn` / `payment_details` / `invoice.number`
         вместо канонических `seller.inn` / `buyer.inn` / `number`.

    Обе беды — на стороне генерации; чинить лучше в промпте (см.
    extract.py), но как belt-and-suspenders + чтобы вытащить уже-извлечённые
    данные без повторного прогона модели — нормализуем ответ здесь.

    Функции чистые, идемпотентные и model-agnostic: применяются всеми
    backend'ами (claude / openai_compat / qwen_vl) одинаково. На корректном
    ответе (обёртка есть, ключи канонические) — no-op.
"""

from __future__ import annotations

from typing import Any

# Технические ключи response-контракта, которые НЕ являются бизнес-данными.
# Если на верхнем уровне ответа встречаются только они (плюс, может, мусор) —
# значит обёртка `extracted` есть и unwrap не нужен.
_ENVELOPE_KEYS = frozenset(
    {"extracted", "confidence", "field_confidence", "issues", "document_type"}
)

# Stray-ключи (обёртки-секции), содержимое которых надо «поднять» на верхний
# уровень extracted. phi4 любит группировать поля шапки в под-объект.
#   invoice_details / invoice / document → шапка (number/date/total/...)
_HEADER_WRAPPER_KEYS = ("invoice_details", "invoice", "document", "header", "doc")

# Re-map одиночных stray-ключей в канонические пути шапки.
#   left → right, right в точечной нотации ("seller.inn").
_SCALAR_ALIASES: dict[str, str] = {
    "invoice_number": "number",
    "doc_number": "number",
    "document_number": "number",
    "invoice_date": "date",
    "doc_date": "date",
    "document_date": "date",
    "total_amount": "total",
    "amount_total": "total",
    "grand_total": "total",
    "total_sum": "total",
    "vat_amount": "vat",
    "vat_total": "vat",
    "tax_amount": "vat",
    # phi4 на счёт-фактуре/УКД отдаёт плоские seller_inn/buyer_inn
    "seller_inn": "seller.inn",
    "seller_name": "seller.name",
    "seller_kpp": "seller.kpp",
    "buyer_inn": "buyer.inn",
    "buyer_name": "buyer.name",
    "buyer_kpp": "buyer.kpp",
}

# Re-map целых под-объектов сторон сделки в канонические seller/buyer.
#   payment_details обычно несёт банк получателя (= seller банк-блок).
_PARTY_ALIASES: dict[str, str] = {
    "party1": "seller",
    "party_1": "seller",
    "supplier": "seller",
    "vendor": "seller",
    "party2": "buyer",
    "party_2": "buyer",
    "customer": "buyer",
    "client": "buyer",
}

# Массив позиций — те же legacy-имена что и в doc-service normalize-extracted.ts.
_ITEM_ARRAY_ALIASES = ("positions", "services", "goods", "line_items")

# Денежные поля, которые парсеры/валидаторы ждут СКАЛЯРОМ (number). phi4 на
# реальных счетах иногда отдаёт их объектом {"amount": 522, "currency": "RUB"}
# вместо скаляра + отдельного currency. Сплющиваем объект → скаляр.
_MONEY_FIELDS = ("total", "total_with_vat", "total_without_vat", "vat")

# Ключи внутри money-объекта, несущие саму сумму.
_MONEY_VALUE_KEYS = ("amount", "value", "sum")


def _set_path(target: dict[str, Any], dotted: str, value: Any) -> None:
    """Записать value по точечному пути, не затирая уже существующее
    непустое значение (канонический ключ имеет приоритет над alias'ом)."""
    parts = dotted.split(".")
    cur = target
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    leaf = parts[-1]
    existing = cur.get(leaf)
    if existing in (None, "", {}, []):
        cur[leaf] = value


def _is_empty(v: Any) -> bool:
    return v in (None, "", {}, [])


def unwrap_envelope(data: dict[str, Any]) -> dict[str, Any]:
    """Если модель потеряла обёртку `extracted` — восстановить её.

    Срабатывает только когда `extracted` отсутствует (или пуст) И на верхнем
    уровне есть хотя бы один не-служебный ключ (значит, поля разлились на
    верхний уровень). Тогда весь объект (за вычетом служебных ключей) и есть
    extracted.
    """
    ext = data.get("extracted")
    if isinstance(ext, dict) and ext:
        return data  # обёртка на месте — no-op

    business_keys = [k for k in data.keys() if k not in _ENVELOPE_KEYS]
    if not business_keys:
        return data  # пустой ответ — нечего восстанавливать

    recovered = {k: data[k] for k in business_keys}
    out = {k: data[k] for k in data.keys() if k in _ENVELOPE_KEYS}
    out["extracted"] = recovered
    return out


def _flatten_money(obj: dict[str, Any], out: dict[str, Any]) -> Any | None:
    """Если money-поле пришло объектом {"amount": N, "currency": "RUB"} —
    вернуть скаляр N и (best-effort) поднять currency на верхний уровень out,
    если там его ещё нет. Возвращает None, если объект не похож на money-форму.
    """
    scalar: Any | None = None
    for key in _MONEY_VALUE_KEYS:
        if key in obj and isinstance(obj[key], (int, float)) and not isinstance(obj[key], bool):
            scalar = obj[key]
            break
    if scalar is None:
        return None
    cur = obj.get("currency")
    if isinstance(cur, str) and cur and _is_empty(out.get("currency")):
        out["currency"] = cur
    return scalar


def _normalize_money_fields(out: dict[str, Any]) -> None:
    """In-place: сплющить money-поля-объекты в скаляр + поднять currency."""
    for field in _MONEY_FIELDS:
        val = out.get(field)
        if isinstance(val, dict):
            scalar = _flatten_money(val, out)
            if scalar is not None:
                out[field] = scalar
    items = out.get("items")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            for field in (*_MONEY_FIELDS, "price"):
                val = item.get(field)
                if isinstance(val, dict):
                    scalar = _flatten_money(val, out)
                    if scalar is not None:
                        item[field] = scalar


def canonicalize_extracted(extracted: dict[str, Any]) -> dict[str, Any]:
    """Поднять stray-ключи в канонические пути схемы.

    Идемпотентно. Канонический ключ всегда имеет приоритет над alias'ом —
    если модель выдала и `number`, и `invoice_details.invoice_number`,
    побеждает `number`.
    """
    if not isinstance(extracted, dict):
        return extracted
    out: dict[str, Any] = dict(extracted)

    # 1. Под-объекты шапки (invoice_details / invoice / ...) → верхний уровень.
    for wrapper in _HEADER_WRAPPER_KEYS:
        section = out.get(wrapper)
        if not isinstance(section, dict):
            continue
        for k, v in section.items():
            if _is_empty(v):
                continue
            target = _SCALAR_ALIASES.get(k, k)
            _set_path(out, target, v)
        out.pop(wrapper, None)

    # 2. payment_details → банк-реквизиты seller (если есть содержательное).
    pay = out.get("payment_details")
    if isinstance(pay, dict):
        bank_map = {
            "account_number": "seller.account",
            "bank_name": "seller.bank",
            "bic": "seller.bik",
            "bik": "seller.bik",
            "recipient_account_number": "seller.corr_account",
            "corr_account": "seller.corr_account",
        }
        for k, v in pay.items():
            if _is_empty(v):
                continue
            target = bank_map.get(k)
            if target:
                _set_path(out, target, v)
        out.pop("payment_details", None)

    # 3. Целые под-объекты сторон (party1/supplier/...) → seller/buyer.
    for src, dst in _PARTY_ALIASES.items():
        section = out.get(src)
        if isinstance(section, dict) and section:
            if _is_empty(out.get(dst)):
                out[dst] = section
            else:
                # merge непустых полей в существующий канонический объект
                dst_obj = out[dst]
                if isinstance(dst_obj, dict):
                    for k, v in section.items():
                        if not _is_empty(v) and _is_empty(dst_obj.get(k)):
                            dst_obj[k] = v
            out.pop(src, None)

    # 4. Плоские scalar-алиасы на верхнем уровне (total_amount, seller_inn...).
    for src, dst in _SCALAR_ALIASES.items():
        if src in out and not _is_empty(out[src]):
            _set_path(out, dst, out[src])
            out.pop(src, None)

    # 5. Массив позиций под legacy-именем → items[].
    if not isinstance(out.get("items"), list) or not out.get("items"):
        for legacy in _ITEM_ARRAY_ALIASES:
            val = out.get(legacy)
            if isinstance(val, list) and val:
                out["items"] = val
                break

    # 6. Money-поля-объекты {"amount": N, "currency": ...} → скаляр + currency.
    _normalize_money_fields(out)

    return out


def normalize_extract_response(data: dict[str, Any]) -> dict[str, Any]:
    """Полный конвейер: восстановить обёртку → канонизировать ключи extracted.

    Возвращает dict с гарантированным ключом `extracted` (dict). Применяется
    всеми backend'ами перед чтением `data["extracted"]`.
    """
    if not isinstance(data, dict):
        return {"extracted": {}}
    data = unwrap_envelope(data)
    ext = data.get("extracted")
    if isinstance(ext, dict):
        data = dict(data)
        data["extracted"] = canonicalize_extracted(ext)
    return data
