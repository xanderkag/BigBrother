# Tech debt

Список задач, накопленных при scaffold'е (doc-service + inference-service). Структура — по серьёзности и срочности. Когда берёте задачу — отметьте «in progress» и закрывайте PR'ом со ссылкой на пункт.

---

## Закрыто в этой итерации

### Базовые проверки границ
- ✅ **C2** Worker concurrency дефолт = 1, конфигурируется через `WORKER_CONCURRENCY`.
- ✅ **B1** Cap 64 KB на поле `metadata` при `POST /jobs`.
- ✅ **B2** Sanitize имени файла пропускает юникодные буквы и цифры (Cyrillic больше не превращается в `_______`).
- ✅ **I7** Усиленное предупреждение про ПДн и Yandex Vision в `.env.example`.
- ✅ Reject 0-byte uploads на `POST /jobs`.
- ✅ Валидация формата `webhook_url` (только http/https).

### Доменная валидация (новый слой)
- ✅ **Уровень 4** — российские реквизиты:
  - `validateInn` с официальной checksum (10 и 12 цифр, приказ ФНС).
  - `validateKpp` (формат NNNNCCNNN, 9 символов).
  - `validateVehiclePlate` (только 12 разрешённых ГИБДД букв, формат А123ВВ77).
  - `validateCountryCode` (ISO 3166 alpha-2).
  - `validateDate` с диапазоном (после 2010, не далее 30 дней в будущем).
  - `validateMoney` (≥0, конечно, < 1 трлн).
- ✅ **Уровень 5** — согласованность полей:
  - `validateVatConsistency` (vat ≈ total × rate / (100+rate), толерантность 0.5%).
  - `validatePositionsSum` (∑positions.total ≈ total, толерантность 1%).
  - `validatePartiesDiffer` (продавец ≠ покупатель).
  - Для ТТН: масса нетто не больше брутто.
- ✅ Композер `validateExtracted` запускает нужный набор по типу документа.
- ✅ Issues сохраняются в `extracted._issues`, поднимаются в API как `validation_issues: string[]`.
- ✅ После доменной валидации с issues статус автоматически = `needs_review`.
- ✅ PATCH /extracted перевалидирует — корректировка человека убирает issues.

### Операционные пробники
- ✅ **Уровень 7** — `/ready` теперь проверяет: PostgreSQL `SELECT 1`, Redis `PING`, `STORAGE_DIR` writable. Любой провал — 503 со списком в `error`.

### Phase 1 Day 1 — фундамент operational layer (2026-05-11)

- ✅ **C1** Outbox/poller для зависших pending jobs — `src/workers/pending-job-sweeper.ts`. Каждую минуту вычитывает `WHERE status='pending' AND age > grace`, переенки в BullMQ с тем же `jobId` (BullMQ дедупит). Конфиг: `PENDING_SWEEPER_INTERVAL_MS`, `PENDING_SWEEPER_GRACE_SECONDS`.
- ✅ **C4** TTL cleanup uploaded файлов — `src/workers/file-cleanup.ts`. Раз в час чистит файлы по job'ам в финальном статусе старше `FILE_RETENTION_DAYS` (по умолчанию 30). DB-row сохраняется (audit), файл и пустой каталог удаляются, `file_path` NULL'ится.
- ✅ Structured logs с `request_id` через весь pipeline — Fastify `genReqId`, propagation в BullMQ payload, worker создаёт child-логгер с привязкой `request_id`/`job_id`/`bull_id`. Заголовок `X-Request-Id` принимается на вход и возвращается клиенту.
- ✅ Тесты на оба sweeper'а с мок-репо: stale=пусто, multi-row, ошибка enqueue не валит цикл, overlap guard, ошибка unlink не маркирует row deleted.

### Phase 1 Day 2 — operator UI (2026-05-11)

- ✅ Полноценный UI на `/` — htmx-friendly HTML + Tailwind v3 Play CDN + Alpine.js, без build-шага. Login по API-токену в localStorage, dark mode, sidebar layout. Views: jobs list (auto-refresh для in-flight, фильтры, status-badges, confidence bars), job detail (JSON-viewer для extracted, validation_issues панель, edit mode → PATCH с перевалидацией, RAW OCR text в `<details>`), upload (drag-and-drop + optional fields), settings (placeholder).

### Phase 2 Day 1 — ClaudeBackend + Settings (2026-05-11)

- ✅ **ClaudeBackend** в inference-service через `anthropic` SDK. Поддерживает classify / extract / vision-ocr / verify. Lazy-import — stub-образу не нужен.
- ✅ `/v1/providers/status` в inference-service — без leak'а секретов сообщает какие провайдеры настроены, какой активен.
- ✅ `/api/v1/settings` и `/api/v1/providers/status` в doc-service. Settings возвращает sanitized snapshot (без секретов), providers/status проксируется к inference c graceful degradation.
- ✅ Settings UI переделан в живой dashboard: LLM providers с active/configured badges, OCR thresholds, engines state (Yandex с ПДн-warning если включён), storage/sweepers/limits/endpoints/session.

### Phase 2 Day 2 — Idempotency-Key + magic-bytes (2026-05-11)

- ✅ **I1 Idempotency-Key** — новая миграция `002_idempotency.sql` (partial unique index, NULL keys не конфликтуют). `POST /jobs` читает заголовок до парсинга multipart'а; если ключ уже использован → HTTP 200 с `Idempotency-Replayed: 1` и существующим job_id. Race condition (две параллельных POST'ов с одним key) ловится unique violation на INSERT и резолвится в SELECT + удаление дублирующего файла. Валидация ключа: 1-64 символа, `[A-Za-z0-9._-]`.
- ✅ **B5 file magic-bytes validation** — пакет `file-type ^19.6`. После сохранения файла читаются magic bytes; если детектируется не из `ACCEPTED_DOCUMENT_MIMES` (PDF/JPEG/PNG/BMP/TIFF/WebP) — 400 и удаление файла. Если detected mime ≠ declared multipart Content-Type — detected становится authoritative (логируется warning). Защита от exe-под-видом-PDF, расширения vs реальный формат, и подобного.
- ✅ Тесты: `tests/idempotency.spec.ts` (header parsing, unique-violation detector), `tests/magic-bytes.spec.ts` (PDF/PNG/JPEG/BMP/WebP по реальным magic bytes, рейект plaintext/exe, обнаружение mislabelled PDF).

### Phase 3 Day 5 — Admin Layer: CRUD + Provider keys + Audit (2026-05-13)

- ✅ **CP4 Admin layer для document_types** — `POST /document-types`, `PATCH /document-types/:slug`, `DELETE /document-types/:slug`. Builtin защищён от DELETE (можно деактивировать через PATCH). Каждый write: → запись в `audit_log` (before/after/diff) → `documentTypeResolver.invalidate(slug)` → следующий job подхватывает изменения без рестарта.
- ✅ **`provider_settings` + `audit_log`** — новая миграция `004`. Provider rows стартуют seed'ом с 6 заглушек (anthropic, openai, qwen-local, stub, tesseract, yandex-vision) с пустыми ключами и единственным «default» — `stub` для LLM и `tesseract` для OCR. Партиальный UNIQUE-индекс гарантирует ровно один default per kind.
- ✅ **CRUD /provider-settings** + endpoint `POST /:id/set-default` (атомарная транзакция) + `POST /:id/test` (HEAD/GET по base_url с замером latency). Секретный `api_key` НИКОГДА не возвращается в API (только маска `••••XXXX` и `has_api_key`). Snapshot'ы в audit_log тоже без plaintext.
- ✅ **`DynamicLlmClient`** — shim над HttpLlmClient/NullLlmClient, в hot-path читает `provider_settings.findDefault('llm')` каждые 30s с TTL-кэшем. При write через UI кэш сразу инвалидируется. orchestrator теперь держит этот шим как singleton — env-keys остаются как fallback.
- ✅ **`GET /audit-log`** с фильтрами `entity`/`entity_id` и пагинацией. Diff-структура `{ field: { from, to } }` собирается на write при помощи `_computeDiffForTesting`.
- ✅ **Editor UI для document_types** (`#document-types/new` + `#document-types/<slug>`): все поля, chip-инпуты для expected_fields/validators/classification_keywords, JSON-textarea для llm_schema с валидацией парса, инструкция для агента (llm_prompt), пороги, кнопки Создать/Сохранить/Удалить.
- ✅ **Providers UI** (`#providers`) — карточки по kind (LLM/OCR), badge'и default/active/key-set, переход в editor с полями base_url/api_key/model + кнопки «Тест связи», «Сделать default», «Очистить ключ».
- ✅ **Audit log UI** (`#audit-log`) — список с фильтром по entity/entity_id, expand-раскладка с diff-таблицей before/after + raw JSON-дамп.
- ✅ Тесты: `tests/audit-diff.spec.ts` (6 кейсов), `tests/provider-settings-api.spec.ts` (4 кейса — нет утечки plaintext-ключа в toApi).
- ⏸ Открытые позиции (см. CP1/CP4/CP6 ниже):
  - secrets at rest: api_key в БД пока plaintext; нужен envelope-шифрование (pgcrypto или KMS-проксирование) перед prod-деплоем под клиента;
  - inference-service всё ещё читает свои ключи из env — UI-настроенный `anthropic.api_key` пока не пробрасывается per-request в /v1/extract (требует расширения protocol'а);
  - audit_log без retention — со временем разрастётся, нужен TTL-sweeper или партиции.

### Phase 3 Day 3 — CP1 продолжение: per-type thresholds + override-протокол парсеров (2026-05-12)

- ✅ **`ResolvedTypeConfig`** + `resolveConfigFromRow` — чистый builder, складывает DB-значения с env/hardcoded fallback'ами и репортит источник (`db` vs `fallback`). Resolver-singleton получил метод `resolveConfig(slug)`.
- ✅ **ParserOverride API**: `DocumentParser.parse(text, override?)`. Override-параметры: `expectedFields`, `regexFallbackThreshold`, `llmSchema`. Все 5 парсеров (Invoice/UPD/TTN/CMR/AKT) подхватывают. Без override — старое поведение (тесты остались зелёными).
- ✅ **Orchestrator резолвит конфиг once per job** и:
  - передаёт override в `parser.parse(...)` — `expected_fields`, `regex_fallback_threshold`, `llm_schema` из БД теперь живые;
  - читает `typeConfig.confidenceThreshold` для решения needs_review (вместо глобального `NEEDS_REVIEW_THRESHOLD`).
- ✅ Тесты: `tests/resolve-config.spec.ts` (null row → fallback, DB row → override, частичный fallback по null-колонкам, immutability массивов), `tests/parsers.spec.ts` дополнен 5 кейсами на override-семантику.
- ⏸ Осталось из CP1: классификатор всё ещё читает захардкоженные keywords; parser_kind в БД не используется для диспатча (`buildParsers` возвращает фиксированный мапинг); llm_prompt override не пробрасывается в inference-service (нужно расширение API).

### Phase 3 Day 2 — Validator Registry + первый runtime-шаг (2026-05-12)

- ✅ **CP3 Validator Registry** — `pipeline/validation/registry.ts`. Парсер строковых спецификаций (`inn_checksum:seller.inn`, `parties_differ:seller.inn,buyer.inn`, `vat_consistency`, ...) с резолюцией в builtin-функции и dot-path-доступом к полям. 9 builtin'ов: inn_checksum, kpp_format, vehicle_plate, country_code, date_range, money_sanity, vat_consistency, parties_differ, weight_nett_le_gross. Unknown specs логируются и пропускаются — не падает пайплайн.
- ✅ **CP1 partial — `DocumentTypeResolver`** (`pipeline/document-type-resolver.ts`). Кэширующий слой над `documentTypesRepo` с TTL 60 секунд и хук `invalidate(slug?)` под будущие PUT/POST. Process-wide singleton.
- ✅ **Validation runtime читает из БД.** Новый `validateExtractedWithResolver` (async): для каждого job'а резолвит DocumentType из БД через resolver, прогоняет его список validators через registry. **Hardcoded composer оставлен как fallback** — если slug'а нет в БД (свежий тест-стенд, runtime до миграции), пайплайн использует прежнюю логику. Подключено в `orchestrator.runDocumentPipeline` и `PATCH /jobs/:id/extracted`.
- ✅ Тесты на registry (15+ кейсов): парсер спецификаций, dot-path resolution, все 9 builtin-валидаторов в позитивных/негативных сценариях, мульти-issue прогон.

### Phase 3 Day 1 — Document Type Registry (foundation, 2026-05-12)

- ✅ **Стратегический pivot:** платформа эволюционирует с «OCR-сервиса с захардкоженными типами» в **configurable document-processing system** с admin layer'ом. Каждый тип документа — first-class конфиг в БД: парсер, prompt, схема, валидаторы, пороги, ключевые слова классификатора.
- ✅ Миграция `20260512000003_document_types.sql`: новая таблица + seed из 6 текущих типов (invoice, factInvoice, UPD, TTN, CMR, AKT) с их фактическими параметрами.
- ✅ Repo `src/storage/document-types.ts` + API `GET /api/v1/document-types{/:slug}` для админ-UI.
- ✅ Сайдбар-секция **Document types**: список с парсером/полями/валидаторами + детальная страница со всей конфигурацией.
- ⏸ Парсеры, классификатор, OCR-пороги пока всё ещё хардкод — следующий шаг CP1.

### Phase 2 Day 3 — Prometheus metrics + migration framework (2026-05-11)

- ✅ **C3 Migration framework** — подключен `node-pg-migrate`. Миграции лежат в `migrations/<timestamp>_<slug>.sql` с явными секциями `-- Up Migration` / `-- Down Migration`. Применённые версии трекаются в таблице `pgmigrations`. Команды: `npm run migrate` (up all), `npm run migrate:down` (rollback 1), `npm run migrate:create <name>` (scaffold). В docker-compose добавлен one-shot сервис `migrate`, от которого зависят `api` и `worker` — схема гарантированно актуальна перед стартом трафика. Убран автозагрузочный mount `/docker-entrypoint-initdb.d`.
- ✅ **I4 `/metrics` endpoints** на обоих сервисах. Public (Prometheus scrape без Bearer); защита — на уровне корп.nginx.
- ✅ doc-service: `prom-client` + default Node-метрики. Кастомные:
  - `docservice_jobs_total{status,document_type}` — терминальный счётчик
  - `docservice_jobs_duration_seconds{document_type,outcome}` — end-to-end histogram
  - `docservice_ocr_engine_duration_seconds{engine,outcome}` — per-engine latency (accepted / rejected / error)
  - `docservice_llm_calls_total{endpoint,outcome}` + `docservice_llm_call_duration_seconds{endpoint}`
  - `docservice_webhook_attempts_total{outcome}` (success / client_error / server_error / network_error)
- ✅ inference-service: `prometheus-client` + middleware который автоматом снимает каждый HTTP-запрос:
  - `inference_requests_total{endpoint,backend,outcome}`
  - `inference_request_duration_seconds{endpoint,backend}` — buckets от 50ms (stub) до 2 минут (Qwen cold)
- ✅ Settings UI получил ссылку на `/metrics` в Endpoints карточке.

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

### CP1. Runtime читает Document Types из БД (in progress)

**Где:** `doc-service/src/pipeline/orchestrator.ts`, `parsers/index.ts`, `classifier/keywords.ts`, `validation/index.ts`, `types/document-json-schemas.ts`

**Симптом:** Сейчас pipeline использует захардкоженные значения. Конфиг в БД — informational only.

**Прогресс:**
- ✅ `DocumentTypeResolver` (кэш + invalidate hook + `resolveConfig`) — готов.
- ✅ Валидация читает `validators[]` из БД через resolver — готово. Hardcoded composer оставлен как fallback.
- ✅ Парсеры принимают `ParserOverride` с `expected_fields`/`regex_fallback_threshold`/`llm_schema` — orchestrator передаёт.
- ✅ `confidence_threshold` per-type работает — orchestrator берёт из resolved config (fallback на env).
- ✅ `regex_fallback_threshold` per-type работает — пробрасывается в Phase 1 парсеры через override.
- ✅ `llm_schema` per-type работает — пробрасывается в /v1/extract.
- ⏸ Классификатор всё ещё читает захардкоженные keywords (хотя seed в БД совпадает).
- ⏸ `parser_kind` поле есть, но не диспатчит парсера — определяет TS-импорты в `buildParsers`.
- ⏸ `llm_prompt` override не пробрасывается в inference-service (нужно расширение `/v1/extract` API чтобы принимать prompt override).

**Лечение оставшегося:** (а) классификатор → async-метод с резолюцией keywords из БД (агрегация по всем активным типам); (b) `parser_kind` диспатч — если в БД написано `llm_extract` для бывшего regex-типа, парсер должен использовать LLM-only; (c) llm_prompt override — расширение API inference-service.

**Оценка:** 1 день на оставшееся.

---

### CP2. Editor UI для Document Types

**Где:** `doc-service/web/`

**Симптом:** UI сейчас read-only. Чтобы добавить новый тип / поправить промпт — лезть в SQL.

**Лечение:** Форма редактирования (markdown-style для prompt, JSON-editor для schema, list-builder для validators/keywords). Кнопка «Тестировать» — гонит выбранный документ через draft-конфигурацию, показывает результат до сохранения.

**Оценка:** 3-4 дня.

---

### ~~CP3. Validator registry~~ — ✅ закрыто 2026-05-12

Реализован `pipeline/validation/registry.ts` (resolver, parseSpec, runValidatorSpecs) + интеграция в `validateExtractedWithResolver`. См. «Phase 3 Day 2» в шапке.

---

### CP4. PUT/POST /document-types + audit log

**Где:** новые API + миграция

**Симптом:** Конфигурация в БД read-only через API. Изменения только через SQL.

**Лечение:** PUT для существующих, POST для новых типов (с slug-validation). Каждое изменение → запись в `document_types_history` (кто/когда/что поменял + diff). Подготовит почву под role-based access (admin vs operator).

**Оценка:** 2 дня (включая history-таблицу + UI changelog).

---

### CP5. Расширение набора document types

**Где:** `migrations/...` + опционально через API после CP4

**Симптом:** Сейчас только 6 типов. По roadmap нужно: commercial invoice, packing list, AWB, B/L, контракты, customs, этикеты, доверенности, сертификаты, внутренние формы.

**Лечение:** После CP1-CP4 каждый новый тип = миграция со seed-вставкой (или админ через UI). Параллельно — определить JSON schemas для каждого, написать LLM-промпты, валидаторы.

**Оценка:** ~день на тип (включая prompt-инжиниринг и проверку на образцах).

---

### CP6. Quality Review workflow

**Где:** `web/` + новые роуты

**Симптом:** Сейчас `needs_review` задачи висят в общем списке job'ов. Нет отдельного «оператор-режима» где видны только они с быстрым approve/edit.

**Лечение:** Новый view `/review` — очередь needs_review с side-by-side: preview документа + редактор extracted + batch-кнопки (approve / reject / re-process). Накапливать diff between OCR-result и финальный — будет training data.

**Оценка:** 2-3 дня.

---

### CP7. Multi-tenant foundation (когда понадобится)

**Где:** schema-wide

**Симптом:** Платформа сейчас single-tenant. Если завтра появится клиент со своими типами/правилами — придётся вводить tenancy с нуля.

**Лечение:** Добавить `tenant_id` в `jobs` и `document_types`. Auth middleware резолвит `tenant_id` из токена. Document types становятся scoped per-tenant (builtin = глобальные, custom = per-tenant). Это **не делать сейчас** — добавить когда появится второй потребитель.

**Оценка:** 1-2 недели после первого реального запроса от не-нашего клиента.

---

## 🟠 Important (укусит при ramp-up)

### ~~I1. Нет идемпотентности на `POST /jobs`~~ — ✅ закрыто 2026-05-11

Реализован header `Idempotency-Key`. См. «Phase 2 Day 2» в шапке.

---

### I2. Нет deadline на ретраи

**Где:** `doc-service/src/queue.ts:21-25` (BullMQ defaults)

**Симптом:** При длительном падении внешнего сервиса (LLM, Yandex) job либо сдаётся слишком быстро (3 attempts × backoff), либо может тянуть retry-цепочку часами без естественной остановки.

**Лечение:** В worker'е перед обработкой проверять `now() - job.created_at > MAX_AGE` → markFailed.

**Оценка:** 2 часа.

---

### I3. `combineConfidence(ocr, 0)` валит хорошо распознанный документ

**Где:** `doc-service/src/pipeline/quality.ts:55`

**Симптом:** Геометрическое среднее. Если LLM недоступен и Phase 2 парсер вернул `confidence: 0`, итоговая = 0 → `needs_review` даже на идеальном OCR.

**Лечение (требует продуктового решения):**
- Вариант A: оставить как есть, явно задокументировать «без LLM ТТН/CMR/АКТ всегда needs_review».
- Вариант B: разделить на два поля API: `ocr_confidence` и `extraction_confidence`. Клиент сам решает.

**Оценка:** 1 час кода + продуктовое обсуждение.

---

### ~~I4. Нет наблюдаемости~~ — ✅ закрыто 2026-05-11 (частично)

Реализованы `/metrics` endpoints на обоих сервисах. См. «Phase 2 Day 3» в шапке. **Grafana board ещё не настроен** — задача на следующую итерацию (`I4b`).

---

### I4b. Grafana dashboard для собранных метрик

**Где:** отдельный артефакт (JSON dashboard + provisioning), вероятно в `monitoring/`

**Симптом:** Метрики собираются (`/metrics` на обоих сервисах отдают данные), но дашборд для оператора ещё не построен. Чтобы увидеть KPI «% needs_review», «median OCR latency by engine», «LLM error rate» нужно либо ходить на raw `/metrics`, либо ручками сложить запрос в Prometheus.

**Лечение:** JSON dashboard для Grafana с панелями:
- Jobs throughput (rate of `docservice_jobs_total` by status)
- OCR latency p50/p95/p99 per engine
- LLM call success rate + latency by endpoint
- Webhook delivery success rate
- Queue depth (нужен ещё один gauge — sample BullMQ `getJobCounts()` периодически)
- Inference-service: requests/sec by backend, latency p95

**Оценка:** день на дашборд + provisioning через docker-compose. Можно отложить до момента когда метрики начнут реально нужны (после первого продакшен-инцидента или жалобы на скорость).

---

### I5. Нет rate-limiting

**Где:** `doc-service/src/server.ts`

**Симптом:** Любой клиент с валидным `API_KEY` может забить очередь и съесть диск за минуту.

**Лечение:** `@fastify/rate-limit` плагин, лимиты per-IP и per-API-key.

**Оценка:** 2 часа.

---

### I6. Yandex Vision контракт не выверен

**Где:** `doc-service/src/pipeline/ocr/yandex.ts:50-66`

**Симптом:** Body shape (`folderId` / `analyze_specs` / `mime_type`) написан по памяти. Гарантированно сломается при первом вызове.

**Лечение:** `curl` к Yandex API с одним документом, сверить request/response, поправить shape. Желательно — добавить Yandex API в integration-тесты с записанным VCR-ответом.

**Оценка:** 2 часа на сверку + 2 часа на VCR-моки.

---

### I8. PII opt-out для Yandex не реализован

**Где:** `doc-service/src/pipeline/ocr/yandex.ts:18-22`

**Симптом:** TTN с фотографией паспорта водителя могут уехать в Yandex Cloud. Регуляторный риск (152-ФЗ).

**Лечение:**
1. Поле `disable_external_ocr: true` в `metadata` → router пропускает Yandex для этого job'а.
2. ИЛИ глобальный флаг `YANDEX_DISABLE_FOR_PII=true` + классификатор помечает PII-документы (TTN, CMR с водительскими данными).
3. Пока не сделано — **выключать Yandex полностью** (env пустой, документировано в `.env.example`).

**Оценка:** 4 часа на вариант 1, день на вариант 2.

---

## 🟡 Architectural (думать сейчас, делать потом)

### A1. inference-service синхронный

**Симптом:** Каждый `POST /v1/extract` блокирует FastAPI worker. Под нагрузкой запросы стоят в backlog'е.

**Лечение:** Очередь поверх Redis (тот же `ai-platform`), как у doc-service. Альтернатива — vLLM с continuous batching.

**Оценка:** 2 дня + миграция Qwen-backend на vLLM.

---

### A2. Storage abstraction half-done

**Симптом:** `FileStorage` интерфейс есть, реализация одна (LocalFs). Горизонтальное масштабирование worker'ов невозможно (они должны делиться диском).

**Лечение:** `S3FileStorage` через `@aws-sdk/client-s3` (совместим с MinIO). Конфиг-селектор `STORAGE_BACKEND=local|s3`.

**Оценка:** день.

---

### A3. Single API key

**Симптом:** Нет аудита «кто загружал», нет ротации без даунтайма.

**Лечение:**
1. Multi-key через env: `API_KEYS_JSON='{"<key>":"<client_name>"}'`. Имя клиента → `jobs.metadata.caller`.
2. DB-backed токены с CRUD-API + ротацией — отдельный мини-проект.

**Оценка:** 3 часа на вариант 1, неделя на вариант 2.

---

### A4. Webhook deliveries не воскрешаются

**Симптом:** Если webhook сдох на 5-й попытке — кнопок «доставить ещё раз» нет.

**Лечение:** Ручка `POST /jobs/:id/redeliver-webhook` + sweeper для добивки старше N часов.

**Оценка:** 3 часа.

---

### A5. Двойная растеризация PDF

**Где:** `doc-service/src/pipeline/ocr/tesseract.ts`, `vision-llm.ts`

**Симптом:** Tesseract и vision-llm независимо вызывают `pdftoppm` для одного и того же PDF.

**Лечение:** Кешировать растеризованные PNG'и в tmpdir per-job, переиспользовать между движками. Передавать через контекст оркестратора.

**Оценка:** 3 часа.

---

### A6. Stub-классификатор продублирован

**Где:** `inference-service/src/inference_service/backends/stub.py:25-33` копирует regex'ы из `doc-service/src/pipeline/classifier/keywords.ts:5-14`.

**Симптом:** Сейчас совпадают. Через год разойдутся незаметно.

**Лечение:** Общий `classifier-rules.json` (или YAML) в shared dir, читается обоими сервисами.

**Оценка:** 2 часа.

---

## 🟢 Latent code-level

### ~~B5. Уровень 6 — реальная проверка типа файла (magic bytes)~~ — ✅ закрыто 2026-05-11

Реализована через пакет `file-type`. См. «Phase 2 Day 2» в шапке.

---

### B3. `DROP TRIGGER + CREATE TRIGGER` в миграциях

**Где:** `doc-service/migrations/001_init.sql:55-60`

**Симптом:** Идемпотентно при повторном прогоне, но в проде на горячей таблице блочит запись на момент DDL.

**Лечение:** В будущей миграции — `CREATE TRIGGER IF NOT EXISTS` (Postgres 14+) или `CREATE OR REPLACE TRIGGER` (Postgres 14.0 не поддерживает, надо проверить).

**Оценка:** 30 минут.

---

### B4. `metadata = JSON.stringify(null)` vs `null`

**Где:** `doc-service/src/storage/jobs.ts:create`

**Симптом:** Минор. Pg-driver может передать `text NULL` вместо `jsonb NULL`. На JSONB-колонке скорее всего справится, но защита через явный `$7::jsonb` не помешает.

**Лечение:** `INSERT INTO jobs (..., metadata) VALUES (..., $7::jsonb)`.

**Оценка:** 10 минут (одна строка в SQL).

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
