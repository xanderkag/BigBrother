-- Up Migration
--
-- 2026-05-18: Provider slots per ollama-модель.
--
-- До этой миграции у нас был ОДИН провайдер `qwen-local` который указывал
-- на inference-service. inference-service выбирал модель из своего
-- OPENAI_MODEL env. То есть переключить модель означало:
--   1. зайти на сервер
--   2. поправить .env
--   3. рестартнуть контейнер
--   4. потерять кэш Anthropic если был
-- — и всё это для одной модели, никакого AB-тестирования между моделями.
--
-- После миграции (вместе с inference-service.model_override + doc-service
-- HttpLlmClient.model field):
--   - 7 провайдер-слотов, по одному на популярную ollama-модель
--   - У каждого свой `model` field (`phi4`, `gemma3:27b`, `mistral-small3.1` и т.д.)
--   - В UI Test Lab можно выбрать конкретную модель — pipeline отправит
--     её в `metadata._force_provider_id`, resolver возьмёт row.model и
--     передаст в /v1/extract → openai_compatible переподменит model_id.
--   - Default остаётся stub (т.е. поведение без force_provider не меняется)
--   - qwen-local оставляем для backward compat, отмечаем inactive
--
-- Все провайдеры указывают на один и тот же base_url=http://inference:8000
-- — это inference-service в нашем docker network. У них одинаковый api_key
-- (пустой если local) и доступ через тот же контейнер.

INSERT INTO provider_settings (id, kind, display_name, description, base_url, model, is_active, is_default) VALUES
    ('local-phi4', 'llm', 'Phi-4 14B (Microsoft)',
     'Локальная Phi-4 14B через ollama на 10.10.28.10. Лучшая арифметика totals (60%) в нашем синт-бенчмарке, в 2× быстрее Gemma 27B. Production-default рекомендация.',
     'http://inference:8000', 'phi4', true, false),
    ('local-gemma3-27b', 'llm', 'Gemma 3 27B (Google)',
     'Локальная Gemma 3 27B через ollama. Точнее для критичных доков (90% conf), но в 2× медленнее Phi-4. Используйте для договоров и спецификаций где важна максимальная точность.',
     'http://inference:8000', 'gemma3:27b', true, false),
    ('local-gemma3-12b', 'llm', 'Gemma 3 12B (Google)',
     'Локальная Gemma 3 12B — облегчённая версия 27B. Быстрая (5 мин на 10 файлов), приемлемая точность, плохая арифметика total (33%). Резерв.',
     'http://inference:8000', 'gemma3:12b', true, false),
    ('local-mistral-small-31', 'llm', 'Mistral Small 3.1 24B (multimodal)',
     'Локальная Mistral Small 3.1 24B через ollama. Единственная рабочая vision-модель: ИНН 80% на сканах (vs 0% у MiniCPM-V). На text-PDF — средне (40% total).',
     'http://inference:8000', 'mistral-small3.1', true, false),
    ('local-tpro-32b', 'llm', 'T-Pro 32B (Т-Банк, русский)',
     'Локальная T-Pro 32B (файнтюн Qwen 2.5 на русском от Т-Банка). По точности = Phi-4 (total 60%), но в 3.5× медленнее. Использовать когда важен русский context.',
     'http://inference:8000', 'hf.co/t-tech/T-pro-it-1.0-Q4_K_M-GGUF:Q4_K_M', true, false),
    ('local-yandexgpt-lite', 'llm', 'YandexGPT-5 Lite 8B',
     'Локальная YandexGPT-5 Lite 8B через ollama. Самая компактная (5 GB), скорость как Phi-4, но арифметика хуже (total 30%). Edge-кандидат.',
     'http://inference:8000', 'hf.co/yandex/YandexGPT-5-Lite-8B-instruct-GGUF:Q4_K_M', true, false),
    ('local-minicpm-v', 'llm', 'MiniCPM-V 2.6 (vision)',
     'Локальная MiniCPM-V 2.6 (8B vision). На наших тестах type 10%, ИНН 0%, items_F1 49%. НЕ рекомендуется для прода, оставлено для регрессии и калибровки.',
     'http://inference:8000', 'minicpm-v', true, false)
ON CONFLICT (id) DO NOTHING;

-- Маркируем старый qwen-local как inactive — он указывал на ту же модель
-- что и `local-qwen-vl-7b` (если такой будет добавлен в будущем). Сейчас
-- админ должен видеть в UI только реально работающие модели.
UPDATE provider_settings
SET is_active = false,
    description = description || ' [DEPRECATED 2026-05-18: используйте local-* провайдеров с явной моделью]'
WHERE id = 'qwen-local';

-- Down Migration
DELETE FROM provider_settings WHERE id IN (
    'local-phi4',
    'local-gemma3-27b',
    'local-gemma3-12b',
    'local-mistral-small-31',
    'local-tpro-32b',
    'local-yandexgpt-lite',
    'local-minicpm-v'
);

UPDATE provider_settings
SET is_active = true,
    description = REPLACE(description, ' [DEPRECATED 2026-05-18: используйте local-* провайдеров с явной моделью]', '')
WHERE id = 'qwen-local';
