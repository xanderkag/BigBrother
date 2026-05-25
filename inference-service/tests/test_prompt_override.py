"""Tests for the llm_prompt → prompt_override end-to-end pipeline (inference side).

Покрывает три уровня:
  1. `prompts/extract.build()` — два режима (builtin / override).
  2. `StubBackend.extract` — override доезжает до backend'а и попадает в issues.
  3. `OpenAICompatibleBackend.extract` — override попадает в реальный
     prompt, передаваемый OpenAI SDK (через mock).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from inference_service.backends.openai_compatible import OpenAICompatibleBackend
from inference_service.backends.stub import StubBackend
from inference_service.prompts import extract as extract_prompts


# --- prompts/extract.build ---

class TestPromptBuilder:
    def test_builtin_mode_when_no_override(self) -> None:
        prompt = extract_prompts.build(
            text="Счёт № 1",
            schema={"type": "object"},
            hint="invoice",
        )
        assert "извлекаешь структурированные поля" in prompt.lower()
        assert "invoice" in prompt
        assert "Счёт № 1" in prompt
        # builtin содержит технические правила про ИНН и даты
        assert "ИНН" in prompt
        assert "YYYY-MM-DD" in prompt

    def test_override_replaces_builtin_instructions(self) -> None:
        admin_prompt = (
            "Ты — парсер коммерческих инвойсов. "
            "Извлекай номер B/L и порт назначения."
        )
        prompt = extract_prompts.build(
            text="some text",
            schema={"type": "object"},
            hint="commercial_invoice",
            prompt_override=admin_prompt,
        )
        # Админская инструкция включена
        assert "коммерческих инвойсов" in prompt
        assert "B/L и порт назначения" in prompt
        # А наши встроенные правила про ИНН/НДС — НЕТ (они для российских доков)
        assert "ИНН" not in prompt
        # Технический контракт ответа всё равно подмешан (extracted/confidence/issues)
        assert "extracted" in prompt
        assert "confidence" in prompt
        # И хинт, и схема, и текст всё ещё на месте
        assert "commercial_invoice" in prompt
        assert "some text" in prompt

    def test_override_with_whitespace_is_stripped(self) -> None:
        prompt = extract_prompts.build(
            text="x", schema={}, hint=None,
            prompt_override="   Custom instruction.\n\n  ",
        )
        assert "Custom instruction." in prompt

    def test_long_text_is_truncated_to_12k(self) -> None:
        # Заполняем sentinel-символом из Private Use Area, которого заведомо
        # нет в статическом шаблоне — иначе count() ловит буквы шаблона
        # (напр. "A" из "SLAI") и тест ложно падает на 12001.
        sentinel = ""
        prompt = extract_prompts.build(
            text=sentinel * 20000, schema={}, hint=None,
        )
        # Документная часть не больше 12 KB символов
        assert prompt.count(sentinel) <= 12000

    def test_tail_reminder_after_document_text(self) -> None:
        # bench 2026-05-25: напоминание о канонических ключах + обёртке
        # extracted должно стоять ПОСЛЕ текста документа (последним), иначе
        # маленькие модели его теряют.
        prompt = extract_prompts.build(
            text="DOCBODY", schema={"type": "object"}, hint="invoice",
        )
        assert "seller.inn" in prompt
        assert "НЕ выноси" in prompt
        # хвост-напоминание идёт после текста документа
        assert prompt.index("DOCBODY") < prompt.rindex("НАПОМИНАНИЕ О ФОРМАТЕ ОТВЕТА")

    def test_tail_reminder_present_in_override_mode(self) -> None:
        prompt = extract_prompts.build(
            text="x", schema={}, hint=None, prompt_override="custom",
        )
        assert "НАПОМИНАНИЕ О ФОРМАТЕ ОТВЕТА" in prompt
        assert "seller.inn" in prompt

    def test_cacheable_tail_reminder_in_user_part(self) -> None:
        system, user = extract_prompts.build_cacheable(
            text="DOCBODY", schema={"type": "object"}, hint="invoice",
        )
        # хвост-напоминание едет в user-части (не кэшируется), после текста
        assert "НАПОМИНАНИЕ О ФОРМАТЕ ОТВЕТА" in user
        assert user.index("DOCBODY") < user.index("НАПОМИНАНИЕ О ФОРМАТЕ ОТВЕТА")


# --- StubBackend ---

class TestStubBackendOverride:
    @pytest.mark.asyncio
    async def test_extract_echoes_override_length_in_issues(self) -> None:
        stub = StubBackend()
        r = await stub.extract(
            text="x",
            schema={},
            hint="my_custom_type",
            prompt_override="Custom prompt of size",
        )
        assert any("prompt_override len=" in i for i in r.issues)

    @pytest.mark.asyncio
    async def test_extract_without_override_omits_marker(self) -> None:
        stub = StubBackend()
        r = await stub.extract(text="x", schema={}, hint="invoice")
        # Без override маркер не должен появляться
        assert not any("prompt_override" in i for i in r.issues)


# --- OpenAICompatibleBackend ---

def _make_response(content: str) -> Any:
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
    )


class TestOpenAICompatBackendOverride:
    @pytest.fixture
    def backend_with_mock(self) -> tuple[OpenAICompatibleBackend, MagicMock]:
        b = OpenAICompatibleBackend(
            base_url="http://ollama:11434/v1",
            model_id="qwen2.5vl:7b",
        )
        mock_client = MagicMock()
        mock_client.chat = MagicMock()
        mock_client.chat.completions = MagicMock()
        mock_client.chat.completions.create = AsyncMock(
            return_value=_make_response(
                '{"extracted": {}, "confidence": 0.5, "issues": []}'
            ),
        )
        b._client = mock_client  # type: ignore[attr-defined]
        return b, mock_client

    @pytest.mark.asyncio
    async def test_override_appears_in_outgoing_prompt(
        self,
        backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock],
    ) -> None:
        b, client = backend_with_mock
        await b.extract(
            text="document text",
            schema={"type": "object"},
            hint="custom_type",
            prompt_override="ADMIN-CUSTOM-INSTRUCTION-FOOBAR",
        )
        args = client.chat.completions.create.call_args
        user_message = args.kwargs["messages"][0]
        assert user_message["role"] == "user"
        # В одном string-сообщении должен быть и админ-промпт, и текст,
        # и контракт ответа.
        content = user_message["content"]
        assert "ADMIN-CUSTOM-INSTRUCTION-FOOBAR" in content
        assert "document text" in content
        assert '"extracted"' in content

    @pytest.mark.asyncio
    async def test_no_override_uses_builtin(
        self,
        backend_with_mock: tuple[OpenAICompatibleBackend, MagicMock],
    ) -> None:
        b, client = backend_with_mock
        await b.extract(text="document", schema={}, hint="invoice")
        content = client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        # Builtin содержит специфичные русско-доковые правила, которых
        # в override-режиме нет.
        assert "ИНН" in content
