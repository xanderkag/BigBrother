# parsedocs — doc-service

Платформа интеллектуальной обработки документов: **OCR + LLM-extraction + нормализация + привязка к справочникам**. Понимает **52 типа** транспортных, бухгалтерских, таможенных и ВЭД-документов; тянет многострочные таблицы до 1000 позиций; настраивается через UI без правок кода.

> **Принцип ТАЙПИТ (правило #5):** документы с реальными корпоративными данными обрабатываются **только на локальных моделях** (Ollama / vLLM / llama.cpp через OpenAI-совместимый inference-service на своём GPU). Облачные LLM (Claude, OpenAI, YandexGPT) — резервный режим для синтетики, отладки промптов и dev; на прод-данные не используются. Внешние сервисы (Yandex Vision, DaData) — только за явным PII-гардом.

```
Документ (PDF / JPG / PNG / TIFF / DOCX / XLSX / XML / ZIP)
   │
   ▼
[Preprocess]  EXIF-strip · разбор архивов (bomb-guard) · DOCX/XLSX→PDF · dedup по sha256
   │
   ▼
[OCR chain]   pdf-text · xlsx/docx/xml native → tesseract → vision-LLM (qwen3-vl) → yandex*
   │
   ▼
[Classify]    keyword-regex или /v1/classify (LLM) · сегментация композитов (multidoc)
   │
   ▼
[Parse]       regex (builtin) или LLM /extract (одно- / двухпроходный multipass)
   │
   ▼
[Normalize]   F0-цепочка: ПДн-allowlist · ИНН recovery/санитайз · контейнеры · totals ·
              категории · match-signals · DaData-обогащение (имя↔ИНН по ЕГРЮЛ)
   │
   ▼
[Validate]    доменные валидаторы (ИНН, КПП, НДС-разбивка, qty×price, ТН ВЭД, сверка строк)
   │
   ▼
[Deep-pass]   для нераспознанного / фото — широкая категория + честное «не документ»
   │
   ▼
[Resolve]     привязка к справочникам организации (cargo_units, nomenclature, …)
   │
   ▼
Webhook (HMAC) + UI + REST API + OpenAI-совместимый LLM-шлюз
```

> **Подробнее:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · **где что реально крутится (+ловушки)** [`docs/RUNTIME_TOPOLOGY.md`](./docs/RUNTIME_TOPOLOGY.md) · эксплуатация/очередь/инциденты [`docs/OPERATIONS_RUNBOOK.md`](./docs/OPERATIONS_RUNBOOK.md) · каталог типов [`docs/DOCUMENT_TYPES.md`](./docs/DOCUMENT_TYPES.md) · deep-pass [`docs/DEEP-PASS-SPEC.md`](./docs/DEEP-PASS-SPEC.md)

---

## TL;DR

**Что умеет:**

- **52 типа документов** (6 stable · 30 beta · 16 experimental), до 22 полей на строку, до 1000 строк в документе
- OCR-каскад с нативным разбором PDF/XLSX/DOCX/XML и vision-fallback на сканы
- **MultiPass extraction** для длинных таблиц (>30 KB OCR-текста — авторежим)
- **Normalize-стадия**: детерминированное дочищение после LLM (ИНН по контрольной сумме, восстановление сторон из текста, пересчёт сумм, канонизация полей)
- **DaData-обогащение**: сверка имя↔ИНН по ЕГРЮЛ, зануление чужого ИНН (только публичные данные юрлиц)
- **Deep-pass**: нераспознанный остаток → широкая категория; отдельная честная метка «не документ» для скриншотов/мусора; для фото — агрессивная vision-проверка типа перед извлечением
- **Per-line валидаторы**: сверка сумм, ставки НДС, единицы, ТН ВЭД, qty×price
- **152-ФЗ / ПДн**: allowlist для удостоверений, EXIF-strip, PII-гард на внешний OCR
- Resolution Engine — автопривязка к справочникам организации (`needs_review / warn / ignore`)
- Multi-tenant (organizations / projects / users / personal access tokens, роли)
- Operator UI (React + Vite + Tailwind) + Test Lab для админов
- Webhook с HMAC-подписью, sweeper авторетраев, idempotency, auto-dedup
- Audit log на админ-изменения, retention-cleanup файлов и логов

**Что внутри:**

- `doc-service` (Node 22 + Fastify 5) — API, OCR-пайплайн, BullMQ-worker
- `inference-service` (Python + FastAPI) — LLM-бэкенды (локальные Ollama / vLLM / llama.cpp через OpenAI-compat; cloud — резерв для dev)
- `ui/` — React 18 + Vite + Tailwind SPA (react-query / zustand / react-router / react-pdf)
- Postgres 16 + Redis + локальное файловое хранилище (опц. S3/MinIO)

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

В `doc-service/.env`:
```
LLM_INFERENCE_URL=http://inference:8000
```

После этого через UI настраиваются LLM-провайдеры (Providers → Активный) и парсеры начинают извлекать поля для всех типов.

### 3. Локальные модели (Ollama / vLLM / llama.cpp)

Любой OpenAI-совместимый сервер. В UI → Providers создать `kind=llm`, `base_url=http://host.docker.internal:11434/v1` (или адрес vLLM), указать `model`. Для vision-OCR — провайдер с `vision=true` (напр. `qwen3-vl:32b`); он выбирается отдельно от extraction-провайдера (`OCR_VISION_PROVIDER_ID`).

---

## Аутентификация

Все ручки `/api/v1/*` — за Bearer-токеном. `/health` и `/ready` всегда публичны.

```bash
# .env
API_KEY=$(openssl rand -hex 32)
```

```http
Authorization: Bearer <API_KEY>
```

| Тип | Кто | Что доступно |
|-----|-----|--------------|
| **API_KEY** (env) | глобальный root | `super_admin` — всё, без org-фильтра |
| **API_KEYS_JSON** | интеграторы | те же права, но с client-tag в audit-log; ротация без смены root |
| **Personal Access Token** (UI/CRUD) | конкретный user | роль и organization_id из БД |

- **Fail-closed:** если и `API_KEY`, и `API_KEYS_JSON` пусты, сервис **не стартует** — кроме явного `ALLOW_NO_AUTH=true` (dev-only: любой запрос идёт как super_admin, UI пропускает логин).
- **Секреты провайдеров** в БД шифруются envelope-схемой AES-256-GCM (`SECRETS_ENCRYPTION_KEY`, обязателен в prod).

---

## Pipeline — фазы обработки документа

```
0. Preprocess (до OCR)
   ├─ EXIF-strip с фото (GPS/автор/серийник камеры — ПДн по 152-ФЗ)
   ├─ Разбор архивов ZIP/RAR/7Z с bomb-guard (MAX_UNPACKED_BYTES)
   ├─ DOCX/XLSX → PDF через опциональный unoserver-sidecar
   └─ Auto-dedup по sha256 содержимого (опц.): повтор → тот же job_id

1. Upload (multipart) → POST /api/v1/jobs
   ├─ Magic-bytes проверка типа файла (защита от .exe в .pdf)
   ├─ Idempotency-Key из заголовка (по умолчанию SHA-256 содержимого), tenant-scoped
   └─ Создание job_id, сохранение в Postgres, постановка в BullMQ

2. Classify (worker)
   ├─ document_hint от клиента → шаг пропускается
   ├─ Иначе: keyword-классификатор (regex) или /v1/classify (LLM)
   ├─ Сегментация композитов (multidoc): PDF из нескольких документов → сегменты
   └─ Результат: один из 52 slug, либо custom-тип из БД

3. OCR chain — от быстрого к медленному, первый прошедший порог побеждает
   ├─ pdf-text / xlsx / docx / xml / html — нативное извлечение (мгновенно)
   ├─ tesseract      — локальный OCR (rus+eng), с timeout+SIGKILL на патологич. сканах
   ├─ vision-llm     — qwen3-vl (локально) для сложных макетов и картиночных docx
   └─ yandex.vision  — резерв, OFF по умолчанию, за PII-гардом (152-ФЗ)
   Для PDF pdftoppm рендерит страницы один раз и шарит между движками.

4. Parse
   ├─ builtin:invoice_regex | builtin:upd_regex — regex с LLM-fallback
   ├─ llm_extract — GenericLlmParser, один /v1/extract
   └─ llm_extract_multipass — двухпроходный для длинных таблиц:
      Pass 1: header (4KB head + 2KB tail), схема без items[]
      Pass 2: items[] батчами ~12KB, параллелизм 3, до 1000 строк
   Авторежим: llm_extract + rawText > MULTIPASS_AUTO_BYTES (30KB) → multipass.

5. Normalize (post-extract, детерминированно, идемпотентно)  ← src/pipeline/normalize/
   Упорядоченная F0-цепочка дочистки того, что LLM отдал шумно:
   ├─ id-allowlist   — для удостоверений срезаем extract до {doc_kind,country,present} (ПДн)
   ├─ ogrn-relocate  — 13/15-значный ОГРН из inn → в ogrn
   ├─ inn-recovery   — добить ИНН сторон из текста по меткам
   ├─ sanitize-inns  — канонизировать ИНН, битый по длине/контрольной сумме → null
   ├─ container-recovery / forwarding-client-recovery / place-decontaminate — доменные фиксы
   ├─ totals         — пересчёт сумм из items[], вывод канонич. header-полей
   ├─ categories     — keyword-категоризация строк
   ├─ enrich (DaData) — карточка ЕГРЮЛ по ИНН; при расхождении имя↔ЕГРЮЛ чужой ИНН зануляется
   └─ match-signals  — канонический FLAT для внешнего matcher'а

6. Validate
   ├─ Доменные валидаторы document_types.validators[]:
   │  inn_checksum / kpp_format / vehicle_plate / country_code / date_range /
   │  money_sanity / vat_consistency / parties_differ / weight_nett_le_gross
   ├─ Per-line валидаторы для items[]:
   │  items_total_sum (±0.02) · items_vat_rates ∈ {0,5,7,10,20} · items_unit_known ·
   │  items_line_consistency (qty×price) · items_hs_code_format (8/10 цифр)
   └─ Невалидные → validation_issues[]; ниже порога confidence → needs_review

7. Deep-pass (для unknown / OCR-refusal / фото)         ← src/pipeline/deep-pass/
   ├─ Широкая категория + резюме; тип-«рабочий» → возврат в конвейер
   ├─ Честная метка «не документ» для скриншотов/мусора
   ├─ Фото: vision-проверка присвоенного типа ВЫПОЛНЯЕТСЯ ВСЕГДА (кроме hint/vlm) —
   │  уверенное keyword+LLM согласие на надписях с коробки ложно (фото → cert conf=1.0)
   └─ ПДн-гейт: удостоверение → raw_text блокируется

8. Finalize
   ├─ Запись extracted, confidence, ocr_engine, pipeline_steps в БД
   ├─ Доставка webhook (HMAC-SHA256, retry с backoff)
   └─ Статус: done | needs_review | failed

9. Resolve (fire-and-forget, best-effort)
   Если у типа задан resolution_config — привязка к справочникам организации
   (entity_links + item_matching). См. «Resolution Engine».
```

---

## Каталог типов — 52 типа

Реестр в БД (`document_types`), редактируется через UI. **Авторитетный список — `GET /api/v1/document-types`** и [`docs/DOCUMENT_TYPES.md`](./docs/DOCUMENT_TYPES.md). Зрелость размечена полем `tier`: **stable** (6) — выверены на реальном потоке · **beta** (30) — рабочие, добираются на корпусе · **experimental** (16) — заведены, ждут объёма.

**Финансовые / бухгалтерские (РФ):** `invoice` (Счёт на оплату) · `factInvoice` (Счёт-фактура) · `UPD` (УПД) · `UKD` (Корректировочный УПД) · `AKT` (Акт услуг/работ) · `payment_order` (Платёжное поручение) · `cash_receipt` (Кассовый чек) · `wire_transfer_application` (Заявление на перевод, ВЭД)

**ВЭД / внешнеторговые:** `commercial_invoice` (Инвойс — ВЭД, закупка товара) · `proforma_invoice` (Проформа-инвойс) · `price_list` (Прайс-лист) · `contract_specification` (Спецификация к договору) · `certificate_register` (Реестр сертификатов)

**Договорные:** `contract` (Договор) · `contract_addendum` (Доп. соглашение)

**Транспортные / логистические:** `TTN` (Транспортная накладная, ТН) · `transport_invoice` (Товарно-транспортная, ТТН 1-Т) · `CMR` (Международная накладная) · `bill_of_lading` (Коносамент B/L) · `smgs` (Ж/д СМГС) · `cim` (Ж/д ЦИМ) · `awb` (Авианакладная) · `forwarding_order` (Поручение экспедитору) · `transport_request` (Заявка на перевозку) · `booking_request` (Заявка-бронь) · `manifest` (Грузовой манифест) · `waybill` (Путевой лист) · `empty_container_return` (Возврат порожнего контейнера) · `transport_permit` · `special_permit`

**Таможенные:** `customs_declaration` (ГТД / декларация на товары) · `export_declaration` (Экспортная декларация страны отправления) · `customs_export_ead` (Экспортная декларация ЕС, EAD) · `excise_ead` (Акцизный e-AD)

**Сертификаты / качество / безопасность:** `cert_of_origin` (Сертификат происхождения) · `eac_conformity_certificate` (Соответствия ЕАЭС) · `quality_certificate` (Паспорт качества / CoA) · `safety_data_sheet` (SDS / MSDS) · `insurance_policy` (Страховой полис) · `veterinary_certificate` · `phytosanitary_certificate` · `weighing_act` (Акт взвешивания)

**Складские (ТОРГ / М / МХ):** `transfer_note` (ТОРГ-13) · `material_requisition` (М-11) · `warehouse_receipt` (МХ-1) · `warehouse_return` (МХ-3) · `delivery_note` (Расходная накладная) · `power_of_attorney` (Доверенность М-2/М-2а)

**Прочее / служебное:** `packing_list` (Упаковочный лист) · `document_request` (Запрос документов) · `vehicle_registration` (СТС) · `driver_passport` (Паспорт водителя — ID, обрабатывается по ПДн-allowlist)

**Канонический shape строки `items[i]`:**
```
line_no, code, barcode, name, hs_code, country_of_origin,
unit, qty, qty_per_package, packages,
weight_net, weight_gross,
price, vat_rate, vat_amount, total_without_vat, total_with_vat,
currency, notes
```
Domain-поля добавляются поверх канона (напр. `packing_list`: package_type/dimensions/volume; `customs_declaration`: invoice_value/customs_value/statistical_value). Builtin-схемы — в `src/types/document-json-schemas.ts`; расширенные типы seed'ятся отдельными миграциями (рецепт добавления типа = 1 seed-миграция).

---

## Deep-pass — глубокий разбор остатка

`src/pipeline/deep-pass/` · спека [`docs/DEEP-PASS-SPEC.md`](./docs/DEEP-PASS-SPEC.md). Флаг `DEEP_PASS_ENABLED`.

Когда основной проход не опознал документ (unknown) или OCR отказал (refusal), deep-pass присваивает **широкую категорию** (документ / фото товара / удостоверение / скриншот / …), пишет резюме и — если тип оказался рабочим — возвращает job в конвейер. Отдельно вводится честная метка **«не документ»** вместо ложного натягивания типа на скриншот или фотографию коробки.

**Правило для фото (важное):** когда точно не ясно, что на картинке, сначала **агрессивно прогоняется классификатор по vision**, и только потом извлечение. Для картиночных/сканных входов vision-проверка присвоенного типа выполняется **всегда** (кроме явного hint и уже-vlm-пути): уверенное согласие keyword+LLM на тексте надписей с коробки давало ложный `cert_of_origin` с confidence 1.0. **ПДн-гейт:** если deep-pass распознал удостоверение — `raw_text` жёстко блокируется, персональные поля не доходят до БД/webhook.

---

## 152-ФЗ / персональные данные

- **Удостоверения** (`driver_passport` и любой `doc_kind=id`) — extract срезается до allowlist `{doc_kind, country, present}` первым же шагом normalize; `raw_text` страницы блокируется. ФИО/номер/даты рождения наружу не идут.
- **EXIF-strip** фото при загрузке (GPS/автор/серийник камеры — ПДн).
- **Yandex Vision** — внешний OCR, по умолчанию OFF; при включении per-job `metadata._disable_external_ocr=true` и глобальный `YANDEX_DISABLE_FOR_PII` держат документы с ПДн (ТТН/CMR с данными водителя) на локальных движках.
- **DaData** — наружу уходит **только ИНН юрлица** (публичные данные ЕГРЮЛ, не ПДн); изображения и содержимое документа не передаются.
- **Cloud LLM** на прод-данные не используются (правило #5) — только локальный inference.

---

## API — основные группы

### Jobs
```http
POST   /api/v1/jobs                          загрузить документ
GET    /api/v1/jobs                          список с фильтрами
GET    /api/v1/jobs/:id                      статус и результат
PATCH  /api/v1/jobs/:id/extracted            скорректировать данные
POST   /api/v1/jobs/:id/approve              needs_review → done
POST   /api/v1/jobs/:id/reprocess            перепрогон без повторного OCR
POST   /api/v1/jobs/:id/redeliver-webhook    принудительная доставка (?force=true)
GET    /api/v1/jobs/:id/file                 скачать оригинал
GET    /api/v1/jobs/:id/resolution           результаты привязки
POST   /api/v1/jobs/:id/re-resolve           перезапуск резолюции
```

**Поля загрузки** (`multipart/form-data`): `file` (PDF/JPG/PNG/BMP/TIFF/DOCX/XLSX/XML/ZIP, до 50 MB) · `document_hint` (slug — пропускает классификатор) · `webhook_url` (HMAC-signed POST) · `metadata` (JSON, echo обратно) · `project_id` (multi-tenant изоляция).

**Статусы:** `pending` → `processing` → `done` | `needs_review` | `failed`

### Document Types, Reference Lists, Resolution, Multi-tenant
```http
GET/POST/PATCH/DELETE  /api/v1/document-types[/:slug]      реестр типов + history/stats/jobs
GET/POST/PATCH/DELETE  /api/v1/reference-list-types[...]   справочники + /entries + /sync (push от WMS/ERP)
GET/POST                /api/v1/jobs/:id/resolution         привязка + confirm/reject
GET/POST/PATCH/DELETE  /api/v1/organizations|projects|users  multi-tenant + /users/:id/tokens (PAT)
```
Конфигурируемые через UI поля типа: `parser_kind`, `llm_prompt`, `llm_schema`, `expected_fields`, `validators`, `confidence_threshold`, `regex_fallback_threshold`, `classification_keywords`, `resolution_config`, `tier`, `prefer_vision`.

**Роли:** `super_admin` · `org_admin` · `manager` · `viewer`.

### LLM-шлюз (опциональный)
При `LLM_GATEWAY_ENABLED=true` doc-service публикует OpenAI-совместимые `/v1/chat/completions` и `/v1/models` для внешних клиентов (аутентифицированный passthrough **прямо на локальный GPU**, с серверной подменой `model` по карте алиасов). Облачные бэкенды не задействованы. Фича-флаг fail-closed.

---

## Webhook

Каждая доставка подписывается HMAC-SHA256:
```http
X-DocService-Signature: sha256=<hex>
X-DocService-Job-Id:    <uuid>
X-DocService-Attempt:   <n>
```
Ретраи — экспоненциальный backoff до `WEBHOOK_MAX_ATTEMPTS`. **Sweeper** добивает неудачи в фоне; `webhook_attempts` копится до hard-limit 15 (3 волны × 5). Принудительный повтор уже доставленного — `POST /jobs/:id/redeliver-webhook?force=true` (иначе 409).

---

## Resolution Engine — привязка к справочникам

Конфиг в `document_types.resolution_config` (JSONB, UI-editor):
```json
{
  "entity_links": [
    { "list_type": "cargo_units",  "match_fields": ["cargo_id","cargo_number"], "on_not_found": "needs_review" },
    { "list_type": "contractors",  "match_fields": ["seller_inn"],               "on_not_found": "warn" }
  ],
  "item_matching": { "list_type": "nomenclature", "items_field": "items", "code_field": "code", "name_field": "name", "on_not_found": "warn" }
}
```
`on_not_found`: `needs_review` (job → needs_review + причина в `extracted._issues[]`) · `warn` (лог) · `ignore`. Справочники наполняются push-синхронизацией `POST /reference-list-types/:slug/sync` (upsert по `external_id` + soft-delete отсутствующих, транзакционно; GIN-индекс на `search_keys[]`).

---

## UI — React SPA

`ui/` — React 18 + Vite + Tailwind (react-query / zustand / react-router / react-pdf). Сборка `npm --prefix ui run build` → статика раздаётся Fastify по `/ui/`.

- **Upload** (бизнес-пользователь): dropzone + выбор типа с превью полей; очередь файлов со статусом и сводкой (тип, confidence, ocr_engine, замечания); настройки разработчика (webhook/metadata) под `<details>`.
- **Test Lab** (админ, gated): engine-chain badges, LLM-провайдер picker (per-job override), inline preview (pipeline timeline + extracted JSON + items table) без перехода в job detail.
- **Job detail**: PDF-превью (react-pdf), items-таблица с поиском/сортировкой/пагинацией/CSV-экспортом (UTF-8 BOM для Excel), карточка deep-pass, этапы обработки.

---

## Конфигурация

Полный, подробно закомментированный шаблон — **`.env.example`** (авторитетный источник). Ключевые группы:

| Группа | Важные переменные (default) |
|--------|------------------------------|
| **Базовое** | `PORT`(3000) · `MAX_UPLOAD_MB`(50) · `MAX_METADATA_BYTES`(65536) · `LOG_LEVEL`(info) |
| **Соединения** | `DATABASE_URL` · `REDIS_URL` · `STORAGE_DIR`(/app/data) |
| **Storage** | `STORAGE_BACKEND`(local\|s3) · `S3_BUCKET`/`S3_ENDPOINT`/… (для MinIO/AWS) |
| **Auth** | `API_KEY` · `API_KEYS_JSON` · `ALLOW_NO_AUTH`(fail-closed) · `SECRETS_ENCRYPTION_KEY` |
| **Worker** | `WORKER_CONCURRENCY`(1) · `JOB_MAX_AGE_SECONDS`(14400) · `RATE_LIMIT_PER_MINUTE`(200) |
| **OCR пороги** | `PDF_TEXT_ACCEPT_THRESHOLD`(0.9) · `TESSERACT_ACCEPT_THRESHOLD`(0.75) · `VISION_LLM_ACCEPT_THRESHOLD`(0.75) · `NEEDS_REVIEW_THRESHOLD`(0.6) · `LLM_FALLBACK_THRESHOLD`(0.7) |
| **Tesseract** | `TESSERACT_LANGS`(rus+eng) · `TESSERACT_TIMEOUT_MS`(90000) · `TESSERACT_MAX_PAGES`(0) |
| **MultiPass** | `MULTIPASS_AUTO_BYTES`(30000) · `MULTIPASS_*_BYTES` · `MULTIPASS_ITEMS_PARALLELISM`(3) |
| **LLM** | `LLM_INFERENCE_URL` · `LLM_TIMEOUT_MS`(60000) · `OCR_VISION_PROVIDER_ID` · `VISION_PAGE_PARALLELISM`(1) |
| **LLM-шлюз** | `LLM_GATEWAY_ENABLED`(false) · `LLM_GATEWAY_BASE_URL` · `LLM_GATEWAY_MODELS_JSON` |
| **Deep-pass** | `DEEP_PASS_ENABLED`(false) · `DEEP_PASS_TEXT_CHARS`(8000) · `DEEP_PASS_MIN_TEXT`(300) |
| **Office fallback** | `OFFICE_IMAGE_FALLBACK_ENABLED`(true) · `ENABLE_DOCX_SIDECAR`(false) · `UNOSERVER_URL` |
| **DaData** | `DADATA_API_KEY` · `DADATA_TIMEOUT_MS`(10000) · `DADATA_CACHE_TTL_MS`(24h) |
| **Yandex OCR** | `YANDEX_VISION_API_KEY` · `YANDEX_FOLDER_ID` · `YANDEX_DISABLE_FOR_PII`(false) · `YANDEX_PREFER_FOR_SCANS`(false) |
| **Webhook** | `WEBHOOK_HMAC_SECRET` · `WEBHOOK_MAX_ATTEMPTS`(5) · `WEBHOOK_SWEEPER_*` |
| **152-ФЗ / preprocess** | `STRIP_EXIF_ON_UPLOAD`(true) · `MAX_UNPACKED_BYTES`(500MB) · `AUTO_DEDUP_BY_HASH`(false) |
| **Sweepers / retention** | `PENDING_SWEEPER_*` · `FILE_RETENTION_DAYS`(30) · `AUDIT_LOG_RETENTION_DAYS`(365) |

---

## Структура проекта

```
doc-service/
├── README.md · ARCHITECTURE.md
├── docker-compose.yml        ← api + worker + migrate + postgres + redis
├── Dockerfile                ← node:22-slim + tesseract + poppler
├── package.json · tsconfig.json · vitest.config.ts
├── .env.example              ← авторитетный шаблон конфигурации
├── migrations/               ← 93 миграции (timestamp-имена, см. ниже)
├── tests/                    ← 122 vitest spec-файла
├── docs/                     ← спеки (DEEP-PASS, DOCUMENT_TYPES, PARSING_SPEC, …) + archive/
├── ui/                       ← React 18 + Vite + Tailwind SPA
│   └── src/                  ← компоненты, роуты, api-клиент, store (zustand)
└── src/
    ├── server.ts             ← Fastify entry + плагины
    ├── worker.ts             ← BullMQ worker + sweeper-процессы
    ├── config.ts             ← все env через Zod
    ├── db.ts · queue.ts · metrics.ts
    ├── routes/               ← jobs · document-types · reference-lists · resolution ·
    │                            tenants · provider-settings · audit-log · settings ·
    │                            llm-gateway · gateway-admin · integrations/slai-sync · health
    ├── security/             ← auth (Bearer + req.user) · authz-guards · tenant-scope
    ├── pipeline/
    │   ├── orchestrator.ts   ← OCR chain → classify → parse → normalize → validate → deep-pass → resolve
    │   ├── preprocess/       ← EXIF-strip · разбор архивов · docx/xlsx-sidecar · dedup
    │   ├── ingest/           ← приём файла, magic-bytes, роутинг форматов
    │   ├── classifier/       ← keyword + LLM + VLM-classify + spec-invoice-correction
    │   ├── multidoc/         ← сегментация композитов (boundaries + splitter)
    │   ├── ocr/              ← pdf-text · tesseract · vision-llm · yandex · xlsx/docx/xml/html · refusal
    │   ├── parsers/          ← invoice/upd/ttn/cmr/akt regex + generic-llm + multipass-llm
    │   ├── normalize/        ← F0-цепочка (id-allowlist, inn-recovery/sanitize, totals, …)
    │   ├── enrich/           ← DaData (имя↔ИНН по ЕГРЮЛ)
    │   ├── validation/       ← доменные + per-line валидаторы
    │   ├── deep-pass/        ← широкая категория + «не документ» + vision-verify
    │   ├── llm/              ← клиент к inference-service
    │   ├── asr/ · preview/   ← распознавание речи (вход) · превью xlsx и т.п.
    │   └── quality*.ts · document-type-resolver.ts (TTL-кэш)
    ├── resolution/           ← ResolutionConfig + репозитории справочников + pipeline (advisory lock)
    ├── storage/              ← jobs · document-types · files (retention) · tenants · secrets (AES-GCM) · audit-log
    ├── webhooks/             ← HMAC-signed доставка с retry
    ├── workers/              ← webhook-sweeper · pending-job-sweeper · file-cleanup · audit-log-sweeper
    └── scripts/              ← migrate · smoke (без БД/Redis) · eval (golden-set + accuracy)
```

---

## Локальный smoke (без Docker)

Прогон одного файла через полный пайплайн без БД и очереди:
```bash
npm install
npm run smoke -- ./path/to/document.pdf
npm run smoke -- ./scan.jpg --hint TTN
```
Использует `.env` (подхватит LLM/Yandex). Результат — JSON в stdout с разбивкой по шагам. Требования: tesseract + pdftoppm в PATH.

---

## Тесты и eval

```bash
npm test              # vitest run — 122 spec-файла
npm run test:watch
npm run eval          # прогон корпуса → accuracy
npm run eval:golden   # golden-set сверка
```

---

## Миграции БД

```bash
npm run migrate           # применить все pending
npm run migrate:down      # откатить последнюю
npm run migrate:create add_column_x
```
В Docker применяются автоматически one-shot `migrate`-сервисом перед стартом `api`/`worker`.

**93 миграции**, имена — по timestamp'у (`YYYYMMDDHHmmssN_<name>.sql`), от `20260506000001_init` до `20260717000003_display_name_cleanup`. Каждый расширенный тип и правка каталога — отдельная seed-миграция (напр. `..._forwarding_order_type`, `..._display_name_cleanup`), что даёт полную историю изменений реестра типов в git.

---

## Документация API

- **Swagger UI:** `https://parsedocs.taipit.ru/docs`
- **OpenAPI 3.1:** `https://parsedocs.taipit.ru/docs/json` — для автогенерации клиентов.

Токен вводится через **Authorize** в Swagger UI.

---

## Текущее состояние

| Аспект | Статус |
|--------|--------|
| **Production** | ✓ `https://parsedocs.taipit.ru` (10.10.13.10:8085) |
| **Каталог типов** | ✓ 52 (6 stable · 30 beta · 16 experimental) |
| **LLM backend** | ✓ локальный inference (qwen3-vl vision + text) через UI Providers |
| **Normalize + DaData enrichment** | ✓ в проде (ИНН-санитайз + сверка имя↔ЕГРЮЛ) |
| **Deep-pass** | ✓ широкая категория + «не документ» + vision-verify фото |
| **152-ФЗ / ПДн** | ✓ allowlist удостоверений · EXIF-strip · PII-гард внешнего OCR |
| **Resolution Engine** | ✓ UI editor + API + advisory lock |
| **Multi-tenant** | ✓ organizations/projects/users/PAT, роли |
| **Operator UI** | ✓ React + Vite SPA |
| **Тесты** | ✓ 122 spec-файла |
| **LLM-шлюз** | ⏳ за фича-флагом, локальный passthrough |

Технический долг и ближайшие шаги — в `docs/` и `ARCHITECTURE.md`.
