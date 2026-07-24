"""FIX: 400 «превышено контекстное окно» → ужать бюджет вывода, а не падать.

Боевой случай (2026-07-24, vision qwen3-vl на :8101, окно 16384): промпт скана
перевалил за (окно - OPENAI_MAX_TOKENS=8192), апстрим вернул 400, inference
отдавал 500, задача падала насовсем (24 документа). Теперь ошибка разбирается,
`max_tokens` пересчитывается под остаток окна и запрос повторяется один раз.

Тут — чистый парсер сообщения (без сети и SDK).
"""

import os

os.environ.setdefault("BACKEND", "stub")
os.environ.setdefault("API_KEY", "")

from inference_service.backends.openai_compatible import (  # noqa: E402
    _MIN_OUTPUT_TOKENS,
    _CONTEXT_SAFETY_MARGIN,
    _parse_context_overflow,
)

# Дословное сообщение из боевого лога.
REAL_VLLM = (
    "Error code: 400 - {'error': {'message': \"This model's maximum context "
    "length is 16384 tokens. However, you requested 8192 output tokens and "
    "your prompt contains at least 8193 input tokens, for a total of at least "
    "16385 tokens. Please reduce the length of the input prompt or the number "
    "of requested output tokens. (parameter=input_tokens, value=8193)\", "
    "'type': 'BadRequestError', 'param': 'input_tokens', 'code': 400}}"
)

OPENAI_CLASSIC = (
    "This model's maximum context length is 8192 tokens. However, your "
    "messages resulted in 8300 tokens. Please reduce the length of the messages."
)


def test_parses_real_vllm_message() -> None:
    assert _parse_context_overflow(Exception(REAL_VLLM)) == (16384, 8193)


def test_parses_classic_openai_phrasing() -> None:
    assert _parse_context_overflow(Exception(OPENAI_CLASSIC)) == (8192, 8300)


def test_ignores_unrelated_errors() -> None:
    # Не про контекст → None, обработка ошибки не меняется (пробрасываем как было).
    assert _parse_context_overflow(Exception("connection refused")) is None
    assert _parse_context_overflow(Exception("400 - unknown parameter 'foo'")) is None
    assert _parse_context_overflow(Exception("")) is None


def test_ignores_context_message_without_numbers() -> None:
    # Есть слова про контекст, но чисел нет — пересчитывать нечего.
    assert _parse_context_overflow(Exception("context length exceeded")) is None


def test_fitted_budget_is_positive_and_usable_for_real_case() -> None:
    # Проверяем саму арифметику ретрая на боевых числах: 16384-8193-64 = 8127,
    # что заметно больше минимума → повтор состоится и вывод не обрежется.
    ctx, prompt = _parse_context_overflow(Exception(REAL_VLLM))
    fitted = ctx - prompt - _CONTEXT_SAFETY_MARGIN
    assert fitted == 8127
    assert fitted >= _MIN_OUTPUT_TOKENS


def test_giving_up_when_prompt_alone_eats_the_window() -> None:
    # Промпт почти равен окну → бюджет вывода ниже минимума → честно падаем.
    msg = (
        "This model's maximum context length is 16384 tokens. However, you "
        "requested 8192 output tokens and your prompt contains at least 16300 "
        "input tokens, for a total of at least 24492 tokens."
    )
    ctx, prompt = _parse_context_overflow(Exception(msg))
    assert ctx - prompt - _CONTEXT_SAFETY_MARGIN < _MIN_OUTPUT_TOKENS
