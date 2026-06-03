# parsdocs → SLAI: подтверждение EXT-LLM-PROXY ТЗ

**Дата:** 2026-06-02
**В ответ на:** ТЗ для parsdocs-команды: EXT-LLM-PROXY (SLAI, 2026-06-02)
**Связано:** `EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01.md` (наше полное implementation ТЗ варианта B), `EXT_LLM_PROXY_TZ_2026-06-01.md` (position paper с A/B/C вариантами)

---

## TL;DR

✅ **Берём в работу.** Ваше ТЗ совпадает с нашим internal планом по варианту B (light proxy + metering) — мы уже подготовили implementation-grade ТЗ 2026-06-01 после вашего первого запроса.

📅 **ETA: ~неделя после WW-23 пилот-стартa.** MTI-3 (unify key storage, 2 дня prereq) + EXT-LLM-PROXY-B (3 дня) + embeddings endpoint (+1 день) = ~6 рабочих дней одним разработчиком.

🎯 **Формат:** OpenAI-compatible — да, как вы просите. Это и был наш план (стандарт де-факто, любой client SDK работает).

---

## Ответы на 4 ваших вопроса

### 1. Берёте в работу?

✅ **Да.** Решение owner'а 2026-06-01 после вашего первого запроса:
- **B (light proxy + metering)** — сейчас
- **C (per-tenant quotas + rate-limit + cost-calc)** — отложено до триггера (5+ инстансов или incident runaway)

Ваше текущее ТЗ полностью укладывается в наш B + добавляет embeddings (которого у нас не было). Принимаем embeddings как 2-й endpoint, **+1 день к scope**.

### 2. Срок

| Шаг | Размер | Префикс |
|-----|--------|---------|
| **MTI-3** unify key storage (общий ключ Anthropic в `provider_settings`, не в .env) | 2 дня | prereq, без него ваш «ключ на нашей стороне» не работает чисто |
| **EXT-LLM-PROXY-B** chat completions + SSE streaming + tools forwarding + `GET /v1/usage` | 3 дня | core |
| **+ Embeddings** endpoint (forward to OpenAI text-embedding-3-*) | +1 день | ваш доп. запрос |
| **Итого** | **~6 рабочих дней** | |

**Старт:** после стабилизации WW-23 пилота (т.е. как только не будет блокирующих фиксов от пилота). Реалистично — **W24-25 (09-19 июня)**, готовность ~20 июня.

**Жёсткого deadline нет** (вы сами просили без него). Если что-то затянется — пишем сразу.

### 3. OpenAI-compatible format

✅ **Да, OpenAI-compat как вы описали.** Это и был наш план — это стандарт, минимум кастомных адаптеров на вашей стороне.

Что именно поддерживаем:
- `POST /v1/chat/completions` — messages, system, model, max_tokens, temperature, stream, tools, tool_choice
- Response — `{id, object, choices[].message.{content, tool_calls}, usage}`
- Streaming SSE — стандартный OpenAI format chunks с `data: ...\n\n` + `data: [DONE]`
- Tools — OpenAI `[{"type":"function","function":{name, description, parameters}}]`, на нашей стороне переводим в Anthropic native `input_schema` и обратно (translator уже спроектирован в нашем ТЗ §Tool-calling translation)

### 4. На WW-23 не нужно, после пилота без жёсткого дедлайна

✅ Согласен. Делаем после стабилизации пилота. Если пилот выявит что-то критичное по парсингу — приоритет фикс пилота, EXT-LLM-PROXY двигается.

---

## По вашим обязательным требованиям — все ✅

| # | Требование | Наш ответ |
|---|------------|-----------|
| 1 | Streaming SSE (typing effect) | ✅ Стандартный OpenAI SSE format |
| 2 | Tool calling (агент не работает без него) | ✅ Translator OpenAI↔Anthropic в обе стороны, включая streaming chunks |
| 3 | Ключ Anthropic у нас, не передаёте X-LLM-Api-Key | ✅ Это и есть смысл MTI-3 — ключ в `provider_settings.api_key` (encrypted), не в .env. Резолвится per-org или дефолтным провайдером |
| 4 | Per-tenant изоляция через PAT | ✅ Тот же auth flow что и `/jobs` — PAT → org_id, usage считается per-org |
| 5 | `GET /v1/usage?from=...&to=...` | ✅ В нашем ТЗ есть — agg запрос по `llm_usage_log` (org_id, model, tokens, latency, status, errors). Возвращает totals + by_model + by_day |

## По опциональным — расклад

| # | Опция | Решение |
|---|-------|---------|
| Множественные модели (Haiku для дешёвых задач) | **MTI-2** (model preset bundles) — отдельный эпик в roadmap. После EXT-LLM-PROXY-B. Provider Anthropic будет декларировать pack `{sonnet-4-6, haiku-4-5}`, выбор per-request через `model` параметр в request body |
| Per-PAT квоты (hard-cap $/мес) | **EXT-LLM-PROXY-C** (full gateway). Отложено до триггера: 5+ ваших инстансов ИЛИ incident runaway LLM. На MVP — только metering, без cap'ов |
| Local Mistral/Llama backend | После прихода GPU-сервера 96 ГБ (он уже есть на корп-стороне `10.10.33.10`, **не Asha**). Bench v3 уже показал Mistral Small 3.1 24B — победитель text-моделей. Можем подключить как backend в шлюзе, переключение прозрачное для вас. Это **Epic-5** в нашем roadmap |

---

## Embeddings (ваш доп. запрос — детали)

Добавляем `POST /v1/embeddings` как 2-й endpoint EXT-LLM-PROXY-B.

### Реализация

```
POST https://vanga.sls24.ru/v1/embeddings
Authorization: Bearer pdpat_<tenant-token>
Content-Type: application/json

{
  "model": "text-embedding-3-small",  ← или "text-embedding-3-large"
  "input": ["text1", "text2", ...],   ← array или single string
  "encoding_format": "float"          ← опц., default float
}
```

Backend → forwards в OpenAI `https://api.openai.com/v1/embeddings` (Anthropic не делает embeddings, нужен отдельный provider).

### Что это значит для конфигурации

- В `provider_settings` нужна вторая строка: `openai` с api_key (отдельный ключ от Anthropic). У вас он уже есть для агента — можете прислать тем же путём (plain в чат или через secrets inbox).
- Metering: те же таблицы + `model` будет `text-embedding-3-*`. В `usage_log` ничего не меняется.

### Альтернатива (если не хотите OpenAI)

Voyage AI (`voyage-3-large`) — embeddings качество выше OpenAI на retrieval. Прокинуть тот же путь. Скажите если предпочитаете Voyage — добавим.

---

## Что нужно от вас (одна вещь)

**OpenAI API key для embeddings**. Если у вас уже есть — пришлите plain в чат (как S1 webhook secret) или через `SLAI_SECRETS_INBOX.md`. Запишу в `provider_settings` отдельной строкой `openai` (рядом с anthropic).

Если эмбеддинги вам нужны не сразу — отложим, сделаем B без них сначала.

---

## Что НЕ делаем (явный YAGNI до триггера)

- ❌ Per-PAT hard-cap $/мес — это C, по триггеру
- ❌ Cost calculator в $ (Anthropic pricing таблица) — C, по триггеру
- ❌ Multi-backend failover (Anthropic 5xx → switch на OpenAI) — C
- ❌ Webhook'и на квоты — C
- ❌ Admin endpoints для квот — C
- ❌ Multi-modal (image embeddings, function-calling streaming partial state preservation) — out of scope

---

## История

- 2026-06-01 утро: SLAI поднял вопрос про multi-instance key sprawl
- 2026-06-01 день: parsdocs написал position paper (A/B/C варианты)
- 2026-06-01 вечер: owner решение — B сейчас, C по триггеру
- 2026-06-01 поздний вечер: написано полное implementation ТЗ B
- 2026-06-02: получено формальное ТЗ SLAI (этот reply) — совпадает с B + добавляет embeddings. Принято в работу с ETA W24-25 (после WW-23 пилот-стабилизации).

---

## Контакты

- **parsdocs technical owner:** Aleksandr Liapustin — `a.liapustin@mod-soft.ru` / `liapustin@gmail.com`
- **Implementation ТЗ (тех. детали):** `doc-service/docs/EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01.md`
- **Position paper (стратегия):** `doc-service/docs/EXT_LLM_PROXY_TZ_2026-06-01.md`
- **Канал секретов:** PR в `xanderkag/BigBrother/SLAI_SECRETS_INBOX.md` (или plain в чат для пилотных тенантов)
