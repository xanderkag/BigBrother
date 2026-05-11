"""Prompt template for /v1/extract.

Два режима:

  1. **Builtin** — наша инструкция, общая для всех типов документов
     (`build_builtin`). Используется когда админ ничего не настроил.

  2. **Override** — кастомная инструкция, заведённая через UI Document
     Type Registry (поле `llm_prompt`). Подмешиваем к ней технические
     требования к формату ответа (JSON, ключи extracted/confidence/issues
     и пр.) — иначе администратор каждый раз был бы вынужден
     дублировать «верни валидный JSON с ключами …».
"""

import json
from typing import Any

# Общая «техническая концовка» — что модель должна вернуть в JSON.
# Подмешивается и к builtin'у, и к override'у. Один источник правды
# для формата ответа.
_RESPONSE_CONTRACT = """Выводи строго валидный JSON без комментариев и без markdown-обёртки:
{{
  "extracted": <объект по схеме>,
  "confidence": <0..1, твоя уверенность в извлечённых полях>,
  "issues": [<строки с проблемами, может быть пустым>]
}}"""

BUILTIN_TEMPLATE = """Ты извлекаешь структурированные поля из текста делового документа на русском языке.

Тип документа (подсказка): {hint}

Целевая JSON-схема (используй только эти поля, лишних не добавляй):
{schema}

Правила:
- Все суммы — числами без пробелов и без валюты ("15 000,50" → 15000.50).
- Все даты — в формате YYYY-MM-DD.
- ИНН — строка из 10 или 12 цифр.
- Если поле не нашлось в тексте — НЕ выдумывай, оставляй его пустым (отсутствует в JSON).
- Если есть подозрение на ошибку OCR (несвязные цифры, обрезанные слова) — добавляй описание в "issues".

{response_contract}

Текст документа:
\"\"\"
{text}
\"\"\""""


OVERRIDE_TEMPLATE = """{admin_instructions}

Тип документа: {hint}

Целевая JSON-схема (используй только эти поля, лишних не добавляй):
{schema}

{response_contract}

Текст документа:
\"\"\"
{text}
\"\"\""""


def build(
    text: str,
    schema: dict[str, Any],
    hint: str | None,
    prompt_override: str | None = None,
) -> str:
    """Construct the extract-prompt. Если задан `prompt_override` — он
    становится «системной частью» промпта (что считать продуктом), а
    технические требования к формату ответа подмешиваются автоматически.

    Truncate document text at 12 KB to keep token budget предсказуемым;
    реальный лимит у моделей варьируется (4k-128k), но 12 KB ~= 3000
    токенов, что безопасно для большинства open-source моделей."""
    common = {
        "hint": hint or "не указан",
        "schema": json.dumps(schema, ensure_ascii=False, indent=2),
        "text": text[:12000],
        "response_contract": _RESPONSE_CONTRACT,
    }
    if prompt_override:
        return OVERRIDE_TEMPLATE.format(
            admin_instructions=prompt_override.strip(),
            **common,
        )
    return BUILTIN_TEMPLATE.format(**common)
