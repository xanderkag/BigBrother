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
