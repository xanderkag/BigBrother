# TECH_DEBT — архив закрытых долгов

> Этот файл — архив всех закрытых F-долгов (`### ~~Name~~ — ✅ закрыто DATE`).
> Хранится отдельно от `TECH_DEBT.md` чтобы основной файл оставался
> читаемым (только open + active секции).
>
> Текущие открытые долги: `TECH_DEBT.md`

---

### ~~D1. nginx server_block для parsedocs.taipit.ru~~ — ✅ настроен коллегой 2026-05-08

DNS `parsedocs.taipit.ru → 10.59.17.54` настроен. Сервис работает на `10.10.13.10:8085`. nginx server_block + TLS — настроены коллегой (не Павлом) ещё 8 мая 2026. Узнали постфактум при попытке написать Павлу.

**Что нужно Павлу:**
```nginx
server_name parsedocs.taipit.ru;
proxy_pass http://10.10.13.10:8085;
client_max_body_size 50m;
proxy_read_timeout 600s;
proxy_http_version 1.1; Upgrade $http_upgrade; Connection $connection_upgrade;
```

**Smoke после:** `curl https://parsedocs.taipit.ru/health` → `{"status":"ok"}`

---

## 🔴 Critical (блочит пилотный запуск)

### ~~C1. Гонка между «создать job» и «положить в очередь»~~ — ✅ закрыто 2026-05-11

Реализован вариант 1 (sweeper-cron). См. «Phase 1 Day 1» в шапке.

---

### ~~C3. Нет нормальной системы миграций~~ — ✅ закрыто 2026-05-11

Подключен `node-pg-migrate`. См. «Phase 2 Day 3» в шапке.

---

### ~~C4. Нет TTL на загруженные файлы~~ — ✅ закрыто 2026-05-11

Реализован file-cleanup sweeper. См. «Phase 1 Day 1» в шапке. Disk-usage в `/ready` пока не добавлен — отдельный мини-таск.

---

## 🟣 Configurable Platform (Document Type Registry roadmap)

Эти пункты — продолжение Phase 3 Day 1 (foundation сделан, см. шапку). Переводят рантайм с захардкоженных значений на чтение из БД, добавляют admin-UI редактор и подготавливают почву под multi-tenant.

### ~~CP2. Editor UI для Document Types~~ — ✅ закрыто 2026-05-12

`web/app.js`: полный CRUD-editor на `#document-types/:slug`. Поля: slug, display_name, description, is_active, parser_kind (select), confidence_threshold, regex_fallback_threshold, expected_fields (chips), validators (chips), classification_keywords (chips), llm_prompt (textarea), llm_schema (JSON-editor с inline валидацией). Inline bookkeeping (created_at/updated_at). Async-observations панель с stats + recent jobs после сохранения.

---

### ~~CP3. Validator registry~~ — ✅ закрыто 2026-05-12

Реализован `pipeline/validation/registry.ts` (resolver, parseSpec, runValidatorSpecs) + интеграция в `validateExtractedWithResolver`. См. «Phase 3 Day 2» в шапке.

---

### ~~CP5. Расширение набора document types~~ — ✅ закрыто 2026-05-12

`migrations/20260514000005_extended_document_types.sql` — +6 builtin-типов (все `llm_extract`):
- `payment_order` — Платёжное поручение (форма 0401060); валидаторы inn/kpp/money
- `commercial_invoice` — Международный инвойс (ВЭД); поля exporter/consignee/hs_code/incoterms
- `packing_list` — Упаковочный лист; поля по местам/весу/объёму  
- `bill_of_lading` — Коносамент (B/L); vessel/voyage/containers ISO-6346
- `customs_declaration` — ГТД/ДТ; регномер/декларант/графа-31/пошлины
- `cash_receipt` — Кассовый чек ККТ (54-ФЗ); ФН/ФД/ФП/позиции

Все с `llm_schema` + `expected_fields` + `classification_keywords` + `llm_prompt`. Через UI добавляются без перезапуска кода.

---

### ~~CP6. Quality Review workflow~~ — ✅ закрыто 2026-05-12

- `POST /jobs/:id/approve` — `needs_review → done` без изменения extracted; идемпотентен.
- `jobsRepo.approve()` — SQL UPDATE только если `status='needs_review'`, иначе возвращает текущее.
- `web/app.js`: `#review` view — список needs_review со сводкой extracted полей и one-click «✓ Одобрить»; автопулл 15s; approve удаляет строку из DOM немедленно.
- Кнопка «Одобрить ✓» добавлена в job detail header (показывается только при `status=needs_review`).
- Nav-ссылка «Review» (amber-иконка ⚠) между Jobs и Upload.
- `btn-success` (emerald) добавлен в design tokens index.html.

---

### ~~I1. Нет идемпотентности на `POST /jobs`~~ — ✅ закрыто 2026-05-11

Реализован header `Idempotency-Key`. См. «Phase 2 Day 2» в шапке.

---

### ~~I2. Нет deadline на ретраи~~ — ✅ закрыто 2026-05-12

Worker проверяет `Date.now() - job.timestamp > JOB_MAX_AGE_SECONDS * 1000` и бросает `UnrecoverableError` (BullMQ не ретраит). `JOB_MAX_AGE_SECONDS=14400` (4 ч), настраивается через env.

---

### ~~I3. `combineConfidence(ocr, 0)` валит хорошо распознанный документ~~ — ✅ закрыто 2026-05-12

`parser=0` теперь трактуется как «LLM недоступен (stub)» → `ocr * 0.85` (мягкий штраф вместо нуля). Геометрическое среднее применяется только при `parser > 0`. Тесты: 3 новых кейса в `tests/quality.spec.ts`.

---

### ~~I4. Нет наблюдаемости~~ — ✅ закрыто 2026-05-11 (частично)

Реализованы `/metrics` endpoints на обоих сервисах. См. «Phase 2 Day 3» в шапке. **Grafana board ещё не настроен** — задача на следующую итерацию (`I4b`).

---

### ~~I4b. Grafana dashboard для собранных метрик~~ — ✅ закрыто 2026-05-12

Создан полный стек мониторинга в `monitoring/`:
- `monitoring/prometheus/prometheus.yml` — 3 scrape jobs (api:3000, worker:3000, inference:8000), 15s interval
- `monitoring/grafana/provisioning/` — datasource uid `prometheus` + file-provider
- `monitoring/grafana/dashboards/parsdocs.json` — 35 KB, 19 data panels в 5 рядах:
  - **Ряд 1:** jobs total / done rate / needs_review rate stats + timeseries jobs/min by status
  - **Ряд 2:** p50/p95/p99 job duration + horizontal bar p95 by document_type
  - **Ряд 3:** OCR p95 by engine + stat panels per engine (pdf-text, tesseract, vision-llm, yandex)
  - **Ряд 4:** LLM calls/min by endpoint+outcome + inference-service duration p95 + error rate
  - **Ряд 5:** webhook success rate + heap used (MB) + eventloop lag p99 (красный порог 100ms)
- `docker-compose.monitoring.yml` — compose override, Prometheus 2.51.0 port 9090, Grafana 10.4.2 port 3001

Запуск: `docker compose -f docker-compose.doc-platform.yml -f docker-compose.monitoring.yml up -d`

---

### ~~I5. Нет rate-limiting~~ — ✅ закрыто 2026-05-12

`@fastify/rate-limit` зарегистрирован в `server.ts`. Лимит per-API-key (fallback на IP). `/health` и `/ready` exempt через `allowList`. Настраивается `RATE_LIMIT_PER_MINUTE` (default 200, 0 = выключено).

---

### ~~I8. PII opt-out для Yandex~~ — ✅ закрыто 2026-05-15

Реализованы оба варианта:
- **Per-job:** `metadata._disable_external_ocr=true` → router выкидывает Yandex для этого job'а (см. `src/pipeline/router.ts:ChainOptions.disableExternalOcr`).
- **Глобальный:** `YANDEX_DISABLE_FOR_PII=true` (env) + `PII_DOCUMENT_TYPES = {'TTN', 'CMR'}` (hardcoded). Yandex выкидывается если document_hint/type входит в множество, без участия клиента.

`orchestrator.ts:runOcrChain` пробрасывает оба флага через `selectOcrChain` опции. Документировано в `.env.example`.

**Не сделано (отдельный пункт):** автоопределение PII-документов классификатором — TTN/CMR детектится только по `document_hint` от клиента. Если hint не указан и классификатор сработает позже OCR, Yandex успеет получить данные. Принимаем это ограничение: для real-prod через UI всегда указывать тип через `document_hint` или загружать через типизированный route.

---

## 🟣 Phase work (ТЗ от 2026-05-14)

### ~~Phase A — расширенные поля + унификация items[]~~ — ✅ закрыто 2026-05-15

См. коммит `549c23e`. 18 полей канонического shape строки (line_no, code, barcode, hs_code, country_of_origin, единицы, веса, разбивка НДС per-line, currency). Header расширен: vat_summary[], currency, exchange_rate, flags, shipper/consignee отдельно от seller/buyer. `normalize-extracted.ts` обеспечивает backward-compat. Миграция `0015` поднимает DB-seeded типы под канон с domain-специфичными полями.

### ~~Phase B — MultiPassLlmParser~~ — ✅ закрыто 2026-05-15

`pipeline/parsers/multipass-llm.ts`. Pass 1: header на head+tail. Pass 2: items батчами ~12KB параллелизм 3. Активация: явно через `parser_kind=llm_extract_multipass` или auto при `rawText > MULTIPASS_AUTO_BYTES` (default 30KB). Миграция `0014` расширяет enum CHECK constraint. UI editor показывает 4-ю опцию.

### ~~Phase C — UI таблица позиций~~ — ✅ закрыто 2026-05-15

`renderItemsTableInto` в `web/app.js`. 8 основных столбцов + раскрытие 10+ доп. полей. Поиск (name + code + barcode, debounce 200ms), сортировка по любому столбцу, пагинация client-side 50 строк/стр, CSV-export RFC 4180. Встроен в job detail и Test Lab inline preview.

### ~~Phase D — per-line валидаторы~~ — ✅ закрыто 2026-05-15

5 builtin'ов в `pipeline/validation/registry.ts`: `items_total_sum`, `items_vat_rates`, `items_unit_known`, `items_line_consistency`, `items_hs_code_format`. Агрегируют ошибки по строкам (не 500 issues).

### ~~Phase E1 — batch exactSearch~~ — ✅ закрыто 2026-05-15

`runItemMatching` собирает все code+name документа в один SELECT через `&&` оператор по GIN. На 500-позиционном документе: 1 запрос вместо 1000.

### ~~Phase E2 — fuzzy match через pg_trgm~~ — ✅ закрыто 2026-05-15

`listEntriesRepo.fuzzySearch()` использует `similarity(display_name, query) >= threshold` + GIN-индекс `gin_trgm_ops` (создан в миграции `0011`). В `runItemMatching` запускается как fallback после exact-провала (name length ≥ 3, threshold из `cfg.fuzzy_threshold ?? 0.3`). `match_method='fuzzy_name'`, `match_score` = реальный similarity.

### ~~F1. Identifier normalizers (ИНН + госномер)~~ — ✅ закрыто 2026-05-16

**Что:** `src/pipeline/normalize/identifiers.ts` — `normalizeInn`,
`normalizePlate`, `damerauLevenshtein`. Подключено в `orchestrator.ts`
после parser, до validation. Результаты складываются в
`_normalized_fields: { 'seller.inn': '...', 'vehicle.plate': '...' }` —
явный канал для интеграторов которым нужны exact-match значения.

16 тестов проходят. Bench v2 на новом корпусе показал что ИНН-нормализация
работает корректно — 80% seller_inn_match (без неё было бы ниже из-за
форматирования «ИНН: 7728-168-971»).

См. коммит `373834f`.

---

### ~~F2. Confidence per-field~~ — ✅ закрыто 2026-05-17

**Что сделано:**

1. **Prompt update** (`inference-service/src/inference_service/prompts/extract.py`):
   - `_RESPONSE_CONTRACT` теперь обязательно требует поле `field_confidence: {<path>: 0..1}`
   - Минимальный набор: number, date, seller.inn, buyer.inn, total_with_vat
   - Интерпретация значений объяснена (0.95-1: четко, 0.7-0.94: мелкая неопределённость, …)

2. **Schema** (`inference-service/.../schemas.py`):
   - `ExtractResponse.field_confidence: dict[str, float]` — новое поле

3. **Backends** (claude.py + openai_compatible.py):
   - Парсят `field_confidence` из LLM-ответа
   - Валидируют (числа 0..1, ключи string)
   - Кладут в `extracted._field_confidence` (convention для meta-полей)
   - Возвращают в ExtractResponse

4. **Doc-service post-processing** (`pipeline/normalize/field-confidence.ts`):
   - Извлекает `_field_confidence` из extracted, поднимает на top-level
     webhook payload (поле `_field_confidence`)
   - **Калибровка по checksum ИНН**: если checksum невалидный → ×0.5
     (LLM могла «угадать»). Валидный ИНН → минимум 0.95
   - **Калибровка по plate**: успешно нормализованный (`normalizePlate`
     вернул значение) → 0.9 минимум; не нормализуемый → cap 0.4
   - **Дефолты для критичных полей** (number, date, seller/buyer.inn,
     total_with_vat): если LLM не указала — ставим 0.7 при наличии
     значения

5. **Webhook payload** (`webhooks/deliver.ts`):
   - `WebhookPayload._field_confidence?: Record<string, number>` — новое
     top-level поле, кладётся в JSON body

6. **Тесты** — 18 unit-тестов в
   `tests/normalize-field-confidence.spec.ts`:
   pull-up, валидация значений, дефолты, калибровка checksum/plate,
   идемпотентность.

**Соответствие требованию SLAI (раздел 4.2 ТЗ):**
- ✅ Confidence на каждом ключевом поле
- ✅ Минимум на критичных полях (number, date, seller.inn, buyer.inn, total_with_vat)
- ✅ Используется для UI «жёлтых» полей и weighted scoring matcher'а
- ✅ Калибровка снижает риск ложного матча по выдуманному ИНН

См. коммит c этим closing entry.

**Где:** orchestrator + extract-prompt.

**Симптом:** сейчас один общий `confidence` на job. SLAI matcher не знает
что `vehicle.plate=0.95` (надёжно), а `total_with_vat=0.40` (модель угадала).
Без этого матчинг по слабому полю даст ложные привязки.

**Лечение:**
1. Извлекать confidence из LLM-ответа (требовать в schema per-field
   uncertainty)
2. Калибровать через ground-truth bench (если модель говорит 0.9 а
   реально правильно в 60% — корректировать вниз)
3. Для regex-парсеров — вычислять по «primary regex или fallback»

**Контракт API:**
```json
{
  "extracted": { ... },
  "confidence": 0.86,
  "_field_confidence": {
    "vehicle.plate": 0.95,
    "seller.inn": 0.91,
    "total_with_vat": 0.40,
    "items[*].name": 0.80
  }
}
```

**Срок:** 5-7 дней работы. Закрываем как часть MVP интеграции с SLAI.

---

### ~~F4. PII redaction (`?redact_pii=true`)~~ — ✅ закрыто 2026-05-16

**Где:** `src/pipeline/normalize/pii-redact.ts` + интеграция в orchestrator
(перед deliverWebhook) + flag в `routes/jobs.ts` (query `?redact_pii=true`
или multipart `redact_pii=true`).

**Что сделано:**
- Field-path redaction для: vehicle.driver, driver_phone, driver_passport,
  driver_license, seller/buyer/shipper/consignee/carrier.contact_person,
  signatory
- Regex для свободного текста (консервативный — требует контекст-слова):
  паспорт ("паспорт … 4501 №123456"), вод. удостоверение, телефон (+7/8),
  email
- **НЕ редактим**: ИНН/КПП/ОГРН (по 14-ФЗ публичная), госномера, названия
  компаний, юр.адреса. `_normalized_fields` тоже сохраняется (только ИНН
  и plate — не PII)
- Идемпотентно, в `_redacted_fields` пишется audit-список
- БД хранит оригинал, редактим только webhook payload (оператор всегда
  может посмотреть исходник, redeliver если надо)
- 13 unit-тестов

См. коммит `e8f3f6f`.

---

### ~~F8. Prompt caching в ClaudeBackend~~ — ✅ закрыто 2026-05-16

**Где:** `inference-service/src/inference_service/prompts/extract.py` —
новая функция `build_cacheable()` возвращает (system, user) tuple.
`backends/claude.py::_complete_with_usage()` подаёт system с
`cache_control: {"type": "ephemeral"}`.

**Эффект:** Anthropic кэширует static часть промпта (instructions + schema
+ контракт) на 5 минут. На bulk-обработке cache hit = ~10% обычной цены
input tokens. Экономия 70-85% на типовых документах.

`usage` возвращает `cache_creation_input_tokens` и `cache_read_input_tokens`
для измерения hit-rate в `/metrics`.

См. коммит `e8f3f6f`.

---

### ~~F9. Sonnet 4.7 как production default~~ — ✅ закрыто 2026-05-16

**Где:** `inference-service/.env.example`:
`ANTHROPIC_MODEL_ID=claude-sonnet-4-7-20260301` (было `claude-opus-4-7-20260301`).

**Эффект:** Sonnet 4.7 в ~5× дешевле Opus ($3/$15 vs $15/$75 за 1M
tokens), сохраняет качество для structured extract. Через
provider_settings UI оператор может переключить на Opus для конкретных
типов документов (CP1 готов).

**Итого экономия для пилота SLAI (50 doc/day × 30):**
- Opus без caching: $225/мес
- Sonnet с caching (F8+F9): $45/мес — **в 5× дешевле**

См. коммит `e8f3f6f`.

---

### ~~F6. category_hint через keyword-mapper~~ — ✅ закрыто 2026-05-16

**Где:** `src/pipeline/normalize/categories.ts` (17 категорий + ~250
ключевых слов на русском) + tests в `tests/normalize-totals-categories.spec.ts`.

**Что сделано:**
- 17 категорий синхронизированы с SLAI_OUR_REPLY.md (4.5): `food`,
  `beverage`, `pharma`, `textile`, `chemical`, `fuel`, `metal`,
  `construction`, `electrical`, `automotive`, `wood`, `agro`,
  `consumer_goods`, `packaging`, `service_transport`, `service_loading`,
  `other`
- Подключено в `orchestrator.ts` после `recomputeTotalsFromItems`
- Уважает существующий `category_hint != 'other'` от LLM (не перетирает)
- Перетирает только `other` либо отсутствующие значения
- Идемпотентно

**Тонкие моменты решены в keyword-листах:**
- `шин` → `' шин'/'шина '` чтобы не матчить «Простоквашино»
- `зерно` → `зерновые культур` чтобы не матчить «Кофе зерновой»
- `масло сливочное` vs `масло моторное` — обе категории
- IT-железо (сервер, картридж, кабель) → `electrical`

**После hist от SLAI** (обещали 3-5 дней) — скорректировать список под
их реальные категории. Это 1 час работы — поменять `KEYWORDS` map.

Тестов: 22 (categorizeName на ~20 примерах + applyCategoryHints на 5
сценариях + recomputeTotals на 7 сценариях).

См. коммит будет в этом push.

---

### ~~F14. Принудительный JSON формат для Claude~~ — ✅ закрыто 2026-05-17 (через prompt, не prefill)

**Где:** `inference-service/src/inference_service/prompts/extract.py`
(`_RESPONSE_CONTRACT` усилен) + `bench-claude.py` парсер.

**История:**
- Изначальный план — assistant prefill `{"role":"assistant","content":"{"}`.
  Но Sonnet 4.6 **НЕ поддерживает** prefill: API возвращает 400
  «This model does not support assistant message prefill. The conversation
  must end with a user message».
- Альтернатива — жёсткое требование в SYSTEM_PROMPT: «Ответ должен
  начинаться `{` и заканчиваться `}`, НЕ пиши вводных предложений,
  НЕ markdown ```json … ```».
- Парсер `_parse_json()` уже умеет находить outermost `{...}` через
  regex — двойная защита если модель всё-таки добавит вводный текст.

**Эффект (bench #22):** valid_json **9/10 → 10/10**. Plus побочный
эффект: type/number/date_match подскочили с 90% до 100%.

---

### ~~F15. Prompt caching boost — добавить boilerplate до ~1500 tokens~~ — ✅ закрыто 2026-05-17

**Где:** `inference-service/src/inference_service/prompts/extract.py`,
`_STATIC_BUILTIN_HEADER`.

**Сделано:** расширил с 1049 до ~1700 input tokens. Добавил:
- Описание 13 типов документов (счёт, УПД, ТТН, CMR, АКТ, payment_order,
  factInvoice, commercial_invoice, packing_list, B/L, ГТД, чек, договор)
  с пояснением что внутри каждого
- Детальные правила извлечения (числа, даты, ИНН, КПП, госномер ТС)
- Few-shot пример (УПД input → JSON output)
- Указание про многостраничные УПД

**Эффект (bench #22):**
- Cache hit на первом цикле: **62-83%** ✅ (раньше 0%)
- items_F1: **70% → 80%**
- total_match: **50% → 60%**
- type/number/date_match: 90% → 100% (комбо с F14)

**Cost paradox:** cost вырос ($25 → $30/мес) несмотря на cache. Длинный
prompt дороже даже cached. На длинных сессиях (часы реального трафика)
cache сильнее проявится — точная цифра по prod измерим через 1 неделю
после пилота.

---

### ~~F13. Webhook receiver для SLAI continuous category sync~~ — ✅ MVP закрыто 2026-05-17

**MVP реализован end-to-end:**

1. **Миграция 0020** — таблицы:
   - `slai_category_map` — текущий снимок lookup (slai_category_id → our_hint)
     с индексами по active / our_hint / usage_count_30d
   - `sync_inbox` — очередь events с UNIQUE event_id (идемпотентность)

2. **`src/security/hmac-verify.ts`** — timing-safe HMAC SHA-256 verify:
   - `verifyHmacSignature(body, header, secret)` — низкоуровневый
   - `verifySlaiSignature(body, headers, secret)` — высокоуровневый
     (проверяет header `X-SLAI-Signature` + `X-SLAI-Version: v1`)
   - Использует `crypto.timingSafeEqual` против timing attack
   - Fail-closed: если secret не настроен → 401 на любой запрос

3. **`src/storage/slai-categories.ts`** — Postgres-based storage:
   - `enqueueEvent` с идемпотентностью через ON CONFLICT (event_id)
   - `listPending` / `markProcessed` / `recordFailure` для будущего sweeper'а
   - `upsertMapping` (для snapshot reconciler) + `findById` / `findByName`
   - `deactivate` для category.deleted events

4. **`src/routes/integrations/slai-sync.ts`** — 2 endpoint'а:
   - `POST /api/v1/integrations/slai/sync/nomenclature` (events)
   - `POST /api/v1/integrations/slai/sync/nomenclature/snapshot` (daily)
   - Zod-валидация payload по схемам из PARSDOCS_CATEGORY_SYNC_REPLY.md
   - MVP: события применяются синхронно к lookup-table (без отдельного
     sweeper'а — это в roadmap'е если будет нужно офлайн-обработку)

5. **Config** — `SLAI_TO_PARSDOCS_HMAC_SECRET` env var, fail-closed
   default (пустой = endpoint не работает).

6. **17 unit-тестов** в `tests/hmac-verify.spec.ts`:
   - валидная подпись / неправильный секрет / tampered body
   - sha256= префикс / hex без префикса
   - empty header / empty secret / invalid hex / shortened hex
   - Buffer vs string body
   - UTF-8 кириллица — те же байты, та же подпись
   - version v1 принимается, v2 отклоняется
   - case-insensitive headers
   - fail-closed когда секрет не настроен

**Что в roadmap (НЕ MVP):**
- Background sweeper для асинхронной обработки sync_inbox (если нагрузка
  заставит — сейчас sync-применение в handler'е работает за миллисекунды)
- Redis cache для lookup (TTL 5 мин) — добавим если увидим latency
- Cron для daily snapshot reconciler (auto compare snapshot vs current)
- Интеграция в `applyCategoryHints` orchestrator'а — читать из
  lookup-table, обогащать наш keyword-mapper

**Блокеры для запуска endpoint'а:**
- S3 в SLAI_SYNC_QUEUE.md — нужен `SLAI_TO_PARSDOCS_HMAC_SECRET`
  от SLAI команды (генерируется через `openssl rand -hex 32`)
- Миграция должна быть применена (`npm run migrate:up` на проде)

См. коммит c этим closing entry.

**Где:** новый `src/routes/integrations/slai-sync.ts` + storage layer.

**Контекст:** SLAI рекомендует не разовый hist (F6/Q3), а continuous
bidirectional sync — TypeORM lifecycle hooks → debounced webhook к нам.
См. их `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md` и наш ответ
`doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md`.

**Что делаем:**
1. `POST /api/v1/integrations/slai/sync/nomenclature` — events receiver
   с HMAC verify (`SLAI_TO_PARSDOCS_HMAC_SECRET`), header `X-SLAI-Version: v1`.
   ⚠️ **Обязательно использовать `crypto.timingSafeEqual`** для сравнения
   сигнатур (защита от timing attack). SLAI у себя так и сделали — берём
   с них пример. Не использовать `===` или `Buffer.compare`
2. `POST /api/v1/integrations/slai/sync/nomenclature/snapshot` — daily
   full reconcile
3. Миграция `slai_category_map` (id, name, our_hint, active, updated_at)
4. Redis-cache lookup `slai_category:{id}` с TTL 24ч
5. `sync_inbox` table с UNIQUE на event_id (идемпотентность)
6. Background sweeper читает inbox → applies to lookup
7. Snapshot reconciler (cron 04:00 UTC)
8. Интеграция: `applyCategoryHints` в orchestrator читает lookup-table
9. Unit-тесты

**Срок:** 5-7 дней работы. **Зависит от:**
- HMAC secret обмен (нужен `SLAI_TO_PARSDOCS_HMAC_SECRET`)
- Подтверждение SLAI что наши 7 ответов в `PARSDOCS_CATEGORY_SYNC_REPLY.md`
  устраивают

---

### ~~F7. total_with_vat: пересчёт из items~~ — ✅ закрыто 2026-05-16

**Где:** `src/pipeline/normalize/totals.ts` + подключено в orchestrator
после `normalizeExtractedFields`, до `applyCategoryHints`.

**Поведение:**
- Считает `sum(items[].total_with_vat || items[].total || qty*price*(1+vat/100))`
- Если оригинал `total_with_vat` отсутствует — заполняет вычисленным
- Если расхождение ≥ 1 руб — заменяет + пишет
  `_totals_recomputed: { from: 'items_sum', deltas: { total_with_vat: ... } }`
- Если расхождение < 1 руб — не трогает (LLM попал)
- `total_without_vat` и `vat_amount` НЕ трогаем (риск сломать что LLM
  правильно ставил)

Парсит строковые числа с пробелами/запятой («1 000,50» → 1000.5), что
часто прилетает от LLM/regex.

Тестов: 7 в `tests/normalize-totals-categories.spec.ts` (LLM ошибся /
LLM попал / LLM забыл / строковые числа / пустой items / пересчёт из
qty×price / идемпотентность).

См. коммит будет в этом push.

## 🟡 Architectural (думать сейчас, делать потом)

### ~~A3. Single API key~~ — ✅ закрыто 2026-05-12 (вариант 1)

`API_KEYS_JSON='{"key":"client-name"}'` — named keys с caller-тегом в `AuthUser`. Auth middleware перебирает все named keys через constant-time compare, затем падает на root `API_KEY`. `caller` пишется в лог. DB-backed токены (вариант 2) — отдельный проект когда понадобится.

---

### ~~A4. Webhook deliveries не воскрешаются~~ — ✅ закрыто 2026-05-12

Реализована ручная повторная доставка:
- `jobsRepo.resetWebhookAttempts(id)` — сбрасывает `webhook_attempts`, `webhook_delivered_at`, `webhook_last_error`
- `POST /jobs/:id/redeliver-webhook` — 400 если нет `webhook_url`, 409 если job in-flight, иначе сбрасывает счётчик и вызывает `deliverWebhook()` fire-and-forget, возвращает 202 + актуальный снимок job'а
- `src/workers/webhook-sweeper.ts` — автоматический sweeper по образцу pending-job-sweeper. Каждые 15 мин ищет jobs с `webhook_delivered_at IS NULL AND webhook_last_error IS NOT NULL AND webhook_attempts < hardLimit`. Вызывает `deliverWebhook()` fire-and-forget без сброса счётчика — попытки накапливаются (5 → 10 → 15). При `hardLimit=15` — 3 волны по 5, потом только ручная кнопка.
- Config: `WEBHOOK_SWEEPER_INTERVAL_MS` (15 мин), `WEBHOOK_SWEEPER_GRACE_MINUTES` (60 мин), `WEBHOOK_SWEEPER_HARD_LIMIT` (15).
- `jobsRepo.listStaleWebhooks()` — SQL с `make_interval(mins => $2)` и `ORDER BY updated_at ASC`.
- Зарегистрирован в `worker.ts` рядом с остальными sweeper'ами, стопается на SIGTERM.

---

### ~~A5. Двойная растеризация PDF~~ — ✅ закрыто 2026-05-12

- `OcrInput` расширен полем `rasterizedPages?: string[]`
- `orchestrator.ts:runOcrChain()` — предрастеризует PDF один раз (`mkdtemp → pdftoppm -r 200`) когда в chain > 1 движка. При ошибке pdftoppm — graceful fallback (каждый движок растеризует сам). Cleanup в `finally`.
- `TesseractEngine` — выделен приватный `processPages(pageFiles, started)`. `runOnPdf()` проверяет `input.rasterizedPages` и использует их напрямую; если нет — собственная растеризация (fallback для standalone/тестов).
- `VisionLlmEngine` — аналогично.
- Экономия: 1 pdftoppm (≈5–15 сек на 10-страничном скане) на каждом job где tesseract не набрал threshold.

---

### ~~A6. Stub-классификатор продублирован~~ — ✅ закрыто 2026-05-12

- `shared/classifier-rules.json` — единый источник 7 builtin-правил в корне репо. Добавить новое правило нужно только здесь.
- `keywords.ts` — читает JSON через `readFileSync` с runtime path resolution (`dist/pipeline/classifier/ → ../../../../shared/`). Fallback к hardcoded при ошибке чтения (Docker без mount).
- `stub.py` — загружает через `_load_classifier_rules()`: 1) `CLASSIFIER_RULES_PATH` env, 2) `Path(__file__).parents[4] / 'shared' / …` (работает в dev/CI), 3) hardcoded fallback.
- Docker для inference-service: ✅ закрыто 2026-05-15. Использован runtime-volume mount вместо COPY (build context inference-service не видит `../shared`):
  - `inference-service/docker-compose.yml`: `volumes: - ../shared:/app/shared:ro`
  - `environment: CLASSIFIER_RULES_PATH=/app/shared/classifier-rules.json`
  - Преимущество: hot-reload правил без rebuild образа.
- Docker для doc-service: ✅ закрыто 2026-05-15. Тот же runtime-volume mount в `api` и `worker`:
  - `doc-service/docker-compose.yml`: `volumes: - ../shared:/app/shared:ro` для обоих сервисов.
  - `keywords.ts` уже резолвит путь как `/app/shared/classifier-rules.json` (через `dist/pipeline/classifier/ → ../../../../shared/`).
  - До этого фикса в Docker doc-service молча падал на hardcoded fallback, что могло разъехаться с Python после правки правил в shared/.

---

## 🟢 Latent code-level

### ~~B5. Уровень 6 — реальная проверка типа файла (magic bytes)~~ — ✅ закрыто 2026-05-11

Реализована через пакет `file-type`. См. «Phase 2 Day 2» в шапке.

---

### ~~B3. `DROP TRIGGER + CREATE TRIGGER` в миграциях~~ — ✅ закрыто 2026-05-15

Миграция `0016_fix_trigger_ddl.sql` переписывает функцию и trigger через `CREATE OR REPLACE` (Postgres 14+). Идемпотентна, не блочит запись на момент DDL — REPLACE атомарно меняет определение.

---

### ~~B4. `metadata = JSON.stringify(null)` vs `null`~~ — ✅ закрыто 2026-05-15

В `jobsRepo.create()` к параметру `$7` (metadata) добавлен явный cast `$7::jsonb`. Pg-driver больше не может передать text NULL вместо jsonb NULL — защита на случай будущих triggers/expressions на metadata.

---

## 🧪 Test gaps

| Что | Текущее покрытие | Приоритет |
|---|---|---|
| `processJob` (DB, webhook delivery, error path) | 0 | high |
| HTTP routes / handler integration (полный круг multipart upload → enqueue → response) | 0 (только auth) | high |
| `localFileStorage.saveStream` (path traversal, sanitize, 0-byte) | 0 | medium |
| `HttpLlmClient` (network errors, timeouts, malformed responses) | 0 | medium |
| `YandexVisionEngine` с записанным VCR | 0 | low (вместе с I6) |
| Smoke runner — что хотя бы запускается без ошибок | 0 | medium |

**Подход:**
- Для HTTP routes — Fastify `inject()` с моками `jobsRepo` и `docQueue`.
- Для `processJob` — testcontainers с реальным Postgres + Redis (медленно, но реалистично) или vi.mock на репо.
- Для file storage — temp dir + проверки на скверные имена файлов (`../../etc/passwd`, `аaa.pdf` с zero-width chars и т.п.).

**Оценка:** 1-2 дня на closing high-priority строк.

---

## Структура категорий

- **🔴 Critical** — блочит запуск на пилоте. Делать первым.
- **🟠 Important** — система работает, но при росте нагрузки или количества клиентов начнёт болеть.
- **🟡 Architectural** — стоит подумать сейчас, спланировать в roadmap, реализовать в следующих фазах.
- **🟢 Latent** — мелкие баги, которые рано или поздно выстрелят.
- **🧪 Test gaps** — отдельная категория, не привязанная к серьёзности.
