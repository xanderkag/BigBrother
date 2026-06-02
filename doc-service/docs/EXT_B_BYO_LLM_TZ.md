# EXT-B — BYO LLM credentials через `X-LLM-*` заголовки

> ✅ **РЕАЛИЗОВАНО** (`808e5cb`, 18 тестов `byo-llm-credentials.spec.ts`).
> Включается флагом `BYO_LLM_ENABLED`. Это ТЗ — историческая спецификация;
> живой статус — `SLAI_INTEGRATION_BACKLOG.md` (строка EXT-B).

**Дата:** 2026-05-26
**Версия:** 1.0
**Связано:** Q11 в `INTEGRATION_QUEUE.md` · `archive/PARSDOCS_REPLY_TO_SLAI_EXT_2026-05-26.md` · §J0 SLAI ТЗ
**Оценка:** 1-2 дня (факт — реализовано)

---

## Зачем

SLAI и parsdocs — наши же микросервисы. SLAI уже владеет AI-инфрой (Anthropic
API-ключ для AI-чата). Чтобы parsdocs не дублировал у себя эту настройку и
был готов к новым consumer-микросервисам после SLAI — он принимает
LLM-credentials **per-request в заголовках**, использует их для этого
job'а вместо default'а из `provider_settings`.

**Архитектурное удобство, не коммерческая модель.** Один общий внутренний
ключ, billing на стороне consumer'а (он же владелец ключа).

**Exit criteria** (когда снимаем BYO): parsdocs заведёт свои LLM-контракты
ИЛИ LLM-extraction переедет на сторону consumer'а. Решаем встречей если
триггер случится.

---

## Контракт

### Входящие заголовки на `POST /api/v1/jobs`

| Header | Required if BYO | Значение |
|---|---|---|
| `X-LLM-Provider` | да | `anthropic` \| `openai` \| `openai_compat` |
| `X-LLM-Api-Key` | да | сырой API-ключ. **Никогда не возвращаем, не логируем, не пишем в audit/events** |
| `X-LLM-Model` | нет | имя модели у этого provider'а. Дефолт — `provider_settings.model` или env |
| `X-LLM-Base-Url` | нет | для `openai_compat` (Ollama/vLLM/LM Studio). Игнорируется для `anthropic`/`openai` |

**Поведение:**
- Все три обязательных + `BYO_LLM_ENABLED=on` → используем эти creds для job'а
- `BYO_LLM_ENABLED=off` (default) → заголовки игнорируем, warning один раз на job
- Частично (провайдер без ключа) → `400` с `error: 'byo_llm_incomplete_headers'`

### Приоритет резолва LLM для job'а

```
1. metadata._inline_llm_creds (BYO headers, EXT-B)   ← новое
2. metadata._force_provider_id (UI Test Lab)
3. default provider из provider_settings (is_default=true AND is_active=true)
4. env-fallback (config.llm.url + config.llm.apiKey)
5. NullLlmClient (stub)
```

---

## Реализация (канон = код)

Детальная архитектура из черновика этого ТЗ устарела; **источник правды — код**.
Реализованные имена отличаются от первоначального наброска:

| Сущность | Где | Имя в коде |
|---|---|---|
| Модуль | `doc-service/src/pipeline/llm/inline-credentials.ts` | — |
| Metadata-ключ | job `metadata` | `_inline_llm_creds` |
| Контекст-обёртка | provider-resolver | `withInlineCredentials(creds, fn)` |
| Шифрование/очистка | inline-credentials | `encryptInlineCredentials` / `decrypt…` / `stripInlineCredentials` |
| Флаг | config / env | `BYO_LLM_ENABLED` (default off) |
| Ошибка | upload route | `byo_llm_incomplete_headers` (400) |

**Поток:** upload-route читает `X-LLM-*` → при включённом флаге шифрует ключ
(`encryptInlineCredentials`, AES-256-GCM envelope, `SECRETS_ENCRYPTION_KEY`) →
кладёт в `metadata._inline_llm_creds`. Orchestrator оборачивает обработку в
`withInlineCredentials`; resolver строит ephemeral LLM-client и подкладывает
`provider/api_key/base_url/model` в тело запроса к inference. Decrypt — в
последний момент перед HTTP. Ключ нигде не логируется; `stripInlineCredentials`
чистит metadata в ответах / событиях / audit.

**inference-service:** request-схемы принимают `llm_provider` / `llm_api_key`
(`repr=False, exclude=True`) / `llm_base_url`; backend при наличии ключа строит
ephemeral client, иначе — default из `.env`. Inference-auth (`X-API-Key`)
независим от downstream-ключа.

### Метрики

```
extractor_llm_credentials_supplied_total{provider}
extractor_llm_provider_errors_total{provider,code}
```
`code` ∈ `{llm_auth_failed, llm_rate_limited, llm_not_configured, llm_timeout, llm_other}`.

---

## Acceptance criteria

| AC | Проверка |
|---|---|
| Header presence | `X-LLM-Api-Key` + `X-LLM-Provider` обязательны вместе |
| Encryption | ключ в БД зашифрован (`v1:` envelope), pg_dump не содержит plaintext |
| Redaction | ключ не появляется в response, logs, audit_log, events, last_llm_call, errors |
| Flag | `BYO_LLM_ENABLED=false` → headers полностью игнорируются |
| Backward compat | без X-LLM-* всё работает как раньше (default provider/env) |
| Per-request isolation | два параллельных job'а с разными ключами не делятся credentials |
| Metrics | `extractor_llm_credentials_supplied_total{provider="anthropic"}` инкрементируется |
| Inference key plumbing | inference передаёт `llm_api_key` в body и реально использует при вызове Anthropic/OpenAI |

---

## Open questions

1. **Webhook back to consumer — какие credentials?** Webhook подписан HMAC
   (`webhook.hmacSecret`), LLM-ключ обратно не отправляется. Ключ использовался
   только для inference во время processing. **Решение:** оставить до final
   state (для retry на failure), удалить через retention-cron.
2. **Невалидный ключ (401 от Anthropic).** Возвращаем `llm_auth_failed`, job →
   `failed`, **без retry** (deterministic fail).
3. **Rate-limit от Anthropic** — проксируем как `llm_rate_limited` с retry-after.
   SLAI решает что делать дальше.

---

## История

- 2026-05-26: создано после анализа scope, EXT-A закрыт (`d798917`), переход на
  EXT-B. ТЗ покрывает 2 сервиса (doc-service + inference-service): ключ должен
  дойти до Anthropic через оба слоя.
