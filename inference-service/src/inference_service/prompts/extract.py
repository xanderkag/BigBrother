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


# --- Раздельные части для prompt caching (F8) ---
# Anthropic cache работает на префиксе. Если bake'ить всё в один user-message
# (как `build` выше), кэш будет работать только пока документ один и тот же —
# бесполезно. Чиним: статическая часть (instructions + schema + контракт)
# идёт в system-prompt с cache_control, динамическая (text документа) —
# в user-message. Тогда на каждый новый документ из 10 вызовов 9 raз
# получают cached input — экономия 90% на input tokens.

_STATIC_BUILTIN_HEADER = """Ты извлекаешь структурированные поля из текста делового документа на русском языке.

Правила:
- Все суммы — числами без пробелов и без валюты ("15 000,50" → 15000.50).
- Все даты — в формате YYYY-MM-DD.
- ИНН — строка из 10 или 12 цифр.
- Если поле не нашлось в тексте — НЕ выдумывай, оставляй его пустым (отсутствует в JSON).
- Если есть подозрение на ошибку OCR (несвязные цифры, обрезанные слова) — добавляй описание в "issues".

"""


def build_cacheable(
    text: str,
    schema: dict[str, Any],
    hint: str | None,
    prompt_override: str | None = None,
) -> tuple[str, str]:
    """Вернуть (system_prompt, user_prompt) для Anthropic API с prompt
    caching. system_prompt — статическая часть (один и тот же между
    вызовами для одного и того же hint+schema), user_prompt — только
    содержимое документа.

    Backend подставит `cache_control: {"type": "ephemeral"}` на
    system-блок. Cache hit срабатывает если предыдущий запрос с тем же
    system был < 5 минут назад.
    """
    schema_json = json.dumps(schema, ensure_ascii=False, indent=2)
    if prompt_override:
        system = (
            f"{prompt_override.strip()}\n\n"
            f"Тип документа: {hint or 'не указан'}\n\n"
            f"Целевая JSON-схема (используй только эти поля, лишних не добавляй):\n{schema_json}\n\n"
            f"{_RESPONSE_CONTRACT.replace('{{', '{').replace('}}', '}')}"
        )
    else:
        system = (
            f"{_STATIC_BUILTIN_HEADER}"
            f"Тип документа (подсказка): {hint or 'не указан'}\n\n"
            f"Целевая JSON-схема (используй только эти поля, лишних не добавляй):\n{schema_json}\n\n"
            f"{_RESPONSE_CONTRACT.replace('{{', '{').replace('}}', '}')}"
        )
    user = f'Текст документа:\n"""\n{text[:12000]}\n"""'
    return system, user
