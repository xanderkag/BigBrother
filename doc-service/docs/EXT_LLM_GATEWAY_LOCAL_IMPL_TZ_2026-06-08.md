# EXT-LLM-GATEWAY (local) — parsdocs как локальный LLM-шлюз для SLAI

**Дата:** 2026-06-08
**Тип:** implementation ТЗ на согласование (без кода до апрува)
**Решения owner'а (А. Ляпустин, обсуждение 2026-06-08):** см. §1
**Заменяет:** `EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01.md` в части бэкенда — тот
документ исходил из **облачного** Anthropic/OpenAI и тянул MTI-3 + перевод
tool-форматов + /v1/usage + Prometheus (~6 дней). Локальная схема ниже это
снимает.
**Связано:** `EXT_LLM_PROXY_TZ_2026-06-01.md` (position paper, варианты A/B/C),
`DEPLOY_TOPOLOGY.md` (GPU-бокс 10.10.33.10).

---

## 1. Зафиксированные решения

| # | Решение |
|---|---------|
| Scope | Локальный стенд. Оркестратор — doc-service на **kb-docker** (10.10.13.10). |
| Бэкенд | **Только локальный GPU** `10.10.33.10` (Ollama, OpenAI-совместима). Облако запрещено (правило TAIPIT-канала). |
| Кто оркестрирует | **doc-service сам**. LiteLLM не нужен — провайдер-слой уже есть. |
| Клиент №1 | SLAI, ходит по OpenAI-совместимому API. Расширяемо на других клиентов. |
| Auth | **Именованный ключ** (`API_KEYS_JSON`, уже реализован), `Authorization: Bearer`. Серьёзная безопасность (квоты, rate-limit, ротация, mTLS) — **бэклог**. |
| Выбор модели | **Выбираем мы** (server-side). Публикуем меню алиасов; если клиент не указал — дефолт. Авто-эскалация «помощнее» — позже. |
| Стриминг | **MVP без стриминга** (non-stream). Потоковая отдача (SSE) — следующий шаг. |
| Usage | **Лёгкие счётчики** (токены, латентность, модель, клиент), **без текста промптов/ответов**. Полный учёт/квоты — позже, схему закладываем сразу. |

---

## 2. Архитектура

```
SLAI-инстанс
  │  POST /v1/chat/completions  { model?, messages[], temperature?, max_tokens? }
  │  Authorization: Bearer <named-key>
  ▼
doc-service  (kb-docker 10.10.13.10)
  │  ① auth: bearerAuthHook → named key → caller (уже есть)
  │  ② resolve alias → ollama-tag (+ base_url)         ← НОВОЕ (карта алиасов)
  │  ③ passthrough → GPU Ollama /v1/chat/completions   ← НОВОЕ (тонкий chat-клиент)
  │  ④ лёгкий счётчик usage (без content)              ← НОВОЕ (slim таблица)
  ▼
Ollama  (gpu-33-10 http://10.10.33.10:11434/v1)  — уже живой, OpenAI-совместим
  │  ⑤ ответ в OpenAI-формате (Ollama его и отдаёт)
  ▼
SLAI ← 1:1 OpenAI-format JSON
```

**Почему это просто:** бэкенд уже OpenAI-совместим → роут это
**аутентифицированный passthrough** с подменой `model` по карте алиасов.
Изменений в `inference-service` **не требуется** — идём прямо в Ollama
GPU-бокса (тот же endpoint, что уже в `OPENAI_BASE_URL`).

### Переиспользуем (есть в коде)
- `src/auth.ts` `bearerAuthHook` + `API_KEYS_JSON` (именованные ключи, caller-tag).
- `src/config.ts` — endpoint GPU-бокса уже сконфигурен (`config.llm.url`).
- Паттерн `provider_settings`/`HttpLlmClient` как образец HTTP-клиента.

### Новое
- `src/routes/llm-gateway.ts` — роуты `/v1/*`.
- `src/pipeline/llm/chat-client.ts` — тонкий generic-chat клиент (свободный
  чат; текущий `LlmClient` заточен под extraction и сюда не подходит).
- `src/storage/llm-usage.ts` + миграция — slim-счётчики.

---

## 3. Endpoints (MVP)

### `POST /v1/chat/completions`  (OpenAI-compat, non-stream)

Request:
```http
POST /v1/chat/completions
Authorization: Bearer <named-key>
Content-Type: application/json

{
  "model": "parsdocs-chat",          // опц.; нет/неизвестно → дефолт
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "temperature": 0.7,                  // опц., passthrough
  "max_tokens": 1024                   // опц., passthrough
}
```
- `stream:true` в MVP **не поддерживаем**: либо игнорируем и отвечаем одним
  JSON, либо отдаём 400 `streaming_not_supported`. **Предлагаю** принять
  `stream` и вернуть единый ответ (мягче для их клиента). Финал — на твоё ок.

Response — 1:1 OpenAI `chat.completion` (Ollama его и возвращает; мы только
подменяем `model` на опубликованный алиас в эхо-поле).

### `GET /v1/models`
Возвращает **наши** алиасы (то, что «сообщаем им»), не сырые ollama-теги:
```json
{ "object": "list", "data": [
  {"id": "parsdocs-chat",   "object": "model"},
  {"id": "parsdocs-vision", "object": "model"},
  {"id": "parsdocs-embed",  "object": "model"}
]}
```

### `POST /v1/embeddings`  (опционально в MVP)
Passthrough на `bge-m3`. Включаем, если SLAI нужен RAG в MVP (см. §7).

---

## 4. Меню моделей (предложение — меняется одной строкой конфига)

Алиасы стабильны; backend-тег можно менять без правок у SLAI.

| alias (публикуем) | backend ollama-tag (10.10.33.10) | назначение |
|---|---|---|
| `parsdocs-chat` *(default)* | `mistral-small3.1` | общий чат (текст+vision), RU ок, победитель bench v3 |
| `parsdocs-chat-ru` *(опц.)* | `T-pro-it-1.0` | упор на русский (t-tech) |
| `parsdocs-vision` | `qwen2.5vl:72b` | тяжёлая работа с изображениями |
| `parsdocs-embed` | `bge-m3` | эмбеддинги / RAG |

Хранение карты: в MVP — `LLM_GATEWAY_MODELS_JSON` (env, alias→tag) + default.
Позже мигрируем в `provider_settings` (DB-backed, через UI).

### Политика выбора (MVP)
- `model` совпал с опубликованным алиасом → используем его;
- пусто/неизвестно → `parsdocs-chat`;
- **авто-эскалация на «помощнее»** (по размеру входа / низкой уверенности /
  типу задачи) — **не в MVP**, отдельный шаг.

---

## 5. Usage (MVP — лёгкий)

Slim-таблица с первого дня (чтобы «потом считать всё» было запросом, а не
backfill'ом). Контент **не храним**.

```sql
CREATE TABLE llm_gateway_usage (
  id              BIGSERIAL PRIMARY KEY,
  caller          TEXT,           -- из named key (API_KEYS_JSON)
  alias           TEXT NOT NULL,  -- parsdocs-chat | ...
  model           TEXT NOT NULL,  -- фактический ollama-tag
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms      INTEGER NOT NULL,
  status          TEXT NOT NULL,  -- success | error | timeout
  error_code      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_llm_gw_usage_time ON llm_gateway_usage (caller, started_at DESC);
```
Не храним: `messages[]`, текст ответа, ключи. (Токены берём из Ollama `usage`.)

---

## 6. Конфиг (новые ENV)

```env
LLM_GATEWAY_ENABLED=true                       # фича-флаг; off → роуты не регистрируются
LLM_GATEWAY_BASE_URL=http://10.10.33.10:11434/v1   # GPU Ollama (по умолчанию = config.llm.url)
LLM_GATEWAY_DEFAULT_ALIAS=parsdocs-chat
LLM_GATEWAY_MODELS_JSON={"parsdocs-chat":"mistral-small3.1","parsdocs-vision":"qwen2.5vl:72b","parsdocs-embed":"bge-m3"}
LLM_GATEWAY_TIMEOUT_MS=120000
# Ключ SLAI добавляется в API_KEYS_JSON (НЕ в git, только локальный .env)
```

---

## 7. План работ (после апрува) — оценка ~1–2 дня

1. Config: флаг + base_url + карта алиасов + дефолт.
2. `chat-client.ts`: passthrough `POST {base}/chat/completions` (+ `/embeddings`),
   таймаут, маппинг ошибок Ollama → OpenAI-error.
3. `routes/llm-gateway.ts`: `POST /v1/chat/completions`, `GET /v1/models`,
   `[POST /v1/embeddings]`; регистрация в `server.ts` за фича-флагом.
4. Auth: именованный ключ SLAI в `API_KEYS_JSON` (локальный `.env`).
5. Usage: миграция `llm_gateway_usage` + insert (без контента).
6. Zod-схема `ChatCompletionRequest`.
7. Smoke: `curl` ключом SLAI → ответ от `mistral-small3.1`; `/v1/models`;
   (опц. embeddings от `bge-m3`).
8. Деплой на kb-docker (`push → pull → up --build`), **с подтверждением перед
   деплоем** (это новый публичный endpoint на боевом стеке).

### Файлы
Новые: `src/routes/llm-gateway.ts`, `src/pipeline/llm/chat-client.ts`,
`src/storage/llm-usage.ts`, `migrations/<ts>_llm_gateway_usage.sql`,
`tests/llm-gateway.spec.ts`.
Меняем: `src/server.ts` (register за флагом), `src/config.ts` (новые ENV),
`src/routes/health.ts` (`/capabilities` → блок `llmGateway`), `.env.example`.

---

## 8. Вне scope (бэклог)

- Стриминг SSE (следующий шаг после MVP).
- Per-org rate-limit, квоты, cost — вариант C, по триггеру.
- `/v1/usage` self-stats endpoint, развёрнутый Prometheus-набор.
- Ротация ключей, mTLS, HTTPS-терминация, внешний поддомен — DB Support / nginx.
- Авто-эскалация модели («смотреть» и выбирать помощнее).
- Облачные бэкенды (запрещены для SLAI-линка).
- Tool-calling: Ollama пробрасывает OpenAI-tools нативно для моделей с
  capability `tools` (qwen2.5, mistral) — passthrough заработает без перевода;
  но как **гарантированную** фичу выносим из MVP (проверим отдельно).

---

## 9. Открытые пункты (для финала)

1. **Меню моделей** — набор из §4 ок, или урезаем до одного `parsdocs-chat`?
   (по умолчанию беру §4).
2. **Embeddings в MVP** — включаем `/v1/embeddings` (`bge-m3`) сразу или
   откладываем? (по умолчанию — откладываю, включу по слову).
3. **Именованный ключ SLAI** — сгенерирую и положу в локальный `.env`
   (не в git, не в чат); передать SLAI безопасным каналом.

---

## История
- 2026-06-08: создан после обсуждения с owner'ом. Локальная схема
  (только GPU 10.10.33.10), упрощает облачный `EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01`.
  Решения: backend local-only, model выбираем мы, non-stream MVP, лёгкие
  счётчики, безопасность в бэклоге.
