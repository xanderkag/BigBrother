# parsdocs — сервис разбора документов (Big Brother / Doc Parser)

Принимает файл (PDF, скан, фото, Office, XML, аудио), определяет тип документа,
извлекает структурированный JSON и отдаёт его дальше — в общий пайплайн / SLS.

> **Источник истины — код и миграции этого репозитория.** Всё ниже извлечено из них,
> для каждого блока указан файл. Имена типов, полей и версии контракта не обобщались.

---

## Оглавление

1. [Быстрый старт](#1-быстрый-старт)
2. [Архитектура парсинга](#2-архитектура-парсинга)
3. [Каталог документов](#3-каталог-документов)
4. [Структуры выходного JSON](#4-структуры-выходного-json)
5. [Интеграция / контракт](#5-интеграция--контракт)
6. [Для разработчиков](#6-для-разработчиков)
7. [Статус / Changelog](#7-статус--changelog)

---

## 1. Быстрый старт

```bash
cd doc-service
npm install
cp .env.example .env          # заполнить DATABASE_URL, REDIS_URL, API_KEY, SECRETS_ENCRYPTION_KEY
npm run migrate               # применить миграции
npm run dev:api               # API   (Fastify) — порт 3000
npm run dev:worker            # worker (BullMQ) — очередь doc-jobs
```

Отправить документ:

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@invoice.pdf" \
  -F 'metadata={"order_hint":"ORDER-42"}'
# → {"job_id":"...","status":"pending"}

curl http://localhost:3000/api/v1/jobs/<job_id> -H "Authorization: Bearer $API_KEY"
```

Нужен **Node.js 22**, Postgres 16, Redis 7. Подробнее — [раздел 6](#6-для-разработчиков).

---

## 2. Архитектура парсинга

### 2.1 Путь файла до JSON

```
POST /api/v1/jobs                 routes/jobs.ts
  ├─ auth (Bearer), tenant-scope, проверка доступа к проекту
  ├─ дедуп по SHA-256 содержимого (обход: metadata._skip_cache = true)
  └─ файл в STORAGE_DIR, job в БД (status=pending)
        ↓  очередь BullMQ «doc-jobs» (queue.ts, worker.ts)
PIPELINE                           pipeline/orchestrator.ts
  1. preprocess     pipeline/preprocess/   HEIC→JPEG, определение MIME
  2. OCR-каскад     pipeline/ocr/          движки по очереди, до первого успеха
  3. классификация  pipeline/classifier/   keyword → LLM-каталог → VLM по картинке
  4. сегментация    pipeline/multidoc/     составной скан → массив документов
  5. extract        pipeline/parsers/      схема типа + промпт → LLM → JSON
  6. нормализация   pipeline/normalize/    детерминированные правки поверх JSON
  7. deep-pass      pipeline/deep-pass/    второй ярус для неопознанного остатка
  8. валидация      pipeline/validation/   checksum ИНН, суммы, даты → needs_review
  9. финализация    стоимость, запись в БД, вебхук
        ↓
POST <webhook_url>                webhooks/deliver.ts   (payload — раздел 5)
```

### 2.2 OCR-каскад

Движки (`src/types/documents.ts:36`):

```
pdf-text · tesseract · vision-llm · yandex · xlsx · docx · doc · xml · transcribe
```

Идут последовательно, до первого удачного; при падении или таймауте движка каскад
переключается на следующий. У tesseract жёсткий таймаут с `SIGKILL`
(`TESSERACT_TIMEOUT_MS`, дефолт 90000), чтобы зависшая страница не держала слот воркера.

### 2.3 Классификация

| Слой | Где | Когда |
|---|---|---|
| keyword + веса | `pipeline/classifier/keywords.ts`, `classification_keywords` в БД | всегда |
| LLM по каталогу | `pipeline/classifier/catalog.ts` | когда keyword не уверен |
| VLM по изображению | `pipeline/classifier/vlm-classify.ts` | флаг `VLM_CLASSIFY`, слабая **не первая** страница |
| hard-boundary | `pipeline/multidoc/boundaries.ts` | маркеры начала нового документа внутри стопки |

### 2.4 Сегментация составных сканов

Один файл может быть стопкой из нескольких документов. `pipeline/multidoc/runner.ts`
классифицирует постранично, `splitter.ts` собирает страницы в сегменты, и каждый
сегмент извлекается **отдельно** (`extractSegment` → `runDocumentPipeline` с hint).
Результат — массив `documents[]` в payload (раздел 5).

### 2.5 Выбор парсера

`pipeline/parsers/index.ts` (`ParsersFactory.get`) + диспетчер в
`pipeline/orchestrator.ts:1633`:

| `parser_kind` в БД | Парсер |
|---|---|
| `builtin:invoice_regex`, `builtin:upd_regex` | типизированный regex + LLM-fallback |
| `llm_extract` | `GenericLlmParser` — схема из `llm_schema` / кода |
| `llm_extract_multipass` **или** текст > `MULTIPASS_AUTO_THRESHOLD` | `MultiPassLlmParser` (шапка + позиции батчами) |

Слаг канонизируется перед выбором builtin-парсера
(`types/slug-normalize.ts` → `canonicalizeSlugForBuiltins`): каталог отдаёт и
историческую форму (`CMR`), и outbound (`cmr`) — обе должны попасть в один парсер
и получить одну схему.

### 2.6 Нормализация (порядок жёсткий)

`pipeline/normalize/run.ts` — шаги детерминированные и идемпотентные:

| Шаг | Функция | Что делает |
|---|---|---|
| F0-ПДн | `applyIdAllowlist` | документ-удостоверение → срез до `{doc_kind, country, present}` |
| F0a | `relocateOgrnFromInn` | 13/15 цифр в `inn` → перенос в `ogrn` |
| F0 | `recoverPartyInnsFromText` | добить ИНН стороны из OCR-текста по метке |
| F0c | `recoverContainersFromText` | добить номер контейнера (ISO 6346) |
| F0d | `recoverForwardingClientFromText` | добить заказчика поручения экспедитору |
| F0d2 | `sanitizeForwardingLeg` | `leg` не из enum → `null` |
| F0e | `sanitizePartyInns` | выкинуть ИНН, битые по длине / контрольной сумме |
| F1 | `normalizeExtractedFields` | ИНН и госномер → канонический вид |
| F0f | `decontaminatePlaceFields` | вырезать имя стороны из места погрузки / разгрузки |
| F7, F7b | `recomputeTotalsFromItems`, `deriveHeaderTotals` | пересчёт и вывод итогов |
| F6 | `applyCategoryHints` | категория позиции по keyword-мапперу |
| F13 | `enrichItemsWithSlaiCategoryIds` | `_slai_category_id` из справочника |
| — | `buildMatchSignals` | плоский `_match_signals` для матчера (последним) |

### 2.7 Deep-pass — второй ярус

Если рабочий классификатор тип не опознал (или OCR отказался распознавать — например
скриншот переписки), включается `pipeline/deep-pass/` (гейт `DEEP_PASS_ENABLED`):
документ получает **широкую категорию** из фиксированного словаря 18 значений
(`deep-pass/broad-catalog.ts`), резюме и вердикт. Если модель узнала рабочий тип —
документ возвращается в конвейер с hint.

```
contract · certificate · invoice_like · transport_doc · customs_doc · bank_doc ·
letter · correspondence_screenshot · id_document · tech_doc · drawing ·
product_photo · cargo_photo · price_list · report_table · form_application ·
not_a_document · other
```

---

## 3. Каталог документов

**52 типа**: 6 встроенных (`src/types/documents.ts:19`) + 46 каталожных
(создаются миграциями). Slug — канонический идентификатор в API и контракте.

### 3.1 Встроенные типы

`DOCUMENT_TYPES = ['invoice', 'factInvoice', 'UPD', 'TTN', 'CMR', 'AKT']` —
исторические слаги; в outbound переводятся в snake_case
(`types/slug-normalize.ts`: `TTN→ttn`, `UPD→upd`, `UKD→ukd`, `CMR→cmr`,
`AKT→services_act`, `factInvoice→tax_invoice`).

| Slug | Название | Извлекаемые поля (`expected_fields`) |
|---|---|---|
| `invoice` | Счёт на оплату (внутренний РФ) | number, date, seller, buyer, total |
| `factInvoice` | Счёт-фактура | number, date, seller, buyer, total, vat |
| `UPD` | УПД | number, date, seller, buyer, total |
| `TTN` | Транспортная накладная (ТН, РФ) | number, date, shipper, consignee, cargo, vehicle |
| `CMR` | CMR (Международная накладная) | number, date, sender, recipient, carrier |
| `AKT` | Акт оказанных услуг / выполненных работ | number, date, party_a, party_b, total |

### 3.2 Каталожные типы

| Slug | Название | Извлекаемые поля |
|---|---|---|
| `awb` | Авианакладная (Air Waybill) | awb_number, date, airline, shipper, consignee, airport_of_departure, airport_of_destination, gross_weight_kg |
| `bill_of_lading` | Коносамент (B/L) | bl_number, date, shipper.name, consignee.name, port_of_loading, port_of_discharge |
| `booking_request` | Заявка-бронь на перевозку | number, date, requestor, carrier, route, cargo |
| `cash_receipt` | Кассовый чек | merchant.name, merchant.inn, date_time, total, fn_number |
| `cert_of_origin` | Сертификат происхождения | number, issue_date, form_type, exporter.*, consignee.* |
| `certificate_register` | Реестр сертификатов (приложение) | invoice_ref, items |
| `cim` | Ж/д накладная ЦИМ (CIM) | number, date, consignor, consignee, station_of_dispatch, station_of_destination, cargo |
| `commercial_invoice` | Инвойс (ВЭД, закупка товара) | number, date, exporter.name, consignee.name, currency, total_amount |
| `contract` | Договор | number, date, party_a.inn, party_b.inn, subject, total_amount |
| `contract_addendum` | Дополнительное соглашение | number, date, parent_contract_number, parent_contract_date, party_a.inn, party_b.inn |
| `contract_specification` | Спецификация / Приложение к договору | number, date, parent_contract_number, parent_contract_date, positions, total_amount |
| `customs_declaration` | Таможенная декларация (ГТД) | declaration_number, date, declarant.inn, declaration_type, positions |
| `customs_export_ead` | Экспортная декларация ЕС (EAD) | mrn, issue_date, consignor, consignee, country_dispatch, country_destination, gross_mass, items |
| `delivery_note` | Расходная накладная (Delivery Note) | number, date, supplier, consignee, items |
| `document_request` | Запрос документов | requested_documents, order_ref, requester |
| `driver_passport` | Паспорт водителя (ID) | doc_kind, country, present |
| `eac_conformity_certificate` | Сертификат соответствия ЕАЭС | number, issue_date, expiry_date, manufacturer.* |
| `empty_container_return` | Инструкция по возврату порожнего контейнера | container_numbers, return_terminal, return_deadline, shipping_line |
| `excise_ead` | Акцизный e-AD | arc, sender_excise_id, consignee, items |
| `export_declaration` | Экспортная декларация страны отправления | declaration_number, declaration_date, exporter, consignee, items |
| `forwarding_order` | Поручение экспедитору | number, date, client, expeditor, shipper, consignee, leg, route, cargo, rate |
| `insurance_policy` | Страховой полис (страхование груза) | policy_number, issue_date, insurer, insured, sum_insured, premium, cargo |
| `manifest` | Грузовой манифест (cargo manifest) | number, date, carrier, items |
| `material_requisition` | Требование-накладная (М-11) | number, date, sender, receiver, positions, warehouse |
| `packing_list` | Упаковочный лист (Packing List) | number, date, total_packages, total_weight_gross, total_weight_net |
| `payment_order` | Платёжное поручение | number, date, amount, payer.inn, payer.account, payee.inn, payee.account, purpose |
| `phytosanitary_certificate` | Фитосанитарный сертификат | number, date, exporter, consignee, country_of_origin, product_description |
| `power_of_attorney` | Доверенность (М-2 / М-2а) | number, date, principal, representative, valid_until, authority |
| `price_list` | Прайс-лист | number, date, supplier.name, supplier.country, currency, valid_from, valid_to, items |
| `proforma_invoice` | Проформа-инвойс (ВЭД) | number, date, seller.*, buyer.* |
| `quality_certificate` | Сертификат / паспорт качества | certificate_number, product_name, manufacturer, batch_number, parameters |
| `safety_data_sheet` | Паспорт безопасности (SDS / MSDS) | product_name, manufacturer, cas_number, hazard_class, sections |
| `smgs` | Ж/д накладная СМГС | number, date, consignor, consignee, station_of_dispatch, station_of_destination, wagon_number, cargo |
| `special_permit` | Спецразрешение на перевозку | number, date, valid_until, issued_by, carrier, vehicle, route, dimensions |
| `transfer_note` | Перемещение товаров (ТОРГ-13) | number, date, organization_name, organization_inn, source_warehouse, target_warehouse, responsible |
| `transport_invoice` | Товарно-транспортная накладная (ТТН, 1-Т) | number, date, shipper, consignee, carrier, vehicle, driver, loading_point, unloading_point, cargo_* |
| `transport_permit` | Дозвол / разовое разрешение | number, issued_by, valid_from, valid_to, truck_plate |
| `transport_request` | Заявка на перевозку | number, date, client, carrier, route, cargo, rate |
| `UKD` | Корректировочный УПД (УКД) | number, date, status, base_doc_number, base_doc_date, seller_name, seller_inn, buyer_name, buyer_inn |
| `vehicle_registration` | Свидетельство о регистрации ТС | reg_number, vin, make, category, holder |
| `veterinary_certificate` | Ветеринарный сертификат | number, date, exporter, consignee, country_of_origin, product |
| `warehouse_receipt` | Акт о приёме-передаче ТМЦ на хранение | number, date, depositor, custodian, positions, total |
| `warehouse_return` | Акт о возврате ТМЦ с хранения | number, date, depositor, custodian, positions |
| `waybill` | Путевой лист | number, date, organization, vehicle, driver, route, odometer_start |
| `weighing_act` | Акт взвешивания | number, date, container.number, weight.gross_kg, weight.tare_kg, weight.net_kg, weight.declared_* |
| `wire_transfer_application` | Заявление на перевод (ВЭД) | number, date, currency, amount, amount_words, sender.*, beneficiary.* |

> Поля в таблице — это `expected_fields` (что сервис ожидает и по чему считает
> полноту). Полный список свойств у типа шире и лежит в его `llm_schema` —
> см. [4.3](#43-где-лежит-схема-конкретного-типа).
>
> Запись `exporter.*` означает группу вложенных полей; точный состав — в `llm_schema`
> соответствующей миграции.

### 3.3 Статусы и служебные значения

- `JOB_STATUSES` (`types/documents.ts:33`): `pending`, `processing`, `done`, `failed`, `needs_review`.
- Тип не опознан → в БД `document_type = null` + `classification.unknown = true`;
  в вебхуке — строка `"unknown"` (`webhooks/deliver.ts:44-52`).
- `tier` типа: `stable` / `beta` / `experimental` (колонка `document_types.tier`).

---

## 4. Структуры выходного JSON

### 4.1 Два уровня

1. **`extracted`** — бизнес-поля документа; форма задаётся схемой типа.
2. **Служебные `_`-неймспейсы** внутри `extracted` — их добавляет пайплайн, они не
   приходят от модели.

| Ключ | Кто пишет | Смысл |
|---|---|---|
| `_match_signals` | `normalize/match-signals.ts` | плоские сигналы для матчинга, `schema_version: "1.2"` |
| `_field_confidence` | `normalize/field-confidence.ts` | уверенность по каждому полю, 0..1 (выносится в top-level payload) |
| `_multidoc_documents` | `multidoc/` | сегменты составного файла (выносятся в `documents[]`, из `extracted` убираются) |
| `_deep` | `deep-pass/run.ts` | результат второго яруса: broad_type, summary, verdict, language |
| `_issues` | нормализаторы | замечания разбора |
| `_normalized_fields` | `normalize/extracted-fields.ts` | какие поля канонизированы |
| `_inn_recovered` | `normalize/inn-recovery.ts` | ИНН добит из текста, а не распознан моделью |
| `_inn_dropped` | `normalize/sanitize-inns.ts` | ИНН отброшен как битый |
| `_place_decontaminated` | `normalize/place-decontaminate.ts` | из места вырезано имя стороны |
| `_slai_category_id` | `normalize/slai-enrichment.ts` | id категории номенклатуры (внутри позиций) |

### 4.2 Пример — реальный вывод (CMR)

Ответ `GET /api/v1/jobs/:id`, сокращён до значимых полей:

```json
{
  "job_id": "ced615a2-e383-4022-b31c-5b783e159832",
  "status": "done",
  "document_type": "cmr",
  "confidence": 0.802,
  "ocr_engine": "yandex",
  "cost_rub": 3.2,
  "extracted": {
    "place_of_loading": "LDC ALCA ZAGREB KELEKOVA 10000 ZAGREB HR",
    "place_of_delivery": "ALMATY 050011",
    "delivery_place": "ALMATY 050011",
    "border_crossing": "EU:LTVK2000",
    "consignee": {
      "name": "LLP MONDELEZ KAZAKHSTAN",
      "address": "101 TOLE BI STR, 050012 ALMATY",
      "country": "KZ"
    },
    "_place_decontaminated": {
      "place_of_delivery": "ALMATY 050011",
      "delivery_place": "ALMATY 050011"
    }
  }
}
```

Здесь видна работа шага F0f: модель вернула место доставки вместе с названием
компании, нормализатор вырезал имя и оставил топоним, а `consignee.name` не тронул.

### 4.3 Где лежит схема конкретного типа

Разрешение схемы — `pipeline/document-type-resolver.ts` (`resolveConfigFromRow`),
приоритет сверху вниз:

1. `document_types.llm_schema` в БД (задаётся миграцией типа) — **основной путь для
   каталожных типов**;
2. `DOCUMENT_JSON_SCHEMAS[slug]` — `src/types/document-json-schemas.ts`, для шести
   встроенных;
3. `EXTENDED_SCHEMAS[slug]` — там же, для `waybill`, `transport_invoice`,
   `transport_request`, `bill_of_lading`;
4. `{}` — если ничего не нашлось (модель получает пустую схему; это деградация).

> Слаг канонизируется **перед** лукапом (`canonicalizeSlugForBuiltins`), иначе `cmr`
> не нашёл бы схему, лежащую под ключом `CMR`.

Посмотреть полную схему типа:

```bash
# схема в коде
grep -n "CMR_SCHEMA" doc-service/src/types/document-json-schemas.ts

# миграция, заводившая тип
grep -l "'commercial_invoice'" doc-service/migrations/*.sql

# схема в живой БД
psql -c "select jsonb_pretty(llm_schema) from document_types where slug='commercial_invoice'"
```

### 4.4 Особые случаи, заложенные в коде

| Случай | Поведение | Где |
|---|---|---|
| Документ-удостоверение | `extracted` срезается до `{doc_kind, country, present}`, персональные поля не извлекаются | `normalize/id-allowlist.ts` |
| Составной файл | `documents[]` + `is_composite: true` + `dominant_index` | `webhooks/deliver.ts:93-100` |
| Тип не опознан | `document_type: "unknown"` в вебхуке (в БД — `null`) | `webhooks/deliver.ts:44` |
| Двойной документ на странице | `secondary_role` у сегмента | `webhooks/deliver.ts:90` |
| Длинный документ | multipass: шапка отдельно, позиции батчами | `parsers/multipass-llm.ts` |
| Повторная загрузка того же файла | отдаётся закэшированный job (обход — `metadata._skip_cache: true`) | `routes/jobs.ts` |

---

## 5. Интеграция / контракт

### 5.1 Исходящий вебхук

`POST <webhook_url>`, тело — тип `WebhookPayload` (`src/webhooks/deliver.ts:26-109`).
Подпись — HMAC-заголовок, секрет `WEBHOOK_HMAC_SECRET`.

- `version` — версия конверта, сейчас всегда `"v1"`;
- `schema_version` — drift-маркер набора полей `extracted`, сейчас **`"1.4"`**
  (`WEBHOOK_SCHEMA_VERSION`, `deliver.ts:24`); минорный бамп при изменении набора полей.

```json
{
  "version": "v1",
  "schema_version": "1.4",
  "job_id": "uuid",
  "status": "done",
  "document_type": "commercial_invoice",
  "confidence": 0.93,
  "ocr_engine": "yandex",
  "file_sha256": "9f2b…64hex",
  "extracted": { "…": "бизнес-поля типа" },
  "metadata": { "order_hint": "ORDER-42" },
  "error": null,
  "_field_confidence": { "seller.inn": 0.99, "total": 0.87 },
  "target_entity_hint": "Transportation"
}
```

Составной файл добавляет:

```json
{
  "is_composite": true,
  "dominant_index": 0,
  "documents": [
    {
      "segment_id": "<job_id>#0",
      "page_range": "1-3",
      "document_type": "commercial_invoice",
      "confidence": 0.93,
      "status": "done",
      "needs_review": false,
      "order_hint": "ORDER-42",
      "secondary_role": null,
      "extracted": { "…": "…" },
      "field_confidence": { "…": 0.9 }
    }
  ]
}
```

Поля `documents[]` аддитивные, введены для дедупа и по-сегментного ревью на стороне
потребителя: `segment_id` стабилен (`job_id#index`), `needs_review` считается
per-segment (спорный сегмент не тормозит весь файл), `order_hint` эхо-возвращается на
каждый сегмент.

### 5.2 Приватность в контракте

- `metadata.redact_pii = true` → `extracted` и `metadata` (и каждый сегмент в
  `documents[]`) уходят в редактированном виде (`redactPii`).
- Документы-удостоверения не отдают персональные поля **никогда** — гейт стоит до
  вебхука, на этапе нормализации.
- `webhook_url` проверяется на SSRF при приёме и при доставке
  (`webhooks/ssrf-guard.ts`): loopback / link-local / metadata-адреса блокируются
  (`WEBHOOK_SSRF_CHECK`, дефолт включён). RFC1918 по умолчанию разрешён — приёмник
  может стоять во внутренней сети; строгий режим — `WEBHOOK_BLOCK_ALL_PRIVATE`.

### 5.3 HTTP API

Префикс `/api/v1` (`src/server.ts:322`). Авторизация — `Authorization: Bearer <ключ>`.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/jobs` | загрузить документ (multipart `file` + `metadata`) |
| GET | `/jobs` | список задач |
| GET | `/jobs/:id` | статус и результат |
| GET | `/jobs/:id/raw-text` | распознанный текст |
| GET | `/jobs/:id/file` | исходный файл |
| GET | `/jobs/:id/sheets` | листы (таблицы) |
| GET | `/jobs/:id/preview-pdf` | PDF-превью |
| POST | `/jobs/:id/approve` | подтвердить из очереди ревью |
| POST | `/jobs/:id/reprocess` | перезапустить разбор |
| POST | `/jobs/:id/redeliver-webhook` | переотправить вебхук |
| POST | `/jobs/:id/feedback` | оценка результата |
| GET | `/jobs/:id/feedback`, `/jobs/:id/corrections` | оценки и правки операторов |

Служебное: `GET /health`, `GET /ready`, Swagger — `/docs` (`server.ts:292`).

---

## 6. Для разработчиков

### 6.1 Как добавить новый тип документа

Тип живёт **в БД** и добавляется миграцией — код трогать не нужно.

**Шаг 1.** Создать файл миграции:

```bash
cd doc-service
npm run migrate:create -- add_my_document_type
```

**Шаг 2.** Заполнить по образцу
`migrations/20260716000001_container_return_and_doc_request_types.sql`:

```sql
BEGIN;

INSERT INTO document_types (
    slug, display_name, description,
    is_builtin, is_active, parser_kind, tier, organization_id,
    expected_fields, validators, classification_keywords, classification_keyword_weights,
    llm_schema
) VALUES (
    'my_document_type',
    'Моё название типа',
    'Чем этот документ отличается от соседних. Текст уходит в каталог LLM-классификатора — пишите отличительные признаки, а не общие слова.',
    false, true, 'llm_extract', 'beta', NULL,
    ARRAY['number','date','total']::text[],
    ARRAY[]::text[],
    ARRAY['ключевое слово','другое слово']::text[],
    ARRAY[8.0, 5.0]::numeric(4,2)[],
    '{
      "type": "object",
      "properties": {
        "number": {"type": "string", "description": "Номер документа"},
        "date":   {"type": "string", "description": "Дата (YYYY-MM-DD)"},
        "total":  {"type": "number", "description": "Итоговая сумма"}
      }
    }'::jsonb
);

COMMIT;
```

Обязательно дописать **Down Migration** (`DELETE FROM document_types WHERE slug = …`).

**Шаг 3.** Применить и проверить:

```bash
npm run migrate
npm test                       # регрессия
# отправить пример документа через POST /api/v1/jobs и посмотреть document_type
```

Что важно:

- `classification_keywords` — кириллица матчится **подстрокой**, латиница — по границе
  слова (`\b`); веса в `classification_keyword_weights` позиционно соответствуют словам.
- `expected_fields` — по ним считается полнота и срабатывает гейт `needs_review`.
- `tier = 'beta'`, пока нет golden-набора.
- `organization_id = NULL` — глобальный тип; иначе тип виден только своей организации.
- `parser_kind = 'llm_extract'` — обслуживается `GenericLlmParser` по `llm_schema`.

### 6.2 Где что лежит

| Что | Путь |
|---|---|
| Определения типов | `doc-service/migrations/*.sql` |
| Схемы встроенных типов | `doc-service/src/types/document-json-schemas.ts` |
| Константы типов / статусов / движков | `doc-service/src/types/documents.ts` |
| Перевод слагов inbound / outbound | `doc-service/src/types/slug-normalize.ts` |
| Конвейер | `doc-service/src/pipeline/orchestrator.ts` |
| Парсеры | `doc-service/src/pipeline/parsers/` |
| Классификация | `doc-service/src/pipeline/classifier/` |
| Сегментация | `doc-service/src/pipeline/multidoc/` |
| Нормализация | `doc-service/src/pipeline/normalize/` |
| Deep-pass | `doc-service/src/pipeline/deep-pass/` |
| Контракт вебхука | `doc-service/src/webhooks/deliver.ts` |
| API | `doc-service/src/routes/` |
| Конфиг и флаги | `doc-service/src/config.ts`, `doc-service/.env.example` |
| Тесты | `doc-service/tests/` |

### 6.3 Команды

```bash
npm run dev:api          # API с автоперезагрузкой
npm run dev:worker       # worker
npm run build            # tsc
npm run migrate          # миграции вверх
npm run migrate:down     # откат
npm run migrate:create   # создать файл миграции
npm test                 # vitest
npm run smoke            # smoke-прогон
npm run seed:users       # тестовые пользователи
```

Node.js 22 обязателен: на более старых `vitest` падает на `crypto.getRandomValues`.

### 6.4 Переменные окружения

Полный список с комментариями — `doc-service/.env.example`. Ключевые:

| Переменная | Назначение |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres и очередь |
| `API_KEY` | ключ доступа к API (без него — `401`) |
| `SECRETS_ENCRYPTION_KEY` | 64 hex-символа; шифрование ключей провайдеров в БД. В production обязателен |
| `WEBHOOK_HMAC_SECRET` | подпись исходящих вебхуков |
| `TESSERACT_LANGS` | языки OCR (`rus+eng`) |
| `TESSERACT_TIMEOUT_MS` | таймаут страницы, дефолт `90000` |
| `TESSERACT_MAX_PAGES` | потолок страниц, `0` = без лимита |
| `DEEP_PASS_ENABLED` | второй ярус разбора, дефолт `false` |
| `DEEP_PASS_TEXT_CHARS` | сколько текста уходит в text-путь, дефолт `8000` |
| `DEEP_PASS_MIN_TEXT` | ниже порога — путь по картинке, дефолт `300` |
| `VLM_CLASSIFY` | классификация слабой страницы по изображению |
| `MULTIDOC_LLM_CLASSIFY` | постраничная LLM-классификация в составных файлах |
| `VISION_PAGE_PARALLELISM` | параллельных страниц в vision-OCR, дефолт `1` |
| `WEBHOOK_SSRF_CHECK` | проверка `webhook_url`, дефолт включена |

Доступы, которые нужны разработчику: база и Redis (локально через compose), `API_KEY`
для запросов. Ключ LLM-провайдера в `.env` **не** хранится — вносится через UI и
шифруется в БД.

### 6.5 Стоимость разбора

Считается per-job и пишется в `cost_rub` (`pipeline/cost.ts`); ставки — в `config.cost`
и переопределяются через env: отдельно страница OCR, страница с таблицами и токены LLM
на вход и выход. Флаг `cost_estimate` показывает, что данных для точного расчёта не хватило.

---

## 7. Статус / Changelog

**На 19 июля 2026:**

- **52 типа документов** в каталоге: 6 встроенных + 46 каталожных
  (проверено по `migrations/*.sql`).
- **Прогон ~2000 документов** на пилотном корпусе — по данным владельца продукта;
  из кода эта цифра не выводится.
- Канонические названия типов зафиксированы; последняя ревизия наименований —
  `migrations/20260717000003_display_name_cleanup.sql`.
- Контракт вебхука — `schema_version 1.4` (добавлен `extracted._deep`, аддитивно).
- `_match_signals` — `schema_version 1.2`.

**Заметные изменения последних недель:**

| Дата | Что |
|---|---|
| 2026-07-17 | Ревизия наименований типов (`20260717000003`) |
| 2026-07-17 | Тип «Поручение экспедитору» (`forwarding_order`) |
| 2026-07-16 | Типы «Возврат порожнего контейнера», «Запрос документов» |
| 2026-07-15 | Deep-pass — второй ярус разбора, контракт `1.3 → 1.4` |
| 2026-07-13 | Расчёт стоимости разбора per-job (`cost_rub`) |
| 2026-07-11 | 6 типов транзитного ВЭД-комплекта (`20260711000001`) |

---

### Смежные документы

| Файл | О чём |
|---|---|
| `ROADMAP.md` | доска задач |
| `DEPLOY.md`, `DEPLOY_TOPOLOGY.md` | развёртывание и топология окружений |
| `docs/STAND_TAIPIT.md` | описание корп-стенда ТАЙПИТ и ретроспектива разработки (архив) |
| `doc-service/docs/INTEGRATION_QUEUE.md` | открытые вопросы интеграции |
| `doc-service/docs/DEEP-PASS-SPEC.md` | спецификация второго яруса |
| `TECH_DEBT.md` | техдолг |

> ⚠️ У сервиса **несколько окружений** с разными данными, ключами и правилами доступа —
> см. `DEPLOY_TOPOLOGY.md` и `CLAUDE.md`. Перед деплоем или правкой `.env` уточняйте,
> о каком окружении речь.
