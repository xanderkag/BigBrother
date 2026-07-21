# parsdocs — Architecture

> Этот документ — **уровень дизайна** (абстрактные бэкенды, фазы пайплайна).
> **Что реально крутится на проде** (какие модели на каких портах, как
> маршрутизируется вызов, почему имя модели ≠ бэкенд, ловушки замеров) —
> в [`docs/RUNTIME_TOPOLOGY.md`](./docs/RUNTIME_TOPOLOGY.md). Эксплуатация,
> очередь и инциденты — в [`docs/OPERATIONS_RUNBOOK.md`](./docs/OPERATIONS_RUNBOOK.md).

## Обзор системы

```
┌─────────────────────────────────────────────────────────────────┐
│                        Клиенты / UI                             │
│         browser (Operator UI)  │  API clients (ERP, WMS)        │
└──────────────────┬──────────────────────────────────┬───────────┘
                   │ HTTP/REST                         │ HTTP/REST
┌──────────────────▼──────────────────────────────────▼───────────┐
│                       doc-service  (Node.js 22 + Fastify 5)      │
│                                                                   │
│  Routes:                                                          │
│   /api/v1/jobs              — загрузка, статус, approve, patch   │
│   /api/v1/document-types    — реестр типов (CRUD + config)       │
│   /api/v1/reference-list-*  — справочники (CRUD + sync)          │
│   /api/v1/job-entity-links  — привязка к сущностям               │
│   /api/v1/job-item-matches  — матчинг строк номенклатуры         │
│   /api/v1/tenants           — multi-tenant (orgs/projects/users) │
│   /api/v1/provider-settings — ключи LLM/OCR провайдеров          │
│                                                                   │
│  BullMQ Worker ──► Pipeline (OCR → Parse → Validate → Resolve)   │
└──────────┬────────────────────────────────┬──────────────────────┘
           │ SQL                            │ HTTP (inference API)
┌──────────▼──────┐              ┌──────────▼───────────────────────┐
│  PostgreSQL 16   │              │  inference-service (Python/FastAPI)│
│                  │              │                                   │
│  jobs            │              │  POST /v1/classify                │
│  document_types  │              │  POST /v1/extract                 │
│  reference_list* │              │  POST /v1/ocr                     │
│  job_entity_links│              │                                   │
│  job_item_matches│              │  Backends: Anthropic, OpenAI,     │
│  tenants, users  │              │   YandexGPT, Ollama (stub → prod) │
│  audit_log       │              └───────────────────────────────────┘
└──────────────────┘
           │
┌──────────▼──────┐
│  Redis (BullMQ)  │
│  job queue       │
│  webhook retry   │
└──────────────────┘
```

---

## Pipeline — фазы обработки документа

```
Upload (HTTP multipart)
       │
       ▼
  1. Classify
     Определяем тип документа:
     - Если client передал document_hint → берём его (пропускаем классификатор)
     - Иначе: keywords-классификатор (regex по text, если OCR уже есть)
       или /v1/classify inference endpoint
     - Результат: DocumentTypeSlug (UPD, invoice, CMR, TTN, …, custom)

       │
       ▼
  2. OCR chain
     Для каждого движка в цепочке (tesseract → vision-llm, или только один):
     - PDF → pdftoppm (один раз при >1 движка, результат шарится)
     - Tesseract: локальный, бесплатный, хорошо на печатном тексте
     - VisionLLM: vision-capable модель (Anthropic, OpenAI) для сложных макетов
     Побеждает движок с наивысшей confidence (или первый успешный если один).

       │
       ▼
  3. Parse
     Парсеры по типу документа:
     - builtin:invoice_regex — regex-парсер счетов-фактур
     - builtin:upd_regex     — regex-парсер УПД
     - llm_extract           — GenericLlmParser: POST /v1/extract с JSON Schema
     Каждый возвращает ParseResult { fields, confidence, missing[] }.
     Если regex confidence < regexFallbackThreshold → fallback на LLM.

       │
       ▼
  4. Validate
     Доменные валидаторы по типу документа (из document_types.validators[]):
     - inn_checksum, kpp_format, bank_details, date_order, …
     Невалидные поля попадают в validation_issues[].
     Если confidence < confidenceThreshold или есть critical issues → needs_review.

       │
       ▼
  5. Finalize
     - Сохраняем extracted, confidence, ocr_engine, validation_issues в DB
     - status: done | needs_review | failed
     - Доставка webhook (если настроен)

       │
       ▼
  6. Resolution (fire-and-forget, best-effort)
     Если у типа документа задан resolution_config:
     - Entity links: ищем значения полей в справочниках (cargo_units, contracts, …)
     - Item matching: матчим строки items[] по коду/названию с номенклатурой
     - Результат: job_entity_links, job_item_matches
     - on_not_found: needs_review | warn | ignore
```

---

## Resolution Engine

### Концепция

После извлечения данных из документа нужно «привязать» его к бизнес-объектам:
- **Счёт-фактура** → контрагент из справочника + строки к номенклатуре
- **ТТН** → грузовая единица из cargo_units
- **УПД** → контрагент + позиции

Конфигурация хранится в `document_types.resolution_config` (JSONB) — меняется через
UI без пересборки кода.

### resolution_config — JSON Schema

```jsonc
{
  // Список entity_links — привязка полей документа к записям справочников
  "entity_links": [
    {
      "list_type": "cargo_units",       // slug справочника
      "match_fields": ["cargo_id", "cargo_number"], // поля из extracted
      "on_not_found": "needs_review"    // needs_review | warn | ignore
    },
    {
      "list_type": "contractors",
      "match_fields": ["seller_inn", "seller_name"],
      "on_not_found": "warn"
    }
  ],

  // item_matching — матчинг строк товарной части
  "item_matching": {
    "list_type": "nomenclature",   // справочник номенклатуры
    "items_field": "items",        // путь к массиву строк в extracted
    "code_field": "code",          // поле кода/артикула (default: "code")
    "name_field": "name",          // поле названия (default: "name")
    "on_not_found": "warn"         // поведение при ненахождении
  }
}
```

### Стратегия матчинга (v1 — exact)

```
Entity link:
  extracted[match_fields[0]] → exactSearch(search_keys[]) → suggested
  extracted[match_fields[1]] → exactSearch(search_keys[]) → suggested (если первый не нашёл)

Item matching (на каждую строку items[]):
  1. exactSearch(code)         → suggested (match_method: exact_code)
  2. exactSearch(name.lower()) → suggested (match_method: exact_name)
  нет совпадений               → not_found
```

GIN-индекс на `search_keys[]` обеспечивает O(1) поиск на типичных объёмах каталога.

### Жизненный цикл результата

```
suggested  →  confirmed  (оператор одобрил, опционально с другим entry_id)
           →  rejected   (оператор отклонил)
not_found  →  confirmed  (оператор вручную указал запись)
           →  rejected
```

---

## Reference Lists (справочники)

### Структура

```
reference_list_types (slug, organization_id, label, search_hint)
    ↕ 1:N
reference_list_entries (id UUID, list_type_slug, organization_id,
                        external_id, display_name, search_keys TEXT[],
                        data JSONB, is_active, synced_at)
```

### Синхронизация от внешних систем

```
POST /api/v1/reference-list-types/:slug/sync
Body: { entries: [{ external_id, display_name, search_keys[], data? }] }

Семантика bulkSync:
  - upsert по external_id (ON CONFLICT … DO UPDATE)
  - записи с external_id которых нет в теле → is_active=false (soft-delete)
  - возвращает { upserted, deactivated }
```

Типичный сценарий: WMS отправляет `/sync` при любом изменении в своей БД.
doc-service хранит актуальный snapshot и использует его для resolution.

---

## Multi-tenant модель

```
organizations
    ↕ 1:N
projects
    ↕ N:M (через user_project_access)
users
    roles: super_admin | org_admin | manager | viewer

API tokens:
  - API_KEY (env) → super_admin, нет org
  - personal_access_tokens → конкретный user с его role/org
```

Все данные (jobs, document_types, reference_lists) изолированы по `organization_id`.
`super_admin` видит всё без фильтра.

---

## Ключевые технологии

| Слой         | Технология                          |
|--------------|-------------------------------------|
| HTTP server  | Fastify 5 + fastify-type-provider-zod |
| Validation   | Zod (runtime + TypeScript types)     |
| Queue        | BullMQ (Redis)                       |
| DB           | PostgreSQL 16 (pg driver)            |
| OCR local    | Tesseract.js + pdftoppm              |
| OCR/LLM API  | inference-service (Python/FastAPI)   |
| UI           | Vanilla JS + Alpine.js + Tailwind CDN |
| Auth         | Bearer token (API_KEY или PAT)        |

---

## Директории doc-service

```
src/
  auth.ts                — bearerAuthHook, req.user типизация
  authz.ts               — guards (requireProjectWrite, …) + helpers (getOrgId, getUserId)
  config.ts              — env-переменные, все пороги и таймауты
  server.ts              — Fastify app, регистрация плагинов и роутов
  worker.ts              — BullMQ worker, sweeper-процессы

  pipeline/
    orchestrator.ts      — главный оркестратор: OCR chain → parse → validate → finalize → resolve
    classifier/          — keywords-классификатор типов документов
    ocr/                 — движки: tesseract, vision-llm, pdf-text, yandex
    parsers/             — парсеры по типу: upd, invoice, cmr, ttn, generic-llm
    validation/          — доменные валидаторы (INN, KPP, даты, …)
    document-type-resolver.ts — TTL-кэш над document_types репо

  resolution/
    types.ts             — TypeScript-типы + JSDoc схем для resolution_config
    list-repo.ts         — репозитории: ReferenceListTypes, Entries, ResolutionResults
    pipeline.ts          — runResolutionPipeline: entity linking + item matching

  routes/
    jobs.ts              — CRUD jobs + approve/reprocess/redeliver-webhook
    document-types.ts    — CRUD document_types + cache invalidation
    reference-lists.ts   — CRUD справочников + bulk + sync
    resolution.ts        — GET resolution, re-resolve, confirm/reject
    tenants.ts           — orgs/projects/users/tokens

  storage/
    jobs.ts              — JobsRepo: findById, create, patch, listStaleWebhooks
    document-types.ts    — DocumentTypesRepo: findBySlug, create, patch, delete
    files.ts             — файловое хранилище (local FS), retention-cleanup

  webhooks/
    deliver.ts           — HMAC-signed POST, retry с экспоненциальным backoff

  workers/
    webhook-sweeper.ts   — автодобивка неудачных вебхуков (sweeper)
    file-cleanup.ts      — удаление файлов по retention-политике
    pending-job-sweeper.ts — перезапуск застрявших pending-job'ов
    audit-log-sweeper.ts — архивация старых записей аудит-лога

migrations/              — SQL-миграции в хронологическом порядке
shared/
  classifier-rules.json  — единый источник правил классификации (Node + Python)
web/                     — Operator UI (HTML + app.js, без build-шага)
```
