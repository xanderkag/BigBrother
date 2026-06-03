# EXT-LLM-PROXY вариант B — implementation ТЗ

**Дата:** 2026-06-01
**Решение owner'а:** B (light proxy + metering) сейчас, C по триггеру (5+ инстансов SLAI или incident с runaway LLM-расходом).
**Связано:** `EXT_LLM_PROXY_TZ_2026-06-01.md` (position paper), `MTI_TZ_2026-05-31.md` (MTI-3 must)
**Размер:** **MTI-3 (2 дня) + EXT-LLM-PROXY-B (3 дня) = ~неделя**.

---

## TL;DR

Выставить **OpenAI-compatible `/v1/chat/completions`** endpoint поверх `inference-service`. SLAI consumer'ы шлют OpenAI-format запросы — parsdocs аутентифицирует через PAT, режиссирует к выбранному backend (Anthropic SDK / OpenAI SDK / local openai_compat), стримит ответ обратно, логирует usage per-org.

**Что входит:**
- `POST /v1/chat/completions` (sync + streaming SSE)
- Tool-calling passthrough (OpenAI tools → Anthropic native + обратно)
- **`POST /v1/embeddings`** (forward в OpenAI, добавлено 2026-06-02 по формальному ТЗ SLAI)
- Auth через тот же PAT (`pdpat_*`)
- Usage logging per-org (input/output tokens, latency, model, cost-N/A)
- `GET /v1/usage` (per-org агрегаты для self-stats)

**Что НЕ входит** (это вариант C, по триггеру):
- Per-org rate-limit / квоты
- Cost-calculator в $
- Multi-backend failover
- Admin endpoints для квот
- Webhook'и на квоты

---

## Зависимости (порядок реализации)

```
1. MTI-3 (unify key storage)           ← 2 дня, ОБЯЗАТЕЛЬНО первым
2. EXT-LLM-PROXY-B core (chat+usage)   ← 3 дня после MTI-3
3. + Embeddings endpoint               ← +1 день (если включаем)
```

Без MTI-3 ключ Anthropic тянется из `inference-service/.env`, что не позволяет
централизованно ротировать. Делать B без MTI-3 — будет переделывать через неделю.

**Итого:** 5-6 рабочих дней одним разработчиком.

---

## Архитектура

### Слой 1 — auth + routing (новый код в doc-service)

`doc-service/src/routes/llm-proxy.ts` (новый файл):

```
POST /v1/chat/completions
  → bearerAuthHook → resolve org_id из PAT
  → если BYO_LLM headers (X-LLM-Api-Key) → использовать их credentials (как сейчас)
  → иначе → resolve org's preferred provider через provider-resolver
  → fetchInferenceService(payload, stream=true|false)
  → log usage перед close
```

### Слой 2 — proxy + backend selection (inference-service)

`inference-service/src/inference_service/routes/chat.py` (новый файл):

```python
@router.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest, _: None = Depends(require_api_key)):
    backend = resolve_backend(req)   # Anthropic / OpenAI / Ollama
    if req.stream:
        return StreamingResponse(stream_response(backend, req), media_type="text/event-stream")
    return await backend.chat_completions(req)
```

### Слой 3 — tool-call format translation

OpenAI tool format ≠ Anthropic tool_use format. Нужны **2 translator'а:**

```python
def openai_tools_to_anthropic(tools: list) -> list:  # перед отправкой
def anthropic_tool_use_to_openai(response) -> dict:  # после ответа
```

В streaming — переводим chunks на лету (`type:tool_use_start/delta/stop` → OpenAI `tool_calls` deltas).

### Поток данных

```
SLAI consumer
  │  POST /v1/chat/completions {model, messages, stream:true, tools}
  │  Authorization: Bearer pdpat_<org-token>
  ▼
doc-service:/v1/chat/completions
  │  ① auth: PAT → org_id
  │  ② resolve creds: provider_settings.api_key (MTI-3) или X-LLM-Api-Key (BYO)
  │  ③ start usage log entry (in-memory)
  │  ④ POST inference-service:/v1/chat/completions
  ▼
inference-service:/v1/chat/completions
  │  ⑤ backend = AnthropicBackend / OpenAIBackend / OpenAICompatBackend
  │  ⑥ translate tools (OpenAI → native)
  │  ⑦ stream chunks ← Anthropic SDK
  │  ⑧ translate chunks (native → OpenAI SSE format)
  ▼
SSE chunks → doc-service → consumer (без буферизации, passthrough)
  │  ⑨ doc-service считает tokens по chunks
  ▼
After stream close:
  ⑩ INSERT INTO llm_usage_log (org_id, model, prompt_tokens, completion_tokens, latency_ms, status)
```

---

## Embeddings endpoint (добавлено 2026-06-02)

### Запрос/ответ — OpenAI-compatible

```http
POST https://vanga.sls24.ru/v1/embeddings
Authorization: Bearer pdpat_<tenant-token>
Content-Type: application/json

{
  "model": "text-embedding-3-small",  ← или "text-embedding-3-large"
  "input": ["text1", "text2"],         ← array | string
  "encoding_format": "float"            ← опц., default
}
```

Response (OpenAI v1 standard):

```json
{
  "object": "list",
  "data": [
    {"object": "embedding", "embedding": [0.123, ...], "index": 0},
    {"object": "embedding", "embedding": [0.456, ...], "index": 1}
  ],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

### Реализация

- **Backend:** forward в OpenAI `https://api.openai.com/v1/embeddings` (Anthropic
  embeddings не делает; альтернатива — Voyage AI `voyage-3-large`,
  опционально по выбору SLAI)
- **API key:** отдельная строка в `provider_settings` для `openai`
  (рядом с `anthropic`). Запросы embeddings берут именно её
- **Streaming:** не применимо для embeddings (single response)
- **Tools:** не применимо
- **Usage log:** та же таблица `llm_usage_log`; для embeddings
  `completion_tokens = 0`, `prompt_tokens` от OpenAI usage

### Файлы

```
inference-service/src/inference_service/routes/embeddings.py    ← новый
inference-service/src/inference_service/backends/openai_embeddings.py
doc-service/src/routes/llm-proxy-embeddings.ts                  ← реюзит auth+usage из chat-route
doc-service/tests/llm-proxy-embeddings.spec.ts                  ← 5-7 кейсов
```

### Что НЕ делаем

- ❌ Анти-OpenAI backend для embeddings (Voyage / Cohere / local) — отдельный
  эпик если решат менять провайдера
- ❌ Multi-modal embeddings (картинки) — не в B
- ❌ Custom dimension reduction — OpenAI поддерживает параметр `dimensions`,
  но forward'им как есть, доп. логики не вводим

### Зависимость

OpenAI API key должен быть в `provider_settings` (после MTI-3). Без ключа
`/v1/embeddings` → `503 llm_not_configured`.

---

## БД миграция

Migration `0034_llm_usage_log.sql`:

```sql
-- Up

CREATE TABLE llm_usage_log (
    id              BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    request_id      TEXT,                    -- echo X-Request-Id или генерим
    backend         TEXT NOT NULL,           -- anthropic | openai | openai_compat | stub
    model           TEXT NOT NULL,
    -- Метрики
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER GENERATED ALWAYS AS (
        COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)
    ) STORED,
    latency_ms      INTEGER NOT NULL,
    streaming       BOOLEAN NOT NULL DEFAULT false,
    -- Tool-call activity
    tools_offered   INTEGER NOT NULL DEFAULT 0,   -- сколько tools в req.tools[]
    tool_calls_made INTEGER NOT NULL DEFAULT 0,   -- сколько tool_calls в response
    -- Outcome
    status          TEXT NOT NULL,            -- success | error | aborted | timeout
    error_code      TEXT,                     -- llm_auth_failed | llm_rate_limited | ...
    error_message   TEXT,                     -- redacted, без полного текста
    -- Audit
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- BYO indicator (без ключа)
    byo_creds       BOOLEAN NOT NULL DEFAULT false
);

-- Часто запрашиваемые срезы (per-org агрегаты по неделе)
CREATE INDEX idx_llm_usage_org_time ON llm_usage_log (organization_id, started_at DESC);

-- Для error-rate мониторинга
CREATE INDEX idx_llm_usage_errors ON llm_usage_log (organization_id, status)
    WHERE status != 'success';

-- Down

DROP TABLE IF EXISTS llm_usage_log;
```

**Что НЕ храним** (важно для security):
- НЕ храним `messages[]` — это user content, может содержать PII
- НЕ храним `response content` — то же самое
- НЕ храним `api_key` ни в каком виде
- Опционально: `tools_offered` имена — но не сами schemas

---

## API спецификация

### `POST /v1/chat/completions`

**Request** (OpenAI Chat Completions v1):

```http
POST https://vanga.sls24.ru/v1/chat/completions
Authorization: Bearer pdpat_<org-token>
Content-Type: application/json
X-Request-Id: <client-side-uuid>          ← опционально, эхо в response

{
  "model": "claude-sonnet-4-5",            ← или "gpt-4o-mini" / "mistral:7b" / "auto"
  "messages": [
    {"role": "system", "content": "You are..."},
    {"role": "user", "content": "..."}
  ],
  "stream": true,                          ← опционально, default false
  "temperature": 0.7,                       ← опционально
  "max_tokens": 1024,                       ← опционально
  "tools": [                                ← опционально (OpenAI format)
    {
      "type": "function",
      "function": {
        "name": "create_request",
        "description": "...",
        "parameters": {"type": "object", "properties": {...}}
      }
    }
  ],
  "tool_choice": "auto"                     ← опционально
}
```

**Response — non-streaming** (OpenAI format, 1:1):

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1717245600,
  "model": "claude-sonnet-4-5",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "...",
      "tool_calls": [...]                   ← если модель решила вызвать tool
    },
    "finish_reason": "stop" | "tool_calls" | "length"
  }],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 17,
    "total_tokens": 59
  }
}
```

**Response — streaming SSE** (OpenAI format):

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n
data: {"id":"...","object":"...","choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n
data: {"id":"...","object":"...","choices":[{"delta":{"content":" world"},"index":0}]}\n\n
data: {"id":"...","object":"...","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n
data: [DONE]\n\n
```

Tools в stream — стандартный OpenAI chunked tool_calls delta format.

**Headers ответа:**
- `Content-Type: text/event-stream` (stream) или `application/json` (non-stream)
- `X-Request-Id: <echo>` если задан
- **Без `X-RateLimit-*`** в B (это C-feature)

### Errors

Format — OpenAI errors v1:

```json
{
  "error": {
    "message": "Invalid API key supplied",
    "type": "invalid_request_error",
    "code": "llm_auth_failed",
    "param": null
  }
}
```

| HTTP | code | Когда |
|------|------|-------|
| 401 | `invalid_pat` | PAT не найден / истёк |
| 403 | `org_disabled` | организация в статусе archived |
| 400 | `byo_llm_incomplete_headers` | присланы частично X-LLM-* без ключа |
| 400 | `unsupported_model` | модель не в `supportedLineModels` (TBD) |
| 502 | `llm_upstream_error` | Anthropic вернул 5xx |
| 401 | `llm_auth_failed` | Anthropic 401 (ключ не валиден) |
| 429 | `llm_rate_limited` | Anthropic 429 (rate-limit upstream) |
| 504 | `llm_timeout` | upstream timeout >120s |
| 503 | `llm_not_configured` | для org нет ни provider_settings.api_key, ни BYO |

### `GET /v1/usage`

```http
GET /v1/usage?from=2026-06-01&to=2026-06-08
Authorization: Bearer pdpat_<org-token>

{
  "organization_id": "9a3cb9d3-...",
  "period": { "from": "...", "to": "..." },
  "totals": {
    "requests": 1287,
    "prompt_tokens": 1450000,
    "completion_tokens": 215000,
    "total_tokens": 1665000,
    "errors": 23,
    "tool_calls_made": 412
  },
  "by_model": {
    "claude-sonnet-4-5": { "requests": 1200, "prompt_tokens": ..., "completion_tokens": ... },
    "claude-haiku-4-5":  { ... }
  },
  "by_day": [
    {"date": "2026-06-01", "requests": 145, "total_tokens": ...},
    {"date": "2026-06-02", ...}
  ]
}
```

**Access:** sandbox-token org видит только **свои** данные. super_admin — все.

---

## Tool-calling translation

### OpenAI → Anthropic (request)

```python
def openai_tools_to_anthropic(openai_tools: list[dict]) -> list[dict]:
    """
    OpenAI: [{"type":"function","function":{"name":..,"description":..,"parameters":..}}]
    Anthropic: [{"name":..,"description":..,"input_schema":..}]
    """
    return [
        {
            "name": t["function"]["name"],
            "description": t["function"]["description"],
            "input_schema": t["function"]["parameters"],
        }
        for t in openai_tools
        if t.get("type") == "function"
    ]
```

`tool_choice`:
- OpenAI `"auto"` → Anthropic `{"type":"auto"}`
- OpenAI `"required"` → Anthropic `{"type":"any"}`
- OpenAI `{"type":"function","function":{"name":"X"}}` → Anthropic `{"type":"tool","name":"X"}`

### Anthropic → OpenAI (response)

```python
def anthropic_response_to_openai(resp) -> dict:
    """Anthropic Message → OpenAI ChatCompletion"""
    content_blocks = resp.content
    text_content = "".join(b.text for b in content_blocks if b.type == "text") or None
    tool_uses = [b for b in content_blocks if b.type == "tool_use"]

    tool_calls = [
        {
            "id": b.id,
            "type": "function",
            "function": {"name": b.name, "arguments": json.dumps(b.input)},
        }
        for b in tool_uses
    ] or None

    finish_reason = "tool_calls" if tool_uses else (
        "stop" if resp.stop_reason == "end_turn" else
        "length" if resp.stop_reason == "max_tokens" else "stop"
    )

    return {
        "id": f"chatcmpl-{resp.id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": resp.model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text_content, "tool_calls": tool_calls},
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": resp.usage.input_tokens,
            "completion_tokens": resp.usage.output_tokens,
            "total_tokens": resp.usage.input_tokens + resp.usage.output_tokens,
        },
    }
```

### Streaming translation

Anthropic stream events → OpenAI SSE chunks. Поддерживаем:
- `message_start` → первый chunk с `{"role":"assistant"}` delta
- `content_block_start` (type=text) → ничего (готовимся стримить content)
- `content_block_delta` (text_delta) → chunk с `{"content":"..."}` delta
- `content_block_start` (tool_use) → chunk с `{"tool_calls":[{"index":0,"id":...,"function":{"name":...}}]}`
- `content_block_delta` (input_json_delta) → chunk с `{"tool_calls":[{"index":0,"function":{"arguments":"..."}}]}` (партиально валидный JSON, аккумулируется на consumer side)
- `content_block_stop` → ничего
- `message_delta` (stop_reason) → chunk с `{"finish_reason":"stop"|"tool_calls"|"length"}`
- `message_stop` → `data: [DONE]\n\n`

### OpenAI/Ollama passthrough

Если backend уже OpenAI-compat (`backend.openai_compat` или `BACKEND=openai`):
- **Минимум translation** — req/resp/stream проходят почти как есть
- Только `model` нужно подменить если `model="auto"` → resolved default

---

## Implementation files (план PR)

### Новые файлы

```
doc-service/src/routes/llm-proxy.ts                ← REST routes
doc-service/src/pipeline/llm/proxy-client.ts       ← обёртка вокруг HttpLlmClient.chat()
doc-service/src/storage/llm-usage.ts               ← INSERT + SELECT агрегаты
doc-service/migrations/20260602000001_llm_usage_log.sql

inference-service/src/inference_service/routes/chat.py
inference-service/src/inference_service/backends/_chat_translate.py
inference-service/src/inference_service/backends/anthropic_chat.py    ← поверх существующего anthropic.py
inference-service/src/inference_service/backends/openai_compat_chat.py
inference-service/src/inference_service/schemas_chat.py

doc-service/tests/llm-proxy-chat.spec.ts                ← 15-20 кейсов
inference-service/tests/test_chat_anthropic.py          ← с моком Anthropic SDK
inference-service/tests/test_chat_translate.py          ← unit для translators
```

### Изменяемые файлы

```
doc-service/src/server.ts             ← регистрация app.register(llmProxyRoutes)
doc-service/src/types/api-schemas.ts  ← zod-схемы для ChatCompletionRequest
doc-service/src/routes/health.ts      ← /capabilities + новое поле llmGateway:true
doc-service/src/config.ts             ← LLM_GATEWAY_ENABLED feature flag
doc-service/.env.example
inference-service/src/inference_service/main.py  ← register chat router
```

---

## Configuration

ENV-флаги (новые):

```env
# Включение LLM gateway (default off для backward compat — старые инстансы
# не получают /v1/chat/completions endpoint автоматически)
LLM_GATEWAY_ENABLED=true

# Таймауты для chat — отличаются от document jobs (короче для UX чата)
LLM_GATEWAY_TIMEOUT_MS=120000               # 2 минуты на весь chat call
LLM_GATEWAY_FIRST_TOKEN_TIMEOUT_MS=10000    # 10 сек на первый токен в stream

# Max body size — chat-запрос может быть большим (system + history + tools)
LLM_GATEWAY_MAX_BODY_BYTES=2097152          # 2 MB

# Usage log retention (для GDPR-like compliance). После — autotrim.
LLM_USAGE_LOG_RETENTION_DAYS=90
```

`/capabilities` обновляется:

```json
{
  "adapter": "parsdocs",
  "adapterVersion": "2026.06.XX",
  ...
  "llmGateway": {
    "enabled": true,
    "endpoint": "/v1/chat/completions",
    "supportedFormats": ["openai"],
    "streamingSupported": true,
    "toolCallingSupported": true,
    "supportedModels": ["claude-sonnet-4-5", "claude-haiku-4-5", "gpt-4o-mini"],
    "usageEndpoint": "/v1/usage"
  }
}
```

---

## Metrics (Prometheus)

```
llm_proxy_requests_total{org_id, model, status}                    counter
llm_proxy_tokens_total{org_id, model, direction="input|output"}    counter
llm_proxy_request_latency_seconds{org_id, model, streaming}        histogram
llm_proxy_first_token_latency_seconds{org_id, model}               histogram  (только stream)
llm_proxy_tool_calls_total{org_id, model}                          counter
llm_proxy_errors_total{org_id, model, code}                        counter
llm_proxy_active_streams{}                                          gauge
```

---

## Tests

### doc-service (`llm-proxy-chat.spec.ts`)

| # | Кейс | Ожидание |
|---|------|----------|
| 1 | POST без auth → 401 | `invalid_pat` |
| 2 | POST с истёкшим PAT → 401 | `invalid_pat` |
| 3 | POST с валидным PAT, простой prompt → 200 + OpenAI response | `usage.total_tokens > 0` |
| 4 | POST `stream:true` → 200 + SSE | chunks приходят, `data: [DONE]` в конце |
| 5 | POST с `tools[]` → response содержит `tool_calls` | translation корректный |
| 6 | POST с BYO LLM headers → используются BYO creds, не provider_settings | mock fixture inference получил `llm_api_key` |
| 7 | POST с `_force_provider_id` в headers/body → используется тот provider | TBD как именно прокидывать |
| 8 | POST → usage row создаётся | SELECT FROM llm_usage_log с этим request_id |
| 9 | POST → Anthropic 401 → 401 `llm_auth_failed` к consumer'у | metric `llm_proxy_errors_total{code=llm_auth_failed}` += 1 |
| 10 | POST → Anthropic 429 → 429 `llm_rate_limited` к consumer'у | response содержит `retry-after` если backend дал |
| 11 | POST → upstream timeout → 504 `llm_timeout` | usage_log status=timeout |
| 12 | POST stream abort клиентом → upstream stream cancelled | metric `active_streams` --, usage_log status=aborted |
| 13 | GET `/v1/usage?from=...&to=...` для своего org → 200 + агрегаты | total_tokens соответствует sum по rows |
| 14 | GET `/v1/usage` для чужого org с обычным PAT → 403 | только super_admin может смотреть чужие |
| 15 | `LLM_GATEWAY_ENABLED=false` → POST 404 | endpoint не зарегистрирован |
| 16 | POST с messages, содержащими 1.5 MB → 400 `payload_too_large` | enforce LLM_GATEWAY_MAX_BODY_BYTES |
| 17 | POST с `model:"auto"` → fallback на default из provider_settings | inference получил resolved model |
| 18 | Concurrent 10 parallel POSTs от одного org → все обработаны | gauge `active_streams` пиковое значение видно |

### inference-service

`test_chat_anthropic.py`:
- mock `anthropic.AsyncAnthropic` → проверка что req.messages корректно перевелись
- streaming: фейковый Anthropic stream → проверка что SSE chunks правильные
- tools: req.tools переведены в `input_schema`, response с `tool_use` → `tool_calls`

`test_chat_translate.py`:
- 20+ табличных кейсов на translator (OpenAI ↔ Anthropic) — golden inputs/outputs

---

## Acceptance criteria

- ✅ `POST /v1/chat/completions` с auth работает, возвращает OpenAI-format response
- ✅ Streaming SSE работает (curl с `-N` видит chunks по мере поступления, не блок до конца)
- ✅ Tools translation работает в обе стороны (mock Anthropic возвращает tool_use → consumer видит OpenAI `tool_calls`)
- ✅ BYO creds через X-LLM-Api-Key продолжают работать (backward compat с EXT-B)
- ✅ `GET /v1/usage` возвращает агрегаты, изоляция по org
- ✅ `llm_usage_log` пишется на каждый запрос (success + error), без content
- ✅ Метрики Prometheus экспортируются
- ✅ 18 doc-service spec'ов + inference unit tests — green
- ✅ `LLM_GATEWAY_ENABLED=false` полностью скрывает endpoint (no surface)
- ✅ `/capabilities` advertises llmGateway block

---

## Sequencing

```
W1 (день 1-2):  MTI-3 (unify key storage)
                  ├─ HttpLlmClient: api_key в body, не Authorization
                  ├─ inference: req.llm_api_key fallback на env
                  ├─ resolver: ключ из provider_settings в decode'нутом виде
                  └─ UI tooltip + миграция «ANTHROPIC_API_KEY env → fallback»
W1 (день 3-4):  EXT-LLM-PROXY-B backend
                  ├─ inference: chat.py + anthropic_chat + openai_compat_chat + translators
                  ├─ doc-service: llm-proxy.ts + proxy-client.ts
                  ├─ migration 0034 llm_usage_log
                  └─ /capabilities update + ENV flag
W1 (день 5):    EXT-LLM-PROXY-B tests + usage endpoint
                  ├─ 18 doc-service specs + inference unit tests
                  ├─ GET /v1/usage routing + agg query
                  ├─ Prometheus metrics
                  └─ deploy + smoke test на Asha
```

Итого **5 рабочих дней с MTI-3**. Один разработчик.

После деплоя — SLAI переключает свои инстансы с `api.anthropic.com` на `vanga.sls24.ru/v1/chat/completions` с тем же auth (наш PAT).

---

## Open implementation questions (не product, owner может ответить позже)

1. **Streaming reconnect** — если consumer'a сеть моргнула, можно ли resume stream с того места? **Нет в B**, в C можем подумать (Anthropic не даёт resume).
2. **Request ID propagation** — `X-Request-Id` сквозной через 3 hop'а (consumer → doc-service → inference → Anthropic). Если consumer не дал — генерим. Для тесных корреляций в логах.
3. **Cancellation propagation** — `AbortController` на consumer side → `client.disconnect()` на consumer ↔ doc-service → нужно cancel'ить upstream HTTP к inference → нужно cancel'ить Anthropic. Длинная цепочка. **Минимум в B**: stream закрывается, inference тоже закрывает upstream — реализуем через AsyncIterator cleanup.
4. **PII redaction в `llm_usage_log.error_message`** — что-то типа `[REDACTED]` если в message прилетит ключ или PAT.
5. **Anthropic system message vs OpenAI system message** — у Anthropic `system` это отдельный параметр (не в `messages`). Translator извлекает первый `{role:"system"}` из `messages[]` и кладёт в Anthropic `system`. Если несколько system — конкатенация.

---

## История

- 2026-06-01: написано после owner-decision (B сейчас, C по триггеру).
  Position paper — `EXT_LLM_PROXY_TZ_2026-06-01.md`. Это implementation
  ТЗ под разработку: scope, endpoints, schemas, миграция, tests, AC.
  Размер: MTI-3 (2д) + EXT-LLM-PROXY-B (3д) = неделя.
- 2026-06-02: получено формальное ТЗ SLAI (`PARSDOCS_REPLY_TO_SLAI_EXT_LLM_PROXY_2026-06-02.md`).
  Совпадает с B + добавляет `/v1/embeddings` endpoint. Embeddings forward'ятся
  в OpenAI (Anthropic не делает embeddings). Размер: +1 день = 6 рабочих дней.
  ETA: W24-25 (после WW-23 пилот-стабилизации).
