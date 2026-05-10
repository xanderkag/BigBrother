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

---

## 🔴 Critical (блочит пилотный запуск)

### C1. Гонка между «создать job» и «положить в очередь»

**Где:** `doc-service/src/routes/jobs.ts:103-113`

**Симптом:** Если Redis моргнул в момент `docQueue.add`, job создан в Postgres со статусом `pending`, но в очередь не попал → висит навсегда.

**Лечение (на выбор, в порядке усложнения):**
1. Sweeper-cron в worker'е: каждые 60 секунд `SELECT * WHERE status='pending' AND created_at < now() - interval '1 min'` и переенки.
2. Outbox pattern: запись в таблицу `job_outbox` транзакционно с `jobs`, отдельный poller перекладывает в очередь.
3. Idempotent enqueue с retry — после возможного сбоя enqueue ретраится сам.

**Оценка:** 2-4 часа на вариант 1.

---

### C3. Нет нормальной системы миграций

**Где:** `doc-service/migrations/`, `doc-service/src/scripts/migrate.ts`

**Симптом:** SQL'и применяются один раз на первый старт Postgres-контейнера через `/docker-entrypoint-initdb.d`. `npm run migrate` тупо проигрывает все `.sql` подряд каждый раз. 001 идемпотентен (`IF NOT EXISTS`), но 002, 003 уже не будут.

**Лечение:** Подключить `node-pg-migrate` или `umzug`. Альтернатива — самописная таблица `_migrations(filename, applied_at)` + проверка перед прогоном.

**Оценка:** 4 часа.

---

### C4. Нет TTL на загруженные файлы

**Где:** `doc-service/src/storage/files.ts`

**Симптом:** Файлы пишутся в `STORAGE_DIR/uploads/<uuid>/`, никто не подметает. На объёме 1000 документов в день — десятки гигабайт в месяц.

**Лечение:** Cron-таск в worker'е (или отдельный k8s CronJob), удаляющий файлы для job'ов в финальном статусе старше N дней. Плюс сводка `disk_usage` в `/ready`.

**Оценка:** 3-4 часа.

---

## 🟠 Important (укусит при ramp-up)

### I1. Нет идемпотентности на `POST /jobs`

**Где:** `doc-service/src/routes/jobs.ts`

**Симптом:** Сетевой ретрай клиента → дубль job'а.

**Лечение:** `Idempotency-Key` header → колонка `idempotency_key` с unique-индексом в `jobs`. При совпадении ключа возвращаем существующий job без re-enqueue.

**Оценка:** 3 часа (миграция + роут + тест).

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

### I4. Нет наблюдаемости

**Где:** оба сервиса

**Симптом:** На вопросы «% задач в needs_review», «медиана OCR», «сколько раз LLM упал» — ответ только grep'ом по логам.

**Лечение:** `/metrics` ручка на обоих сервисах:
- doc-service: `prom-client` + кастомные счётчики (`jobs_total{status}`, `jobs_duration_seconds{stage}`, `ocr_engine_duration_seconds{engine}`, `llm_calls_total{endpoint,outcome}`).
- inference-service: `prometheus_client` + аналогично.
- Grafana board с базовыми панелями.

**Оценка:** день на оба сервиса + дашборд.

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

### B5. Уровень 6 — реальная проверка типа файла (magic bytes)

**Где:** `doc-service/src/routes/jobs.ts`, `storage/files.ts`

**Симптом:** Сейчас доверяем `Content-Type` из multipart-заголовка. Клиент может прислать `.exe` под видом `image/jpeg`, и сервис покладёт его в storage. На уровне OCR-движков это упадёт безболезненно (tesseract не распознает), но всё равно мусор на диске.

**Лечение:** После сохранения — проверить magic bytes (`%PDF`, `\xFF\xD8\xFF` для JPEG, `\x89PNG` для PNG). Пакет `file-type` это умеет за полминуты установки.

**Оценка:** 2 часа.

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
