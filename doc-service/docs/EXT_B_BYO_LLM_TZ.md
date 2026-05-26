# EXT-B — BYO LLM credentials через `X-LLM-*` заголовки

**Дата:** 2026-05-26
**Версия:** 1.0
**Связано:** Q11 в `INTEGRATION_QUEUE.md` · `PARSDOCS_REPLY_TO_SLAI_EXT_2026-05-26.md` · §J0 SLAI ТЗ
**Оценка:** 1-2 дня (полноценный плотный день минимум)

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
- Если все три обязательных есть И `BYO_LLM_ENABLED=on` → используем эти creds для этого job'а
- Если `BYO_LLM_ENABLED=off` (default) → заголовки игнорируем, lognо warning один раз на job
- Если присутствует частично (например, провайдер без ключа) → `400 Bad Request` с `error: 'byo_llm_incomplete_headers'`

### Приоритет резолва LLM для job'а

```
1. metadata._byo_llm (BYO headers, EXT-B)        ← новое
2. metadata._force_provider_id (UI Test Lab)
3. default provider из provider_settings (is_default=true AND is_active=true)
4. env-fallback (config.llm.url + config.llm.apiKey)
5. NullLlmClient (stub)
```

---

## Архитектура — что трогаем

### 1. doc-service / `routes/jobs.ts` (upload)

Читаем заголовки из `req.headers`. Если BYO_LLM_ENABLED + все обязательные:
```ts
const byoLlm = {
  provider: hdr('x-llm-provider'),
  apiKeyEncrypted: encryptSecret(hdr('x-llm-api-key')),
  model: hdr('x-llm-model') ?? undefined,
  baseUrl: hdr('x-llm-base-url') ?? undefined,
};
metadata._byo_llm = byoLlm;
```
**Шифруем ключ** через существующий `encryptSecret` (`SECRETS_ENCRYPTION_KEY`,
AES-256-GCM envelope). Иначе в pg_dump утечёт.

Логируем `info` (без значения ключа):
```ts
log.info({ jobId, provider: byoLlm.provider, model: byoLlm.model }, 'byo llm credentials supplied');
```

Inc метрика: `extractor_llm_credentials_supplied_total{provider}`.

### 2. doc-service / `pipeline/llm/provider-resolver.ts`

Новый метод `withForceCredentials(creds, fn)` рядом с `withForceProvider`:
```ts
withForceCredentials<T>(creds: ResolvedByoCredentials, fn: () => Promise<T>): Promise<T> {
  return forceCredsContext.run({ creds }, fn);
}
```

`delegate()` теперь проверяет ДВА AsyncLocalStorage в порядке приоритета:
```ts
const credsCtx = forceCredsContext.getStore();
if (credsCtx?.creds) return this.buildEphemeralClient(credsCtx.creds);
const providerCtx = forceProviderContext.getStore();
if (providerCtx?.providerId) return this.resolveById(providerCtx.providerId);
// ... existing default path
```

`buildEphemeralClient` — собирает `HttpLlmClient` с base_url инференса
(всегда наш — `http://inference:8000`), но в каждый POST подкладывает
`apiKey/provider/baseUrl/model` в тело (см. §3). Не кэшируем — ephemeral.

`isAvailable()` тоже учитывает: если есть `credsCtx` → true даже без
config.llm.url.

### 3. doc-service / `pipeline/llm/http-client.ts`

Расширяем `extract()/classify()/visionOcr()/verify()` методы — принимают
`opts: { byoLlm?: ResolvedByoCredentials }`. Если задан — кладём в body:
```ts
const body = {
  ...existing,
  llm_provider: byoLlm.provider,
  llm_api_key: decryptSecret(byoLlm.apiKeyEncrypted),
  llm_base_url: byoLlm.baseUrl,
  // model уже в this.opts.model или передаётся ниже
};
```

**Decrypt в самый последний момент** (только перед HTTP в inference) —
plaintext key живёт в memory ~ms. Не пишется в trace/debug/error.

### 4. doc-service / `pipeline/orchestrator.ts` (`processJob`)

Дополняем верхний switch:
```ts
const byo = metadata?._byo_llm;
if (byo) {
  return dynamicLlm.withForceCredentials(byo, () => processJobInner(...));
}
const forceId = metadata?._force_provider_id;
if (forceId) {
  return dynamicLlm.withForceProvider(forceId, () => processJobInner(...));
}
return processJobInner(...);
```

### 5. doc-service / `storage/metadata-sanitizer.ts`

Текущий sanitizer редактирует ключи матчящие `SECRET_KEY_PATTERN`
(включает `api_key`, `apikey`, `password`, etc.). Проверить что
`_byo_llm.api_key` ловится. Если нет — добавить явное правило для
`apiKeyEncrypted` (хотя оно уже зашифровано — это double-safety на случай
если кто-то добавит plaintext поле).

Test: upload с `X-LLM-Api-Key: sk-test-1234567890` → в DB
`metadata._byo_llm.apiKeyEncrypted` начинается с `v1:` (envelope) и НЕ
содержит `sk-test`.

### 6. inference-service / `schemas.py`

Добавляем в **все** request-схемы (`ClassifyRequest`, `ExtractRequest`,
`VerifyRequest`, `VisionRequest`):
```python
llm_provider: str | None = None
llm_api_key: str | None = Field(default=None, repr=False, exclude=True)
llm_base_url: str | None = None
```
`repr=False` + `exclude=True` — pydantic не печатает ключ в стек-трейсе и
в JSON-сериализации (если кто-то логирует request как dict).

### 7. inference-service / `backends/openai_compatible.py` (+ claude)

Если в request пришёл `llm_api_key` — backend создаёт **ephemeral
client** для этого вызова с переданными creds:
```python
if req.llm_api_key:
    client = self._build_ephemeral_client(
        provider=req.llm_provider or self.provider,
        api_key=req.llm_api_key,
        base_url=req.llm_base_url or self.base_url,
        model=req.model or self.model,
    )
else:
    client = self._client  # default из .env
```
Для Anthropic-backend — то же: `AnthropicClient(api_key=req.llm_api_key)`.

Не логируем `req.llm_api_key` нигде. В error-логах — `redacted`:
```python
log.warning("llm call failed", extra={"provider": req.llm_provider, "api_key_set": bool(req.llm_api_key)})
```

### 8. inference-service / `auth.py`

`require_api_key` (наш inference-auth) НЕ снимаем — это две разных вещи:
- `X-API-Key` для inference-auth (защита от внешнего доступа к inference)
- `llm_api_key` в body — credentials для downstream LLM

### 9. config

`doc-service/src/config.ts`:
```ts
byoLlmEnabled: env.BYO_LLM_ENABLED === 'true',
```
По умолчанию **off** — явный opt-in. В `.env.example`:
```
# BYO LLM (Bring Your Own LLM credentials) — consumer-микросервис передаёт
# свой ключ в X-LLM-Api-Key. Архитектурное удобство, не коммерческая модель.
# По умолчанию off — включается явно для прод-инстансов SLAI.
BYO_LLM_ENABLED=false
```

### 10. metrics

`doc-service/src/metrics.ts`:
```ts
export const extractorLlmCredentialsSuppliedTotal = new Counter({
  name: 'extractor_llm_credentials_supplied_total',
  help: 'Per-request BYO LLM credentials supplied by consumer',
  labelNames: ['provider'] as const,
});

export const extractorLlmProviderErrorsTotal = new Counter({
  name: 'extractor_llm_provider_errors_total',
  help: 'Errors from downstream LLM provider (Anthropic/OpenAI/etc.)',
  labelNames: ['provider', 'code'] as const,
});
```
`code` ∈ `{llm_auth_failed, llm_rate_limited, llm_not_configured, llm_timeout, llm_other}`.

### 11. Tests

**doc-service:**
- `tests/byo-llm.spec.ts` — POST /jobs с X-LLM-* + BYO_LLM_ENABLED=on:
  - в metadata `_byo_llm.apiKeyEncrypted` (envelope), no plaintext
  - метрика `extractor_llm_credentials_supplied_total{provider=anthropic}` инкрементирована
  - log записан без значения ключа
- BYO_LLM_ENABLED=off + те же headers → metadata НЕ содержит `_byo_llm`, warning один раз
- partial headers → 400 `byo_llm_incomplete_headers`
- end-to-end (mocked inference): job получает ephemeral client, body выпадает в inference со всеми `llm_*`

**inference-service:**
- `tests/test_byo_llm.py` — extract с `llm_api_key` → backend создаёт ephemeral client → mock-Anthropic получает переданный ключ
- без `llm_api_key` → используется default из .env (regression)
- key redacted во всех логах/трассах

---

## Sequencing

1. Inference service: schemas + backends (изолированно тестируемо)
2. doc-service: HttpLlmClient + resolver (pass-through уже работает)
3. doc-service: upload route + orchestrator + sanitizer
4. config + metrics + tests
5. Документация — обновить openapi/v1.yaml, добавить examples в INTEGRATION_QUEUE Q11

Коммитов 2-3:
- `feat(inference): per-request LLM credentials override`
- `feat(ext-b): BYO LLM via X-LLM-* headers (doc-service)`
- (опц.) `docs(openapi): X-LLM-* headers + BYO_LLM_ENABLED env`

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
| Inference key plumbing | inference shall pass через `llm_api_key` в body и реально использовать его при вызове Anthropic/OpenAI |

---

## Open questions

1. **Webhook back to consumer — какие credentials используем?** Сейчас webhook
   подписан HMAC (`webhook.hmacSecret`), без отправки LLM-ключа обратно. BYO
   LLM использовался ТОЛЬКО для inference во время processing. После — ключ
   удалить из metadata? Хранение «на retry» vs «удалить после первого
   успешного апплая webhook'а». **Предложение:** оставить до final state
   (для retry на failure), удалить через retention-cron.
2. **Какой `provider` mapping в нашем НЕвалидном случае?** Если SLAI шлёт
   `X-LLM-Provider: anthropic` но `llm_api_key` отвергнут с 401 — мы
   возвращаем `llm_auth_failed` в final state. Job уходит в `failed`. Нужна
   политика retry: NO retry на 401 (deterministic fail). **Предложение:**
   `extractor.error_code='llm_auth_failed'`, не retry'ить.
3. **Rate-limit от Anthropic** — прозрачно проксируем как `llm_rate_limited`
   с retry-after (если backend это парсит). SLAI решает что делать дальше.

---

## История

- 2026-05-26: создано после анализа scope, EXT-A закрыт (`d798917`),
  переход на EXT-B. ТЗ покрывает 2 сервиса (doc-service + inference-service)
  потому что архитектурно ключ должен дойти до Anthropic, а это два layer'а.
