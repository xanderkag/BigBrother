# EXT-LLM-PROXY — parsdocs как LLM-gateway для SLAI multi-instance

**Дата:** 2026-06-01
**Тип:** discussion ТЗ + position paper (стратегическое решение)
**Запрос:** SLAI 2026-06-01 — расширить parsdocs до OpenAI-compatible LLM-шлюза
**Связано:** `MTI_TZ_2026-05-31.md` (MTI-1/2/3), `IDEAS_2026-06-01_DISCUSSION.md`

---

## TL;DR

SLAI пишет:
> «N инстансов = N мест где живёт ключ Anthropic. Просим выставить
> OpenAI-compat /v1/chat/completions + streaming + tools + per-org metering
> поверх вашего inference-service. Альтернатива — мы поднимаем LiteLLM, тогда
> мониторинг и контроль остаётся у нас, вы не видите LLM-трафик вообще.»

**Их аргументация валидна по существу** — multi-instance key sprawl это реальная проблема (rotation, revocation, audit). Вопрос **не** «можем ли мы технически» (можем), а **«хотим ли мы расширять scope parsdocs до LLM-gateway product».** Это стратегическое решение, не техническое.

### Три варианта (для решения owner)

| # | Что | Время | Что меняется в продукте |
|---|-----|-------|--------------------------|
| **A** | Не делаем. SLAI идёт LiteLLM | 0 дней нашей работы | parsdocs остаётся document-extractor. SLAI LLM-трафик мы не видим |
| **B** | **Light**: passthrough proxy + token usage logging (без rate-limit, без per-org квот) | 2-3 дня | Мы видим metrics, но не управляем. Простая фича |
| **C** | **Full**: проксирование + per-org rate-limit + квоты + usage-stats + tool-calling forwarding | 5-8 дней + MTI-1/MTI-3 prerequisites | parsdocs становится LLM-gateway, расширение scope |

Я не выбираю — решает owner. Опишу все три ниже.

---

## Контекст: SLAI's аргументы (валидны)

### Проблема SLAI как они описывают

```
pilot.sls24.ru ────┐
negabarit.sls24.ru ┤── каждый держит свой X-LLM-Api-Key (Anthropic)
client3.sls24.ru ──┤   N инстансов = N мест для rotation/leak/audit
client4.sls24.ru ──┘
            └─────────► api.anthropic.com напрямую (3 hop'а от точки контроля)
```

**Проблемы:**
1. N инстансов = N audit points для compliance
2. Нет видимости общего spend → если один клиент жрёт токены аномально (баг или атака) — узнаешь только из bill Anthropic в конце месяца
3. Нет per-tenant квот → один баг = весь bill
4. Rotation: меняешь ключ — обходишь N конфигов

**Их желаемое:**
```
pilot.sls24.ru ─────┐
negabarit.sls24.ru ─┤── PAT (pdpat_*) → parsdocs /v1/chat/completions
client3.sls24.ru ───┤      │
                    │      └─► routing logic, per-org quotas, metering
                    │           │
                    │           └─► Anthropic / OpenAI / local (один ключ у нас)
```

**Их выгода:** один точка контроля, parsdocs им и так доверяют (document processing уже через нас).

### Что это даёт **нам** (если согласимся)

1. **Visibility** — видим LLM-spend по всем SLAI-тенантам, нет «чёрного ящика»
2. **Control** — можем ограничить runaway клиента (rate-limit, quota)
3. **Stickiness** — SLAI глубже интегрирован, switching cost растёт
4. **Routing** — можем прозрачно переключать backend (Anthropic → local Mistral когда придёт GPU)

### Что это нам **стоит**

1. **Новый scope** parsdocs — мы становимся LLM-router, не только document-extractor
2. **Operational burden** — uptime LLM-шлюза должен быть выше чем у document jobs (chat пользователю срывается = плохо; document upload через 5 секунд = OK)
3. **Liability** — если наш ключ Anthropic утечёт, это бьёт по N клиентам одновременно
4. **Maintenance** — Anthropic меняет API → мы догоняем, не SLAI

---

## Вариант A — отказать, SLAI идёт LiteLLM

### Что делаем

Ничего. Отвечаем SLAI: «расширение scope не делаем, ставьте LiteLLM рядом на Asha — он покрывает всё что вы перечислили».

### Их action items

1. `docker run litellm/litellm` рядом на Asha (или у себя)
2. Конфиг: один Anthropic key + per-tenant `virtual_keys` (LiteLLM умеет)
3. SLAI-инстансы вместо `api.anthropic.com` идут на `https://litellm.sls24.ru/v1/chat/completions`

### Плюсы для parsdocs

- 0 нашей работы
- Не несём liability за LLM gateway
- Не расширяем scope
- LiteLLM open-source, mature, OpenAI-compat из коробки, metering встроен

### Минусы для parsdocs

- Не видим LLM-spend SLAI
- Не контролируем routing (SLAI может уйти с Anthropic на любой LLM без нашего ведома)
- Если SLAI compromises ключ — узнаём только когда они расскажут
- Меньше lock-in (SLAI может в будущем заменить parsdocs на другой extractor легче)

---

## Вариант B — Light proxy (метрики, без контроля)

### Что выставляем

```
POST {vanga}/v1/chat/completions   ← OpenAI-compat
  Authorization: Bearer {pdpat_*}   ← наш PAT
  Body: { model, messages, stream, tools, ... }    ← passthrough

Возвращает: тот же OpenAI-compat response (chunks для stream)
```

### Под капотом

1. Auth check (PAT → org_id)
2. **Resolve LLM credentials** — используем общий ключ Anthropic из `provider_settings` (требует MTI-3)
3. Прокси запроса в реальный backend (Anthropic SDK / OpenAI SDK)
4. Stream response back через SSE (chunked)
5. **Логировать** в новую таблицу `llm_usage_log`: org_id, model, prompt_tokens, completion_tokens, latency_ms, request_id, error_code

### Что НЕ делаем в light:

- ❌ Per-org rate-limit (используется глобальный)
- ❌ Per-org квоты (никакого «остановись когда выгребли $50»)
- ❌ Cost cap

### Endpoints

| Method | Path | Что |
|--------|------|-----|
| POST | `/v1/chat/completions` | OpenAI-compat (stream + tools forwarded) |
| GET | `/v1/usage?from=...&to=...` | Aggregated usage per-org (admin); + per-org-endpoint `/v1/usage/me` для SLAI-инстанса |

### Размер

- 2-3 дня backend (proxy + streaming SSE + usage logging + smoke tests)
- 0 UI

### Зависимости

- **MTI-3** (unify key storage) — нужен общий Anthropic key в `provider_settings`, не в .env. Без MTI-3 будем тащить ANTHROPIC_API_KEY из env.

---

## Вариант C — Full gateway (proxy + control)

### Всё что в B + полный контроль

| Доп. feature | Что |
|--------------|-----|
| Per-org rate-limit | Конфиг в `organization_settings.llm_rate_limit_rpm` (требует MTI-1 миграцию) |
| Per-org квоты | Месячный лимит токенов / $ — в `organization_settings.llm_monthly_quota` |
| Cost calculator | Anthropic pricing table → стоимость per-request в `llm_usage_log` |
| Per-org webhook на 80%/100% квоты | Уведомление SLAI-инстансу «вы выгребли» |
| Routing rules | Per-org `preferred_model` (требует MTI-2 model bundles) |
| Multi-backend failover | Anthropic 5xx → fallback на OpenAI (опционально) |

### Endpoints (расширение)

| Method | Path | Что |
|--------|------|-----|
| POST | `/v1/chat/completions` | как в B |
| GET | `/v1/usage` | как в B + cost в $ |
| GET | `/v1/limits` | per-org текущие лимиты + остаток |
| POST | `/api/v1/admin/orgs/:id/quota` | super_admin меняет квоту |
| POST | `/api/v1/admin/orgs/:id/rate-limit` | super_admin меняет RL |

### Размер

- 5-8 дней backend (всё из B + квоты + rate-limit per-org + cost-calc + admin endpoints + webhook'и на квоты)
- 2-3 дня UI (MTI-1 страница Consumers — добавить колонки usage/quota/limits)

### Зависимости

- **MTI-3** (must) — общий ключ
- **MTI-1** (must) — per-org rate-limit/retention миграция
- **MTI-2** (желательно) — model preset bundles

То есть **EXT-LLM-PROXY C блокирует MTI-1/3**. Если идём в C — это не 5-8 дней, а 5-8 + 2 (MTI-3) + 5 (MTI-1) = ~2 недели чистого backend.

---

## Open product/business вопросы

### Q1. Хотим ли быть LLM-gateway продуктом?

Это **расширение фокуса parsdocs**. Сегодня positioning «extract documents». Если делаем C — становимся «document processing + LLM gateway for ваших микросервисов». Это другой product story.

| Аргумент за | Аргумент против |
|-------------|-----------------|
| SLAI уже зависит от нас по документам — естественное расширение | Distraction. Сейчас vision-extract точность 96%, latency 186-820с — этим заниматься важнее |
| Lock-in | LLM gateway — конкурентный рынок (LiteLLM, OpenRouter, Portkey) |
| Visibility доходов клиента | Operational responsibility выросла |

### Q2. Биллинг-модель

Если делаем — как зарабатываем?

| Модель | Описание | Сложность |
|--------|----------|-----------|
| Free | parsdocs не перевыставляет LLM, как договорились в FOLLOWUP §11.7. Только метрики | 0 — ничего не менять |
| Markup | +10-20% к Anthropic cost. Платит SLAI организация | Средняя — нужен accounting |
| Subscription | Per-month per-tenant за LLM-gateway фичу | Высокая — биллинг infra |

Мы договорились **«parsdocs не перевыставляет LLM, не вводит throttling»** (FOLLOWUP 26.05). EXT-LLM-PROXY C **противоречит** этому — мы вводим per-org throttling/квоты. Нужен пересмотр.

### Q3. SLA для chat

Document upload: SLA «webhook прилетит в течение ~минуты» — терпимо.
Chat completions: пользователь печатает в UI, ждёт ответ — **SLA 99.5%+ uptime, p99 latency <2 sec для первого токена** (streaming). Это сильно жёстче чем document SLA.

Если делаем C — нужно вкладываться в reliability (alerting, fallback chain, retry logic), что сильно дороже maintenance чем document jobs.

### Q4. Liability при утечке ключа

Сегодня: SLAI компрометнул свой Anthropic ключ → их проблема, мы вообще не знаем.

EXT-LLM-PROXY: SLAI пишет в наш /v1/chat/completions, мы используем **наш** Anthropic ключ. Если **наш** ключ утечёт (из БД parsdocs или через прокси-bug) — это **наша** ответственность для всех N клиентов одновременно.

Юридический момент. Нужно соглашение об ответственности.

### Q5. Через сколько SLAI **реально** упрётся в проблему

Сегодня: 2 инстанса (pilot + negabarit). 2 ключа Anthropic. Это **не SUFFER**, это annoyance.

Когда станет реальной болью:
- При **5+ инстансах** rotation становится назойливой
- При **10+** audit compliance становится серьёзным
- При **подозрении на утечку** — нужен emergency rotate, который сейчас N×touch

**Текущее число — 2.** SLAI экстраполирует на будущее. Resonable, но не критично сейчас.

---

## Моё мнение (для разговора)

Я бы рекомендовал **B (light) c явным opt-in на C по триггеру:**

1. **Сегодня:** делаем B (passthrough + metering). 2-3 дня. Решает 80% жалоб SLAI: видимость есть, контроль пока нет.
2. **Не делаем C сейчас** — рано, scope creep.
3. **Триггер на C:** когда SLAI достигает 5+ active инстансов ИЛИ когда инцидент с runaway LLM-расходом случится впервые. Тогда есть конкретный business case для квот/RL.

Это компромисс:
- SLAI получают центральную точку (один ключ у нас, не у них)
- Мы получаем visibility без operational burden full gateway
- Если SLAI настаивает на C — пусть будет clear business case (не «может быть удобнее», а «теряем $X/мес из-за неконтролируемого spend»)

**Альтернатива (A) — тоже валидная.** Если посмотреть холодно: LiteLLM существует, mature, делает ровно то что нужно. Зачем нам пере-изобретать?

---

## Что от owner нужно для движения

| Решение | Ответ |
|---------|-------|
| **Q-LLM-1.** A / B / C? | ? |
| **Q-LLM-2.** Если B+: нужен MTI-3 первым (unify key storage). MTI-3 как блокер OK? | ? |
| **Q-LLM-3.** Биллинг — нам остаёмся на «не перевыставляем» (как в FOLLOWUP §11.7) или меняем? | ? |
| **Q-LLM-4.** SLA для chat completions — гарантируем 99.5%+? | ? |
| **Q-LLM-5.** Liability за наш ключ — нужно соглашение с SLAI про взаимные обязательства? | ? |
| **Q-LLM-6.** Через сколько инстансов SLAI это перестанет быть «удобство» и станет «необходимость»? | ? |

---

## История

- 2026-06-01: SLAI прислала запрос про LLM-gateway после обсуждения 5 вопросов
  (chat/auth/streaming/tools/embeddings). Их аргументация про key sprawl
  валидна; решение C vs B vs A — стратегическое, owner-decision. Документ
  написан как position paper для разговора, не как готовое ТЗ.
