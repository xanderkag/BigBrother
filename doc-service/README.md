# parsdocs — doc-service

Платформа обработки документов: OCR + извлечение структурированных данных + привязка к бизнес-объектам. Работает со счетами, УПД, ТТН, CMR, актами и пользовательскими типами документов.

Самостоятельный микросервис: подключается по HTTP к любой системе, не зависит от конкретной инфраструктуры.

> **Подробная архитектура:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Стек

| Слой | Технология |
|------|-----------|
| HTTP server | Node.js 22 + Fastify 5 + Zod |
| Очередь | BullMQ + Redis |
| БД | PostgreSQL 16 |
| OCR локальный | Tesseract + pdftoppm (poppler) |
| OCR/LLM API | inference-service (Python/FastAPI) |
| Auth | Bearer token (API_KEY или Personal Access Token) |
| UI | Vanilla JS + Alpine.js + Tailwind CDN (без build-шага) |

---

## Быстрый старт

### Только doc-service (без LLM)

```bash
cp .env.example .env
docker compose up --build
```

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Operator UI: `http://localhost:3000/ui/`

Миграции БД применяются автоматически при первом запуске.

В этом режиме: PDF-парсинг и regex-парсеры (счёт/УПД) работают полноценно. Сложные сканы — через tesseract. Парсеры ТТН/CMR/АКТ деградируют до `needs_review` без LLM.

### Весь стек (doc-service + inference-service)

Из корня workspace:

```bash
docker network create ai-platform
docker compose -f docker-compose.doc-platform.yml up -d --build
```

После запуска в `doc-service/.env` поставить:
```
LLM_INFERENCE_URL=http://inference:8000
```

---

## Аутентификация

Все ручки `/api/v1/*` защищены Bearer-токеном.

```bash
# .env
API_KEY=$(openssl rand -hex 32)
```

```http
Authorization: Bearer <API_KEY>
```

Поддерживаются два типа токенов:
- **API_KEY** (env) → `super_admin`, глобальный доступ
- **Personal Access Token** (PAT) → привязан к конкретному пользователю с его ролью/организацией

Мультиключевой режим: `API_KEYS_JSON='{"<key>":"<client_name>"}'`

`/health` и `/ready` всегда публичны (для load balancer / k8s пробников).

---

## Pipeline — фазы обработки

```
Upload (multipart/form-data)
  ↓
Classify    → тип документа (из hint или keywords/LLM-классификатора)
  ↓
OCR chain   → pdf-parse → tesseract → vision-llm (chain шарит растеризацию PDF)
  ↓
Parse       → regex-парсер или GenericLlmParser (из document_types.parser_kind)
  ↓
Validate    → доменные валидаторы: INN, KPP, даты, банковские реквизиты
  ↓
Finalize    → status: done | needs_review | failed + webhook
  ↓
Resolve     → привязка к справочникам (fire-and-forget, best-effort)
```

---

## API — основные группы

### Jobs

```http
POST   /api/v1/jobs                          загрузить документ
GET    /api/v1/jobs                          список (фильтры: status, document_type, from/to)
GET    /api/v1/jobs/:id                      статус и результат
PATCH  /api/v1/jobs/:id/extracted            скорректировать извлечённые данные
POST   /api/v1/jobs/:id/approve              needs_review → done
POST   /api/v1/jobs/:id/reprocess            повторный прогон (без OCR)
POST   /api/v1/jobs/:id/redeliver-webhook    принудительная повторная доставка вебхука
GET    /api/v1/jobs/:id/file                 скачать оригинал
```

**Поля загрузки** (`multipart/form-data`):

| Поле | Тип | Описание |
|------|-----|----------|
| `file` | binary | PDF, JPG, PNG, BMP, TIFF |
| `document_hint` | string | slug типа — пропускает классификатор |
| `webhook_url` | string | URL для POST результата (HMAC-signed) |
| `metadata` | string | произвольный JSON, echo в ответе |
| `project_id` | uuid | проект для multi-tenant изоляции |

**Статусы job:**
`pending` → `processing` → `done` | `needs_review` | `failed`

### Document types

```http
GET    /api/v1/document-types                список (builtin + custom)
POST   /api/v1/document-types                создать пользовательский тип
PATCH  /api/v1/document-types/:slug          настроить: prompt, schema, пороги, resolution_config
DELETE /api/v1/document-types/:slug          удалить (только non-builtin)
GET    /api/v1/document-types/:slug/history  история изменений
```

Конфигурируемые поля типа документа:
- `parser_kind` — `builtin:invoice_regex` | `builtin:upd_regex` | `llm_extract`
- `llm_prompt` — кастомная инструкция для LLM (overrides builtin prompt)
- `llm_schema` — JSON Schema для `/v1/extract`
- `expected_fields`, `validators`, `confidence_threshold`
- `resolution_config` — конфигурация привязки к справочникам (см. ниже)

### Reference Lists — справочники

```http
GET    /api/v1/reference-list-types                     список типов справочников
POST   /api/v1/reference-list-types                     создать тип
PATCH  /api/v1/reference-list-types/:slug               обновить тип
DELETE /api/v1/reference-list-types/:slug               удалить
GET    /api/v1/reference-list-types/:slug/entries       список записей (поиск, пагинация)
POST   /api/v1/reference-list-types/:slug/entries       добавить запись
POST   /api/v1/reference-list-types/:slug/entries/bulk  создать пакетно
POST   /api/v1/reference-list-types/:slug/sync          push-синхронизация от WMS/ERP
PATCH  /api/v1/reference-list-entries/:id               обновить запись
DELETE /api/v1/reference-list-entries/:id               деактивировать (soft-delete)
```

**Push-синхронизация** (`/sync`): принимает полный список актуальных записей — upsert по `external_id` + деактивация тех, кого нет в теле.

```http
POST /api/v1/reference-list-types/cargo_units/sync
Content-Type: application/json

{
  "entries": [
    {
      "external_id": "WMS-001",
      "display_name": "Грузовая единица #001",
      "search_keys": ["WMS-001", "ГЕ-001"],
      "data": { "weight": 1200, "type": "pallet" }
    }
  ]
}
```

### Resolution — привязка документа

```http
GET  /api/v1/jobs/:id/resolution              результаты привязки + summary
POST /api/v1/jobs/:id/re-resolve              повторный прогон резолюции

POST /api/v1/job-entity-links/:id/confirm     подтвердить привязку к сущности
POST /api/v1/job-entity-links/:id/reject      отклонить
POST /api/v1/job-item-matches/:id/confirm     подтвердить матч строки
POST /api/v1/job-item-matches/:id/reject      отклонить
```

#### Настройка resolution_config

В поле `document_types.resolution_config` (JSONB) задаётся конфигурация привязки:

```json
{
  "entity_links": [
    {
      "list_type": "cargo_units",
      "match_fields": ["cargo_id", "cargo_number"],
      "on_not_found": "needs_review"
    },
    {
      "list_type": "contractors",
      "match_fields": ["seller_inn"],
      "on_not_found": "warn"
    }
  ],
  "item_matching": {
    "list_type": "nomenclature",
    "items_field": "items",
    "code_field": "code",
    "name_field": "name",
    "on_not_found": "warn"
  }
}
```

`on_not_found`:
- `"needs_review"` (default для entity_links) — job переводится в needs_review
- `"warn"` — только лог
- `"ignore"` — пропускаем

### Multi-tenant

```http
GET/POST/PATCH/DELETE  /api/v1/organizations
GET/POST/PATCH/DELETE  /api/v1/projects
GET/POST/PATCH/DELETE  /api/v1/users
POST                   /api/v1/users/:id/tokens        выпустить PAT
DELETE                 /api/v1/users/:id/tokens/:tokenId
```

---

## Webhook

Тело каждой доставки подписывается HMAC-SHA256 с `WEBHOOK_HMAC_SECRET`:

```
X-DocService-Signature: sha256=<hex>
X-DocService-Job-Id:    <uuid>
X-DocService-Attempt:   <n>
```

Ретраи с экспоненциальной задержкой до `WEBHOOK_MAX_ATTEMPTS` раз.
Sweeper (`WEBHOOK_SWEEPER_INTERVAL_MS`) добивает неудачные доставки в фоне.
Принудительный повтор вручную: `POST /api/v1/jobs/:id/redeliver-webhook`.

---

## Локальный smoke-прогон (без Docker)

```bash
npm install
npm run smoke -- ./path/to/document.pdf
npm run smoke -- ./scan.jpg --hint TTN
```

Гоняет полный OCR → classify → parse без БД и очереди. Результат — JSON в stdout.

---

## Миграции БД

```bash
npm run migrate           # применить все pending
npm run migrate:down      # откатить последнюю (destructive)
npm run migrate:create add_column_x
```

В Docker: отдельный one-shot сервис `migrate` применяет миграции до запуска `api` и `worker`.

---

## Структура проекта

```
doc-service/
├── ARCHITECTURE.md          подробная архитектура и схемы
├── TECH_DEBT.md             технический долг и план доработок
├── docker-compose.yml       api + worker + postgres + redis
├── Dockerfile               node:22-slim + tesseract + poppler-utils
├── migrations/              SQL-миграции (12 штук)
├── shared/
│   └── classifier-rules.json  правила классификатора (Node + Python)
├── web/                     Operator UI (HTML + JS, без build-шага)
└── src/
    ├── server.ts            Fastify entry
    ├── worker.ts            BullMQ Worker + sweeper-процессы
    ├── config.ts            env через zod, все пороги
    ├── auth.ts / authz.ts   Bearer auth + guards + request-helpers
    ├── routes/
    │   ├── jobs.ts          CRUD jobs + approve/reprocess/redeliver
    │   ├── document-types.ts  реестр типов документов
    │   ├── reference-lists.ts справочники + bulk + sync
    │   ├── resolution.ts    привязка + confirm/reject
    │   └── tenants.ts       multi-tenant CRUD
    ├── pipeline/
    │   ├── orchestrator.ts  OCR chain → parse → validate → resolve
    │   ├── classifier/      keywords-классификатор (+ shared/classifier-rules.json)
    │   ├── ocr/             pdf-text, tesseract, vision-llm, yandex
    │   ├── parsers/         invoice, upd, ttn, cmr, akt, generic-llm
    │   ├── validation/      доменные валидаторы
    │   └── document-type-resolver.ts  TTL-кэш над document_types
    ├── resolution/
    │   ├── types.ts         TypeScript-типы + JSDoc с примером resolution_config
    │   ├── list-repo.ts     репозитории: Types, Entries, ResolutionResults
    │   └── pipeline.ts      runResolutionPipeline: entity linking + item matching
    ├── storage/
    │   ├── jobs.ts          JobsRepo
    │   ├── document-types.ts  DocumentTypesRepo
    │   └── files.ts         локальное ФС-хранилище + retention-cleanup
    └── webhooks/
        └── deliver.ts       HMAC-signed POST, retry с backoff
```

---

## Документация API

Swagger UI: `http://localhost:3000/docs`
OpenAPI JSON: `http://localhost:3000/docs/json`

Токен вводится через кнопку **Authorize** в правом верхнем углу.
