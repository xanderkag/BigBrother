"""FIX: 400 «превышено контекстное окно» → ужать бюджет вывода, а не падать.

Боевой случай (2026-07-24, vision qwen3-vl на :8101, окно 16384): промпт скана
перевалил за (окно - OPENAI_MAX_TOKENS=8192), апстрим вернул 400, inference
отдавал 500, задача падала насовсем (24 документа). Теперь ошибка разбирается,
`max_tokens` пересчитывается под остаток окна и запрос повторяется один раз.

Тут — чистый парсер сообщения (без сети и SDK).
"""

import asyncio
import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("BACKEND", "stub")
os.environ.setdefault("API_KEY", "")

from inference_service.backends.openai_compatible import (  # noqa: E402
    _CONTEXT_SAFETY_MARGIN,
    OpenAICompatibleBackend,
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


def test_reported_prompt_is_a_bound_not_a_real_size() -> None:
    """Ключевой факт, ради которого ужимаем ВДВОЕ, а не «на нехватку».

    Апстрим сообщает промпт как «at least N», где N == окно + 1 - max_tokens,
    т.е. это нижняя граница из самого нарушения, а не реальный размер. Боевой
    лог: вывод 8192 → «не менее 8193»; вывод 8127 → «не менее 8258». Итог
    ОБА раза ровно 16385 — вычитание нехватки не сходится никогда.
    """
    _, p1 = _parse_context_overflow(Exception(REAL_VLLM))
    second = (
        "This model's maximum context length is 16384 tokens. However, you "
        "requested 8127 output tokens and your prompt contains at least 8258 "
        "input tokens, for a total of at least 16385 tokens."
    )
    _, p2 = _parse_context_overflow(Exception(second))
    assert p1 + 8192 == p2 + 8127 == 16385
    # Наивный «fitted» после первой ошибки (8127) всё ещё не влезает — этот
    # тест фиксирует, почему одного вычитания мало.
    assert 16384 - p1 - _CONTEXT_SAFETY_MARGIN == 8127
    assert p2 + 8127 > 16384


def _overflow_msg(max_tokens: int, window: int = 16384) -> str:
    """Сообщение апстрима в его же логике: промпт = окно + 1 - max_tokens."""
    return (
        f"This model's maximum context length is {window} tokens. However, you "
        f"requested {max_tokens} output tokens and your prompt contains at least "
        f"{window + 1 - max_tokens} input tokens, for a total of at least "
        f"{window + 1} tokens."
    )


class _FakeCreate:
    """Апстрим, который принимает запрос только когда max_tokens <= threshold."""

    def __init__(self, threshold: int) -> None:
        self.threshold = threshold
        self.calls: list[int] = []

    async def create(self, **kwargs):  # noqa: ANN003, ANN201
        mt = int(kwargs["max_tokens"])
        self.calls.append(mt)
        if mt > self.threshold:
            raise RuntimeError(_overflow_msg(mt))
        return "RESPONSE"


def _backend_with(fake: _FakeCreate) -> OpenAICompatibleBackend:
    # Обходим __init__ (он тянет SDK) — нужен только self._client.
    b = object.__new__(OpenAICompatibleBackend)
    b._client = SimpleNamespace(chat=SimpleNamespace(completions=fake))
    return b


def test_retry_halves_budget_and_succeeds() -> None:
    # Апстрим принимает <=8000. Первое ужимание: min(fitted 8127, 8192//2) = 4096.
    fake = _FakeCreate(threshold=8000)
    backend = _backend_with(fake)
    out = asyncio.run(
        backend._retry_within_context(
            {"model": "m", "max_tokens": 8192}, RuntimeError(REAL_VLLM)
        )
    )
    assert out == "RESPONSE"
    assert fake.calls == [4096], "должно хватить одного ужимания вдвое"


def test_retry_gives_up_and_reraises_when_nothing_fits() -> None:
    # Апстрим не принимает ничего разумного → ужимаем 4096→2048→1024→512 и падаем.
    fake = _FakeCreate(threshold=10)
    backend = _backend_with(fake)
    with pytest.raises(RuntimeError, match="context length"):
        asyncio.run(
            backend._retry_within_context(
                {"model": "m", "max_tokens": 8192}, RuntimeError(REAL_VLLM)
            )
        )
    assert fake.calls == [4096, 2048, 1024, 512]


def test_retry_reraises_unrelated_error_immediately() -> None:
    # Не-контекстная ошибка на повторе пробрасывается без дальнейших попыток.
    class _Boom(_FakeCreate):
        async def create(self, **kwargs):  # noqa: ANN003, ANN201
            self.calls.append(int(kwargs["max_tokens"]))
            raise RuntimeError("connection refused")

    fake = _Boom(threshold=0)
    backend = _backend_with(fake)
    with pytest.raises(RuntimeError, match="connection refused"):
        asyncio.run(
            backend._retry_within_context(
                {"model": "m", "max_tokens": 8192}, RuntimeError(REAL_VLLM)
            )
        )
    assert fake.calls == [4096]
