# Operations runbook parsdocs: очередь, застревания, диагностика

> Сведено из адверсариальной верификации по факту (2026-07-21): чтение
> исходников + live прод. См. также [`RUNTIME_TOPOLOGY.md`](./RUNTIME_TOPOLOGY.md)
> (где что крутится + ловушки данных).

---

## Контейнеры (прод-хост `10.10.13.10`, доступ `ssh kb-docker`)

| Контейнер | Роль |
|---|---|
| `parsdocs-api-1` | HTTP-сервер (:8085→3000), **тут живёт LLM-gateway** (`/v1/chat/completions`) |
| `parsdocs-worker-1` | обработка джобов (extraction/vision-OCR через `http://inference:8000`) + все sweeper'ы |
| `parsdocs-inference-1` | inference-service (:8000) — решает GPU-бэкенд по per-request override |
| `parsdocs-ollama` | Ollama (gateway-chat) |
| `parsdocs-postgres-1`, `parsdocs-redis-1` | БД + BullMQ |

Деплой: `cd /home/lyapustin.a/parsdocs && git pull origin main && cd doc-service && docker compose -p parsdocs up -d --build worker api` (миграции применяет one-shot `migrate` перед стартом).

---

## Очередь (BullMQ)

- Имя очереди: **`doc-jobs`** (`src/queue.ts:5`). Один общий ioredis (`maxRetriesPerRequest:null`).
- Дефолты джобы: `attempts:3`, exponential backoff 5с, `removeOnComplete` 24ч/1000, `removeOnFail` 7 дней.
- **Воркер:** `WORKER_CONCURRENCY=2` (прод; `.env.example` устарел на `1`). Один процесс на деплой; sweeper'ы через `setInterval` в том же процессе (без распределённых локов — при горизонтальном масштабировании переносить на BullMQ repeatable).
- **Hard-deadline:** `JOB_MAX_AGE_SECONDS=4ч` — джоба старше 4ч убивается `UnrecoverableError` без ретраев (`src/worker.ts:37-47`).

### Два sweeper'а застревания (`src/workers/pending-job-sweeper.ts`, интервал 60с)

- **stale pending** — строка в Postgres есть (`status='pending'`), но enqueue в BullMQ потерялся (Redis-hiccup). Grace 60с → re-enqueue по `jobId` (BullMQ дедуплицирует).
- **stuck processing (reclaim)** — воркер убит в середине джобы, строка застряла в `status='processing'`. `processGraceSeconds=900с (~15 мин)` → строки с `updated_at` старше 15 мин переотправляются. `processJobInner` идемпотентен.

---

## ИНЦИДЕНТ 2026-07-20: битый `.xls` вешал всю очередь

**Симптом.** Очередь встала целиком: `done` заморожен, `pending` не двигается, `processing`-джобы висят минутами с **`ocr_engine=NULL`** (значит блок **до** OCR). Concurrency=2 не спасал — застыли **оба** слота.

**Корень.** `XLSX.readFile` (sheetjs) — **синхронный**. На битом legacy `.xls` (BIFF) он зацикливается и, будучи sync, **блокирует event loop всего Node-процесса воркера**. Один такой файл останавливает всю очередь **независимо от concurrency** (concurrency — параллелизм внутри одного event loop, а он заблокирован).

**Фикс (в git, задеплоено):**
- `f956c30` — парсинг `.xls/.xlsx` вынесен в `worker_thread` (`src/pipeline/ocr/xlsx.ts`, `parseXlsxInWorker`) с `XLSX_PARSE_TIMEOUT_MS` (30с) + `terminate()`. Битый файл падает в `failed` за секунды.
- `cc168c6` — тот же гард на пути preview (`src/pipeline/ocr/xlsx-preview.ts`, `GET /jobs/:id/sheets`).

**Ручной разбор застревания (если повторится / похожий класс):**
1. Пометить зависший файл в `failed` (иначе sweeper зациклит его переотправку → рецидив):
   ```sql
   UPDATE jobs SET status='failed', error='parked: hang', finished_at=now() WHERE id=$1;
   ```
2. Очистить очередь BullMQ (стук сидит в Redis, рестарт его возвращает):
   ```bash
   ssh kb-docker "docker exec parsdocs-worker-1 node --input-type=module -e \"import('bullmq').then(async({Queue})=>{const {default:IORedis}=await import('ioredis');const c=new IORedis(process.env.REDIS_URL,{maxRetriesPerRequest:null});const q=new Queue('doc-jobs',{connection:c});await q.obliterate({force:true});await q.close();c.disconnect();process.exit(0)})\""
   ```
3. Рестарт воркера (убивает зависшее исполнение): `ssh kb-docker "docker restart parsdocs-worker-1"`.

**Диагностика (быстрые сигналы):** `done` не растёт + `processing`-джоба с `ocr_engine=NULL` висит минуты (OCR ещё не отработал = блок **до** OCR) → подозревать блок event loop, искать свежий `.xls` во входе. Иной класс: `processing` с `ocr_engine=tesseract`, висящий часами → OCR отработал, завис downstream (LLM-extract/multi-doc) — не event-loop-блок, а долгая/зависшая downstream-джоба (её добьёт reclaim/4ч-deadline).

---

## Перезапуск разбора (reprocess)

Установить `status='pending'` + очистить результат — pending-sweeper переставит в очередь:
```sql
UPDATE jobs SET status='pending', extracted=NULL, error=NULL, document_type=NULL,
  confidence=NULL, classification=NULL, started_at=NULL, finished_at=NULL,
  pipeline_steps='[]'::jsonb, last_llm_call=NULL, llm_usage=NULL, updated_at=now()
WHERE <условие>;
```
- `pipeline_steps` — NOT NULL, ставить `'[]'::jsonb`, не NULL.
- Массовый reprocess: помечать когорту маркером в **том же** UPDATE (`metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('_reprocess_batch','<имя>')`), иначе sweeper подхватит часть до тегирования (гонка).
- Если джобы стоят в BullMQ как «active/stuck» — сначала `obliterate` (см. выше), иначе рестарт вернёт их из Redis.

---

## Ловушки данных (кратко; полностью — в RUNTIME_TOPOLOGY §4)

- **`jobs.(finished_at − started_at)` ≠ латентность.** `started_at` пишется один раз (`storage/jobs.ts:450`), не сбрасывается при reclaim/ретрае → средние выходят «часы/сутки» (мусор). Мерить латентность только прямым timed-вызовом эндпоинта.
- **`ocr_engine=NULL` при `finished_at IS NOT NULL`** — reclaim'нутые/зависшие джобы; искажают агрегаты, фильтровать.
- **Где что крутится — не по имени модели**, а по `provider_settings.extra.upstream_base_url`/порту + `curl /v1/models`.
