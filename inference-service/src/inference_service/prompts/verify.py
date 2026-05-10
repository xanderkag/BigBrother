"""Prompt template for /v1/verify."""

import json
from typing import Any

TEMPLATE = """Ты проверяешь корректность извлечённых данных делового документа.

Исходный текст:
\"\"\"
{raw_text}
\"\"\"

Извлечённые поля (JSON):
{extracted}

Проверь:
1. Согласуются ли числа: total ≈ сумма позиций; vat ≈ total * vat_rate / (100 + vat_rate).
2. Корректность ИНН (10 или 12 цифр), КПП (9 цифр).
3. Формат даты — должен быть YYYY-MM-DD.
4. Не выдуманы ли значения, которых нет в тексте.

Если есть расхождения — нормализуй где возможно (форматы, опечатки) и опиши проблемы в "issues".
Не теряй данные, которые уже есть в extracted.

Выводи строго валидный JSON:
{{
  "extracted": <возможно скорректированный объект>,
  "issues": [<строки с проблемами, может быть пустым>]
}}"""


def build(extracted: dict[str, Any], raw_text: str) -> str:
    return TEMPLATE.format(
        raw_text=raw_text[:8000],
        extracted=json.dumps(extracted, ensure_ascii=False, indent=2),
    )
