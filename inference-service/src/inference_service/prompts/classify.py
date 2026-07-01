"""Prompt template for /v1/classify."""

# The model is asked for strict JSON. We give it a closed enum, examples,
# and explicit instructions to refuse when uncertain. Tuned for short
# Russian document headers.
TEMPLATE = """Ты классифицируешь типы транспортных и бухгалтерских документов на русском языке.
Прочитай текст ниже и выбери ОДИН из типов:

- invoice       — счёт на оплату
- factInvoice   — счёт-фактура
- UPD           — универсальный передаточный документ
- TTN           — транспортная накладная (товарно-транспортная)
- CMR           — международная транспортная накладная (CMR)
- AKT           — акт оказанных/выполненных работ

Если ни один не подходит уверенно — верни type=null.

Выводи СТРОГО валидный JSON без пояснений:
{{"type": "<один из типов или null>", "confidence": <число 0..1>}}

Текст документа:
\"\"\"
{text}
\"\"\""""


def build(text: str) -> str:
    return TEMPLATE.format(text=text[:8000])


# --- Catalog-driven classify (production LLM classifier) ---
#
# Отличается от TEMPLATE выше: не жёсткий 6-типовый enum, а ДИНАМИЧЕСКИЙ
# каталог всех активных типов из document_types (doc-service строит
# `slug — description` и присылает в поле `catalog`). Модель выбирает РОВНО
# ОДИН slug из каталога либо `unknown`. Проверено в probe: qwen3.6:27b ~1s/док
# warm, 14/15 на неоднозначных, честный `unknown` на out-of-catalog.
#
# Возвращаем НЕ JSON, а голый slug (max_tokens ~30) — так надёжнее для
# reasoning-моделей на reasoning_effort="none". doc-service валидирует slug
# по каталогу.

_CATALOG_SYSTEM = (
    "Ты классифицируешь документы ВЭД. Выбери РОВНО ОДИН тип из списка по "
    "содержимому и имени файла. Если ни один не подходит — верни `unknown`. "
    "Верни ТОЛЬКО slug.\nТипы:\n{catalog}"
)


def build_catalog_messages(
    text: str,
    catalog: str,
    file_name: str | None = None,
    keyword_hint: str | None = None,
    text_chars: int = 2500,
) -> list[dict[str, str]]:
    """Собрать system+user сообщения для каталог-классификации.

    Формат в точности как в probe (см. ТЗ):
      system = "Ты классифицируешь документы ВЭД. ...\nТипы:\n<catalog>"
      user   = "Имя файла: <file_name>\nПодсказка (быстрый классификатор): <hint>\nТекст:\n<first ~2500 chars>"
    """
    system = _CATALOG_SYSTEM.format(catalog=catalog)
    user_lines: list[str] = []
    user_lines.append(f"Имя файла: {file_name or '(не указано)'}")
    if keyword_hint:
        user_lines.append(f"Подсказка (быстрый классификатор): {keyword_hint}")
    user_lines.append("Текст:")
    user_lines.append(text[:text_chars])
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(user_lines)},
    ]
