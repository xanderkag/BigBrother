# parsedocs — doc-service

Универсальная платформа интеллектуальной обработки документов: **OCR + LLM-extraction + привязка к справочникам**. Работает с 15 типами транспортных, бухгалтерских и таможенных документов; поддерживает многострочные таблицы до 1000 позиций; настраивается через UI без правок кода.

```
Документ (PDF/JPG/PNG/TIFF)
   │
   ▼
[OCR chain] pdf-text → tesseract → vision-LLM → yandex
   │
   ▼
[Classify] keyword regex или /v1/classify (LLM)
   │
   ▼
[Parse] regex (builtin) или LLM /extract (одно-/двухпроходный)
   │
   ▼
[Validate] доменные валидаторы (ИНН, КПП, НДС-разбивка, сверка строк)
   │
   ▼
[Resolve] привязка к справочникам организации (cargo_units, nomenclature, …)
   │
   ▼
Webhook + UI + REST API
```

> **Архитектура подробно:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · **Технический долг:** [`../TECH_DEBT.md`](../TECH_DEBT.md) · **Деплой:** [`../DEPLOY.md`](../DEPLOY.md)

---

## TL;DR

**Что умеет:**

- 15 типов документов, до 22 полей на строку, до 1000 строк в одном документе
- Resolution Engine — автопривязка к справочникам организации с поведением `needs_review / warn / ignore`
- MultiPass extraction для длинных таблиц (>30KB OCR-текста авторежим)
- Per-line валидаторы: сверка сумм, ставки НДС, единицы, ТН ВЭД, qty×price
- Multi-tenant (organizations / projects / users / personal access tokens)
- Operator UI (Vanilla JS + Alpine + Tailwind self-hosted) + Test Lab для админов
- Webhook с HMAC-подписью, sweeper для авторетраев, idempotency
- Audit log на админ-изменения, retention-cleanup на файлы и логи

**Что внутри:**

- `doc-service` (Node 22 + Fastify 5) — основное API, OCR-пайплайн, BullMQ-worker
- `inference-service` (Python + FastAPI) — LLM-бэкенды (Anthropic / OpenAI-compat / YandexGPT / Ollama / stub)
- Postgres 16 + Redis + локальное файловое хранилище

---

## Быстрый старт

### 1. Только doc-service (без LLM)

```bash
cp .env.example .env
docker compose up --build
```

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs`
- Operator UI: `http://localhost:3000/ui/` (редирект с `/`)

Миграции применяются автоматически one-shot-сервисом `migrate` перед стартом `api` и `worker`.

В этом режиме регексные парсеры (счёт, УПД) работают, сложные сканы и не-builtin типы — деградируют до `needs_review` без LLM.

### 2. Полный стек (doc-service + inference-service)

Из корня workspace:

```bash
docker network create ai-platform
docker compose -f docker-compose.doc-platform.yml up -d --build
```

В `doc-service/.env` поставить:
```
LLM_INFERENCE_URL=http://inference:8000
```

После этого через UI можно настроить LLM-провайдеров (Providers → Активный) и парсеры начнут реально извлекать поля для всех типов.

### 3. Локальные модели (Ollama / vLLM / llama.cpp)

Любой OpenAI-совместимый сервер. Через UI в Providers создать `kind=llm`, `base_url=http://host.docker.internal:11434/v1` (или другой), указать `model`. Pipeline начнёт ходить туда.

---

## Аутентификация

Все ручки `/api/v1/*` за Bearer-токеном.

```bash
# .env
API_KEY=$(openssl rand -hex 32)
```

```http
Authorization: Bearer <API_KEY>
```

**Два режима:**

| Тип | Кто | Что доступно |
|-----|-----|--------------|
| **API_KEY** (env) | глобальный root | `super_admin` — всё, везде, без org-фильтра |
| **Personal Access Token** (UI/CRUD) | конкретный user | роль и organization_id из БД |

**Multi-key:** `API_KEYS_JSON='{"<key>":"<client_name>"}'` — разные ключи разным интеграторам с client-tag в audit-log.

**Dev-mode:** `API_KEY=""` (пустой) → auth выключен, любой запрос идёт как `super_admin`. UI автоматически детектит это и пропускает экран логина.

`/health` и `/ready` всегда публичны (для load balancer / k8s).

---

## Pipeline — фазы обработки документа

```
1. Upload (multipart) → POST /api/v1/jobs
   ├─ Magic-bytes проверка типа файла (защита от .exe в .pdf)
   ├─ Idempotency-Key из заголовка (по умолчанию SHA-256 содержимого)
   └─ Создание job_id, сохранение в Postgres, постановка в BullMQ

2. Classify (worker)
   ├─ Если document_hint указан клиентом → пропускаем шаг
   ├─ Иначе: keyword-классификатор (regex по тексту OCR) или /v1/classify (LLM)
   └─ Результат: один из 15 DocumentTypeSlug, либо custom-тип из БД

3. OCR chain — пробуем движки от быстрого к медленному
   ├─ pdf-text       — извлечение текста из текстовых PDF (мгновенно)
   ├─ tesseract      — локальный OCR (rus+eng по умолчанию)
   ├─ vision-llm     — Qwen-VL / Claude / GPT-Vision (для сложных макетов)
   └─ yandex.vision  — резерв (с warning про 152-ФЗ, по умолчанию off)
   Каждый со своим порогом confidence; первый прошедший — побеждает.
   Для PDF: pdftoppm рендерит страницы один раз и шарит между движками (no double rasterization).

4. Parse
   ├─ parser_kind = builtin:invoice_regex | builtin:upd_regex — regex с LLM-fallback
   ├─ parser_kind = llm_extract — GenericLlmParser, один запрос к /v1/extract
   └─ parser_kind = llm_extract_multipass — двухпроходный для длинных таблиц:
      Pass 1: header (4KB head + 2KB tail), схема без items[]
      Pass 2: items[] батчами ~12KB, параллелизм 3, до 1000 строк
   Авторежим: если parser_kind=llm_extract и rawText > MULTIPASS_AUTO_BYTES (default 30KB) → multipass.

5. Validate
   ├─ Доменные валидаторы из document_types.validators[]:
   │  inn_checksum / kpp_format / vehicle_plate / country_code / date_range /
   │  money_sanity / vat_consistency / parties_differ / weight_nett_le_gross
   ├─ Per-line валидаторы (Phase D) для items[]:
   │  items_total_sum — сумма строк сходится с шапкой (±0.02)
   │  items_vat_rates — vat_rate ∈ {0, 5, 7, 10, 20}
   │  items_unit_known — единицы из словаря 40 вариантов
   │  items_line_consistency — qty × price ≈ total_without_vat
   │  items_hs_code_format — 8 или 10 цифр для ВЭД/таможни
   └─ Невалидные → validation_issues[]; ниже порога confidence → status=needs_review

6. Finalize
   ├─ Запись extracted, confidence, ocr_engine, pipeline_steps в БД
   ├─ Доставка webhook (HMAC-SHA256, retry с backoff)
   └─ Статус: done | needs_review | failed

7. Resolve (fire-and-forget, best-effort)
   Если у типа задан resolution_config — после finalize запускается
   привязка к справочникам организации (entity_links + item_matching).
   See "Resolution Engine" ниже.
```

---

## 15 типов документов — что извлекаем

| slug | Назначение | Top-level | Леafs | items[] | Полей/строку |
|------|-----------|-----------|-------|---------|--------------|
| `invoice` | Счёт на оплату | 16 | 31 | ✓ | **19** |
| `factInvoice` | Счёт-фактура | 16 | 31 | ✓ | **19** |
| `UPD` | УПД (универсальный передаточный) | 16 | 31 | ✓ | **19** |
| `TTN` | ТТН-1.2 (товарно-транспортная) | 11 | 27 | ✓ | **19** |
| `CMR` | CMR (международная) | 11 | 19 | ✓ | **19** |
| `AKT` | Акт работ | 16 | 25 | ✓ | **19** |
| `payment_order` | Платёжное поручение 0401060 | 10 | 22 | — | — |
| `commercial_invoice` | Коммерческий инвойс (ВЭД) | 15 | 24 | ✓ | **19** |
| `packing_list` | Упаковочный лист | 9 | 14 | ✓ | **22** ⭐ |
| `bill_of_lading` | Коносамент (B/L) | 16 | 21 | ✓ | **21** ⭐ |
| `customs_declaration` | ГТД / Декларация на товары | 14 | 24 | ✓ | **22** ⭐ |
| `cash_receipt` | Кассовый чек | 13 | 19 | ✓ | **19** |
| `contract` | Договор | 18 | 42 | — | — |
| `contract_specification` | Спецификация к договору | 12 | 18 | ✓ | **20** ⭐ |
| `contract_addendum` | Допсоглашение | 12 | 20 | — | — |

⭐ — с domain-специфичными полями поверх 19-полевого канона:
- `packing_list`: `package_type`, `dimensions`, `volume`
- `bill_of_lading`: `marks_and_numbers`, `container_number`
- `customs_declaration`: `invoice_value`, `customs_value`, `statistical_value`
- `contract_specification`: `delivery_term`

**Канонический shape строки `items[i]` (Phase A v2):**
```
line_no, code, barcode, name, hs_code, country_of_origin,
unit, qty, qty_per_package, packages,
weight_net, weight_gross,
price, vat_rate, vat_amount, total_without_vat, total_with_vat,
currency, notes
```

Builtin-схемы в `src/types/document-json-schemas.ts`, DB-seeded — в миграциях 0005/0006/0015.

---

## API — основные группы

### Jobs

```http
POST   /api/v1/jobs                          загрузить документ
GET    /api/v1/jobs                          список с фильтрами
GET    /api/v1/jobs/:id                      статус и результат
PATCH  /api/v1/jobs/:id/extracted            скорректировать данные
POST   /api/v1/jobs/:id/approve              needs_review → done
POST   /api/v1/jobs/:id/reprocess            перепрогон без OCR
POST   /api/v1/jobs/:id/redeliver-webhook    принудительная доставка
GET    /api/v1/jobs/:id/file                 скачать оригинал
GET    /api/v1/jobs/:id/resolution           результаты привязки
POST   /api/v1/jobs/:id/re-resolve           перезапуск резолюции
```

**Поля загрузки** (`multipart/form-data`):

| Поле | Тип | Описание |
|------|-----|----------|
| `file` | binary | PDF, JPG, PNG, BMP, TIFF (до 50 MB) |
| `document_hint` | string | slug типа — пропускает классификатор |
| `webhook_url` | string | URL для POST результата (HMAC-signed) |
| `metadata` | string JSON | echo обратно в результат и webhook |
| `project_id` | uuid | проект для multi-tenant изоляции |

**Статусы:** `pending` → `processing` → `done` | `needs_review` | `failed`

### Document Types — реестр и конфигурация

```http
GET    /api/v1/document-types                список (builtin + custom)
POST   /api/v1/document-types                создать пользовательский тип
PATCH  /api/v1/document-types/:slug          обновить конфигурацию
DELETE /api/v1/document-types/:slug          удалить (только non-builtin)
GET    /api/v1/document-types/:slug/history  audit log изменений
GET    /api/v1/document-types/:slug/stats    статистика обработки за N дней
GET    /api/v1/document-types/:slug/jobs     последние N jobs этого типа
```

Конфигурируемые через UI поля:
- `parser_kind` — `builtin:invoice_regex` / `builtin:upd_regex` / `llm_extract` / `llm_extract_multipass`
- `llm_prompt` — кастомная инструкция (overrides builtin)
- `llm_schema` — JSON Schema для `/v1/extract`
- `expected_fields`, `validators`, `confidence_threshold`, `regex_fallback_threshold`
- `classification_keywords` — regex для классификатора без hint
- `resolution_config` — конфиг привязки к справочникам

### Reference Lists — справочники

```http
GET    /api/v1/reference-list-types                     список типов
POST   /api/v1/reference-list-types                     создать тип
PATCH  /api/v1/reference-list-types/:slug               обновить
DELETE /api/v1/reference-list-types/:slug               удалить (cascade entries)
GET    /api/v1/reference-list-types/:slug/entries       поиск/пагинация
POST   /api/v1/reference-list-types/:slug/entries       добавить запись
POST   /api/v1/reference-list-types/:slug/entries/bulk  пакетное создание (txn)
POST   /api/v1/reference-list-types/:slug/sync          push-sync от WMS/ERP (txn)
PATCH  /api/v1/reference-list-entries/:id               обновить запись
DELETE /api/v1/reference-list-entries/:id               soft-delete (is_active=false)
```

**Push-синхронизация** для интеграции с WMS/ERP:
```http
POST /api/v1/reference-list-types/cargo_units/sync
{
  "entries": [
    {
      "external_id": "WMS-001",
      "display_name": "ГЕ #001 — палет 1200×800",
      "search_keys": ["WMS-001", "ГЕ-001", "001"],
      "data": { "weight": 1200, "type": "pallet" }
    }
  ]
}
```
Семантика: upsert по `external_id` + soft-delete тех, кого нет в теле. Транзакционно, all-or-nothing.

GIN-индекс на `search_keys[]` обеспечивает O(1) lookup на типичных объёмах.

### Resolution Engine — привязка к справочникам

```http
GET  /api/v1/jobs/:id/resolution              результаты + summary
POST /api/v1/jobs/:id/re-resolve              перезапуск (advisory lock)

POST /api/v1/job-entity-links/:id/confirm     подтвердить привязку
POST /api/v1/job-entity-links/:id/reject      отклонить
POST /api/v1/job-item-matches/:id/confirm     подтвердить матч строки
POST /api/v1/job-item-matches/:id/reject      отклонить
```

#### Конфигурация resolution_config

Хранится в `document_types.resolution_config` (JSONB). Редактируется через UI editor типа документа (Document Types → выбрать → секция «Резолюция»):

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

**`on_not_found`:**
- `"needs_review"` (default для entity_links) — job переходит в `needs_review`, в `extracted._issues[]` пишется причина
- `"warn"` (default для item_matching) — только лог
- `"ignore"` — молча пропускается

**Жизненный цикл результата:**
```
suggested → confirmed (опционально с другим entry_id)
         → rejected
not_found → confirmed (оператор вручную указал)
         → rejected
```

### Multi-tenant

```http
GET/POST/PATCH/DELETE  /api/v1/organizations
GET/POST/PATCH/DELETE  /api/v1/projects
GET/POST/PATCH/DELETE  /api/v1/users
GET                    /api/v1/users/me
POST/GET/DELETE        /api/v1/users/:id/tokens      Personal Access Tokens
GET                    /api/v1/users/access          per-project роли
```

**Роли:** `super_admin` (всё) · `org_admin` (своя org) · `manager` (write на проекты из ACL) · `viewer` (read-only).

---

## Webhook

Каждая доставка подписывается HMAC-SHA256:
```http
X-DocService-Signature: sha256=<hex>
X-DocService-Job-Id:    <uuid>
X-DocService-Attempt:   <n>
```

Ретраи: экспоненциальный backoff до `WEBHOOK_MAX_ATTEMPTS` раз.

**Sweeper** добивает неудачные доставки в фоне (`WEBHOOK_SWEEPER_*` env). Счётчик `webhook_attempts` накапливается, hard-limit 15 = 3 волны × 5 ретраев.

**Принудительный повтор:** `POST /api/v1/jobs/:id/redeliver-webhook?force=true` — нужен `?force=true` если webhook уже был успешно доставлен, иначе 409.

---

## UI — два режима

### `#upload` — для бизнес-пользователя
- Dropzone + Тип документа (с превью извлекаемых полей)
- Очередь файлов: статус + краткая сводка (тип, confidence, ocr_engine, замечания)
- Под `<details>` «Настройки для разработчиков»: webhook, metadata
- Скрыты: engine chain, model picker

### `#test-lab` — для админа/тестера (gated on role)
Всё из Upload плюс:
- Engine chain badges с тултипами (PDF-text → Tesseract → Vision LLM → Yandex)
- LLM-провайдер picker (per-job override через `metadata._force_provider_id`)
- Inline result preview на той же странице после загрузки: pipeline timeline + extracted JSON + items table — без перехода в job detail

### Items Table (Phase C)
В job detail между «Extracted data» и «Этапы обработки»:
- 8 основных столбцов (#, код, наименование, кол-во, ед, цена, НДС%, сумма)
- 10+ дополнительных полей раскрываются кликом на строку (barcode, hs_code, страна, веса, currency, notes, …)
- Полнотекстовый поиск (name + code + barcode), debounce 200ms
- Сортировка по любому столбцу (кликом)
- Пагинация client-side, 50 строк на страницу
- Экспорт в CSV (RFC 4180 + UTF-8 BOM для Excel под Windows)

---

## Конфигурация — все env-переменные

| Группа | Переменная | Default | Описание |
|--------|-----------|---------|----------|
| **Базовое** | `PORT` | 3000 | Порт API внутри контейнера |
| | `HOST_PORT` | =PORT | Порт на хосте для compose |
| | `HOST` | 0.0.0.0 | Host для bind |
| | `LOG_LEVEL` | info | pino-уровень |
| | `MAX_UPLOAD_MB` | 50 | Лимит загрузки |
| | `MAX_METADATA_BYTES` | 4096 | Лимит JSON metadata |
| **Соединения** | `DATABASE_URL` | — | Postgres connection string |
| | `REDIS_URL` | — | Redis URL для BullMQ |
| | `STORAGE_DIR` | /app/data | Файловое хранилище |
| **Auth** | `API_KEY` | — | Глобальный root-токен. Пустой = dev-mode |
| | `API_KEYS_JSON` | — | Multi-key JSON `{key: client_name}` |
| | `SECRETS_ENCRYPTION_KEY` | — | Master-ключ для шифрования provider keys (hex) |
| **Worker** | `WORKER_CONCURRENCY` | 4 | Параллельность BullMQ |
| | `JOB_MAX_AGE_SECONDS` | 600 | Hard deadline на job |
| **OCR пороги** | `PDF_TEXT_ACCEPT_THRESHOLD` | 0.9 | Confidence чтобы принять pdf-text |
| | `TESSERACT_ACCEPT_THRESHOLD` | 0.75 | То же для tesseract |
| | `VISION_LLM_ACCEPT_THRESHOLD` | 0.75 | Для Vision LLM |
| | `NEEDS_REVIEW_THRESHOLD` | 0.6 | Ниже — статус needs_review |
| | `LLM_FALLBACK_THRESHOLD` | 0.7 | Regex confidence ниже → LLM-fallback |
| | `MULTIPASS_AUTO_BYTES` | 30000 | Если OCR-текст больше — авто-multipass |
| | `TESSERACT_LANGS` | rus+eng | Языки tesseract |
| **LLM** | `LLM_INFERENCE_URL` | — | URL inference-service |
| | `LLM_API_KEY` | — | Ключ к inference (если нужен) |
| | `LLM_TIMEOUT_MS` | 60000 | Таймаут /extract |
| **Yandex** | `YANDEX_VISION_API_KEY` | — | Ключ Yandex Cloud Vision |
| | `YANDEX_FOLDER_ID` | — | Folder ID |
| | `YANDEX_TIMEOUT_MS` | 30000 | |
| **Webhook** | `WEBHOOK_HMAC_SECRET` | — | Секрет HMAC-подписи |
| | `WEBHOOK_MAX_ATTEMPTS` | 5 | Ретраев на одну доставку |
| | `WEBHOOK_SWEEPER_INTERVAL_MS` | 900000 | Период sweeper (15 мин) |
| | `WEBHOOK_SWEEPER_GRACE_MINUTES` | 60 | Grace до перезапуска |
| | `WEBHOOK_SWEEPER_HARD_LIMIT` | 15 | Hard-limit попыток |
| **Sweepers** | `PENDING_SWEEPER_INTERVAL_MS` | 60000 | Перезапуск зависших job |
| | `PENDING_SWEEPER_GRACE_SECONDS` | 30 | |
| | `FILE_CLEANUP_INTERVAL_MS` | 3600000 | Чистка старых файлов |
| | `FILE_RETENTION_DAYS` | 30 | |
| | `AUDIT_LOG_SWEEP_INTERVAL_MS` | 86400000 | Архивация audit log |
| | `AUDIT_LOG_RETENTION_DAYS` | 90 | |
| **Прочее** | `RATE_LIMIT_PER_MINUTE` | 60 | 0 = выключить |
| | `SLOW_JOB_THRESHOLD_MS` | 30000 | Лог-флаг slow job |

См. `.env.example` для актуального шаблона.

---

## Структура проекта

```
parsedocs/
├── README.md                  ← вы здесь
├── ARCHITECTURE.md            ← детальная архитектура
├── TECH_DEBT.md               ← технический долг
├── DEPLOY.md                  ← регламент развёртывания
├── DEPLOY-REQUEST.md          ← заявка DevOps
├── docker-compose.doc-platform.yml   ← master compose
├── docker-compose.local-models.yml   ← Ollama/локальные модели
├── docker-compose.monitoring.yml     ← Prometheus + Grafana
├── shared/
│   └── classifier-rules.json  ← единый источник правил классификатора
├── monitoring/                ← Prometheus + Grafana dashboards
├── scripts/
│   └── network-test/          ← smoke/load/soak/stress оснастка
├── docs/
│   ├── TESTING_REGULATION.md  ← регламент сетевых прогонов
│   └── test-runs/             ← отчёты прогонов
├── inference-service/         ← Python FastAPI, LLM-бэкенды
└── doc-service/
    ├── README.md (этот)
    ├── docker-compose.yml     ← api + worker + postgres + redis
    ├── Dockerfile             ← node:22-slim + tesseract + poppler
    ├── package.json
    ├── migrations/            ← 15 миграций (0001-0015)
    ├── tests/                 ← 25 vitest spec файлов
    ├── web/                   ← Operator UI (без build-step для JS)
    │   ├── index.html
    │   ├── app.js             ← ~5000 строк, hash-routing, fetch
    │   ├── input.css          ← Tailwind input
    │   ├── tailwind.config.cjs
    │   └── vendor/            ← precompiled tailwind.css + alpine.min.js
    └── src/
        ├── server.ts          ← Fastify entry + плагины
        ├── worker.ts          ← BullMQ worker + sweeper-процессы
        ├── config.ts          ← все env через Zod
        ├── auth.ts            ← Bearer + req.user типизация
        ├── authz.ts           ← guards (requireProjectWrite…) + helpers
        ├── db.ts              ← Postgres pool + withTransaction()
        ├── queue.ts           ← BullMQ setup
        ├── metrics.ts         ← Prometheus registry
        ├── routes/
        │   ├── jobs.ts        ← CRUD jobs + approve/reprocess/redeliver
        │   ├── document-types.ts  ← реестр типов
        │   ├── reference-lists.ts ← справочники + sync
        │   ├── resolution.ts  ← привязка + confirm/reject
        │   ├── tenants.ts     ← multi-tenant CRUD
        │   ├── provider-settings.ts ← ключи LLM/OCR провайдеров
        │   ├── audit-log.ts
        │   ├── settings.ts    ← снимок конфига
        │   ├── operational-metrics.ts ← дашборд-метрики
        │   ├── metrics.ts     ← /metrics для Prometheus
        │   └── health.ts
        ├── pipeline/
        │   ├── orchestrator.ts ← OCR chain → parse → validate → resolve
        │   ├── router.ts      ← выбор цепочки OCR
        │   ├── quality.ts     ← combineConfidence эвристики
        │   ├── document-type-resolver.ts ← TTL-кэш над document_types
        │   ├── classifier/    ← keywords + LLM
        │   ├── ocr/           ← pdf-text, tesseract, vision-llm, yandex
        │   ├── parsers/       ← invoice/upd/ttn/cmr/akt regex + generic-llm + multipass-llm
        │   ├── validation/    ← валидаторы (16 builtin'ов)
        │   └── llm/           ← клиент к inference-service
        ├── resolution/
        │   ├── types.ts       ← ResolutionConfig + JSDoc
        │   ├── list-repo.ts   ← репозитории справочников
        │   └── pipeline.ts    ← runResolutionPipeline с advisory lock
        ├── storage/
        │   ├── jobs.ts        ← JobsRepo
        │   ├── document-types.ts
        │   ├── files.ts       ← локальное ФС + retention
        │   ├── projects.ts / users.ts / organizations.ts / tokens.ts
        │   ├── normalize-extracted.ts ← legacy positions/services → items
        │   ├── secrets.ts     ← AES-256-GCM шифрование provider keys
        │   ├── metadata-sanitizer.ts
        │   └── audit-log.ts
        ├── webhooks/
        │   └── deliver.ts     ← HMAC-signed POST с retry
        ├── workers/
        │   ├── webhook-sweeper.ts
        │   ├── pending-job-sweeper.ts
        │   ├── file-cleanup.ts
        │   └── audit-log-sweeper.ts
        └── scripts/
            ├── migrate.ts
            ├── smoke.ts       ← локальный прогон без БД/Redis
            └── eval/          ← golden-set + accuracy
```

---

## Локальный smoke (без Docker)

Прогон одного файла через полный пайплайн без БД и очереди:

```bash
npm install
npm run smoke -- ./path/to/document.pdf
npm run smoke -- ./scan.jpg --hint TTN
```

Использует `.env`, поэтому подхватит настроенные LLM/Yandex. Результат — JSON в stdout с разбивкой по шагам (OCR-движок, классификатор, parser, validators, extracted).

Требования: tesseract + pdftoppm в PATH.

---

## Тестирование (network-test)

Систематические прогоны на удалённом сервере:

```bash
cd scripts/network-test
cp .env.example .env           # настроить URL, token, corpus path
# Положить корпус документов в corpus/

./run-smoke.sh                 # ~5 минут, проверка работоспособности
./run-load.sh                  # нагрузочный: N документов параллельно
./run-soak.sh                  # длительный: N часов с лимитом RPS
./run-stress.sh                # стрессовый: до отказа
./report.sh                    # сводный отчёт по последнему прогону
```

Регламент в `docs/TESTING_REGULATION.md`, отчёты в `docs/test-runs/`.

---

## Миграции БД

```bash
npm run migrate           # применить все pending
npm run migrate:down      # откатить последнюю
npm run migrate:create add_column_x
```

В Docker миграции применяются автоматически one-shot `migrate` сервисом перед стартом `api` и `worker`.

**15 миграций (`migrations/`)**:
```
0001_init                              — базовая схема jobs
0002_idempotency_key                   — Idempotency-Key column
0003_document_types                    — Document Type Registry
0004_provider_settings_audit           — provider_settings + audit_log
0005_extended_document_types           — +6 типов (commercial_invoice, customs_declaration, …)
0006_contracts_and_addendums           — +3 типа (contract, specification, addendum)
0007_jobs_last_llm_call                — last_llm_call для observability
0008_multi_tenant                      — organizations/projects/users/access
0009_personal_tokens_unique            — UNIQUE на token hash
0010_personal_access_tokens            — PAT + scopes
0011_reference_lists                   — Reference Lists + GIN-индекс
0012_document_types_resolution_config  — JSONB колонка resolution_config
0013_jobs_pipeline_steps               — observability per-job timeline
0014_parser_kind_multipass             — расширение CHECK constraint
0015_canonical_items_schema            — items[] 19+ полей для 6 DB-seeded типов
```

---

## Документация API

- **Swagger UI:** `https://parsedocs.taipit.ru/docs`
- **OpenAPI 3.1 spec:** `https://parsedocs.taipit.ru/docs/json` — для автогенерации клиентов (`openapi-typescript-codegen`, `oapi-codegen`, `openapi-python-client` etc.)

Auth-токен вводится через **Authorize** в правом верхнем углу Swagger UI — после этого все запросы из UI идут с `Authorization: Bearer ...`.

---

## Текущее состояние

| Аспект | Статус |
|--------|--------|
| **Production deploy** | ✓ `https://parsedocs.taipit.ru` (10.10.13.10:8085) |
| **Auth** | Временно off для тестов на локальных моделях |
| **LLM backend** | Конфигурируется через UI Providers |
| **15 типов документов** | ✓ все с актуальными схемами |
| **Resolution Engine** | ✓ UI editor + API + advisory lock |
| **Multi-tenant** | ✓ organizations/projects/users/PAT |
| **Operator UI** | ✓ self-hosted Tailwind (CDN-free) |
| **Test Lab** | ✓ admin-only с inline preview |
| **Network-test toolkit** | ✓ smoke/load/soak/stress |
| **Тесты на Resolution Engine** | ✗ пока 0 (общее покрытие 25 spec) |
| **Реальный прогон документов** | ⏳ ждёт корпуса PDF |
| **inference-service shared/ mount** | ⏳ pre-prod gap |

Следующие шаги — см. `TECH_DEBT.md` и `docs/TESTING_REGULATION.md`.
