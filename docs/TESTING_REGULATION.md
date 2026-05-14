# Регламент нагрузочного и сетевого тестирования parsdocs

> **Статус:** v0.1, draft. Числа порогов (`TBD`) проставляются после первого baseline-прогона.
> **Применимость:** все релизы перед раскаткой в корп. песочницу `10.10.13.10`.
> **Запуск:** только локальный backend (Ollama), реальные корп. документы — на сервере, NDA-корпус **не коммитим в git**.

---

## 1. Цели

1. Получить воспроизводимую картину поведения `doc-service + inference-service + Ollama` под нагрузкой реальных документов.
2. Зафиксировать SLA (p50/p95/p99 latency, throughput, success-rate) — отдельно для каждого типа документа.
3. Поймать регрессии между релизами (обязательное условие приёмки релиза).
4. Проверить корректность защитных механизмов: `JOB_DEADLINE`, `RATE_LIMIT`, multi API-key (`API_KEYS_JSON`), webhook-доставка.

Регламент **не** заменяет accuracy-evaluation (`npm run eval` по golden-set) — это про скорость и стабильность, а не про правильность извлечённых полей.

---

## 2. Окружение прогона

Перед каждым прогоном фиксируем (заносим в отчёт `docs/test-runs/<date>-<tag>.md`):

| Параметр | Источник |
| --- | --- |
| Git SHA | `git rev-parse HEAD` |
| Ветка / тег релиза | `git describe --all --long` |
| Хост | `10.10.13.10` (по умолчанию) |
| GPU | `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv` |
| CPU / RAM | `lscpu`, `free -h` |
| Версия Docker / Compose | `docker version`, `docker compose version` |
| `BACKEND` | из `inference-service/.env` (должен быть `openai_compat`) |
| Модель | `OPENAI_MODEL` (например `qwen2.5vl:7b`) |
| `OLLAMA_PULL` | из `docker-compose.local-models.yml` env |
| Конкурентность doc-service воркеров | `WORKER_CONCURRENCY` / `NUM_WORKERS` |
| `JOB_DEADLINE_MS`, `RATE_LIMIT_*` | из `doc-service/.env` |
| Корпус | `runs/<run_id>/manifest.txt` (sha256 + size каждого файла) |

Снапшот окружения сохраняется автоматически скриптом `scripts/network-test/lib.sh::snapshot_env`.

---

## 3. Сценарии

Все сценарии запускаются из `scripts/network-test/`. Артефакты прогона складываются в `scripts/network-test/runs/<run_id>/` (`run_id` = `YYYYMMDD-HHMMSS-<scenario>`).

### 3.1 Smoke

**Назначение:** быстрая проверка после деплоя — pipeline жив, Ollama отвечает, очередь работает.

- Документов: первые **5** из корпуса, по одному из разных типов.
- Конкурентность: **1** (последовательно).
- Время прогона: **≤ 3 минуты**.
- Скрипт: `run-smoke.sh`.

**Pass-критерии:**
- `5/5` job в статусе `done` или `needs_review`.
- Ни один job не упал в `failed`.
- E2E latency каждого ≤ `JOB_DEADLINE_MS`.

### 3.2 Load (номинал)

**Назначение:** замер throughput и latency при ожидаемой ежедневной нагрузке.

- Документов: **полный корпус** (или подвыборка ≥ 100 файлов с типовым распределением).
- Конкурентность: `CONCURRENCY` (default **4**, подбирается под GPU).
- Скрипт: `run-load.sh`.

**Снимаем:**
- p50 / p95 / p99 end-to-end latency, в разрезе типа документа.
- Throughput (док/мин).
- Success-rate.
- Распределение по статусам (`done` / `needs_review` / `failed`).
- Метрики Ollama (GPU util, VRAM из `nvidia-smi dmon`).

**Pass-критерии:**
- Success-rate (`done` + `needs_review`) ≥ **95 %**.
- p95 E2E latency ≤ **TBD сек** (фиксируется после baseline + 20 %).
- Throughput ≥ **TBD док/мин** (baseline − 10 %).

### 3.3 Soak (выносливость)

**Назначение:** ловим утечки памяти Ollama, рост latency, накопление зависших job.

- Длительность: **2 часа** (короткий) или **8 часов** (релизный).
- Подача: равномерная, target rate = **50 % от Load throughput**.
- Скрипт: `run-soak.sh`.

**Снимаем:**
- Тренд p95 latency по 15-минутным бакетам.
- Память Ollama (`docker stats parsdocs-ollama`) — minute snapshots.
- Размер очереди BullMQ (через `/metrics/operational`).
- Disk usage `file_storage/`.

**Pass-критерии:**
- p95 latency последнего часа ≤ p95 первого часа × **1.15**.
- Память Ollama: рост ≤ **TBD MB/час** (baseline + запас).
- Очередь возвращается к 0 в течение **2 × JOB_DEADLINE_MS** после остановки подачи.
- 0 job в статусе `processing` старше `JOB_DEADLINE_MS` после прогона.

### 3.4 Stress (запреш-нагрузка)

**Назначение:** проверка защитных механизмов — rate-limit, job-deadline, backpressure.

- Подача: **150 %** от Load throughput, **15 минут**.
- Скрипт: `run-stress.sh`.

**Pass-критерии:**
- doc-service отвечает (не падает в crash-loop, healthcheck `200`).
- При исчерпании лимитов: HTTP **429**, не `5xx`.
- Job старше `JOB_DEADLINE_MS` корректно переводятся в `failed` с понятной ошибкой.
- Нет потерь: количество принятых `202` = количество терминальных статусов после остановки подачи.

---

## 4. Метрики и источники данных

| Метрика | Источник | Где смотреть |
| --- | --- | --- |
| Job lifecycle (created → done) | doc-service Postgres (`jobs.created_at`, `completed_at`) | `GET /api/v1/jobs/:id` |
| Сводка за окно (latency, LLM, throughput) | doc-service | `GET /api/v1/metrics/operational?window=1h` |
| Prometheus metrics | doc-service / inference-service | `:9100/metrics`, `:9101/metrics` (см. `docker-compose.monitoring.yml`) |
| Очередь BullMQ | Redis | `docker compose exec redis redis-cli LLEN bull:jobs:wait` |
| GPU util / VRAM | host | `nvidia-smi dmon -s u -c <N>` |
| RAM контейнеров | host | `docker stats --no-stream` |

Скрипты собирают всё это в `runs/<run_id>/`:

```
runs/<run_id>/
  manifest.txt          # sha256+size каждого файла корпуса
  env.txt               # snapshot окружения
  jobs.csv              # submit_ts, job_id, file, size, status, ttl_ms, e2e_ms
  ollama-stats.csv      # ts, cpu_pct, mem_mb, gpu_pct, vram_mb
  ops-metrics-pre.json  # snapshot /metrics/operational до прогона
  ops-metrics-post.json # после
  summary.md            # сгенерирован report.sh
```

---

## 5. Pass/Fail и эскалация

- Все Pass-критерии сценария = **PASS**.
- Один и более Fail = **FAIL**, релиз не катим, заводим запись в `TECH_DEBT.md`.
- Если падают `TBD` критерии до фиксации baseline — это сам baseline-прогон, фиксируем числа в этом регламенте PR'ом.

---

## 6. Чек-лист подготовки сервера

1. `git pull` нужного релиза в `/opt/parsdocs/` (или эквивалент).
2. `cp inference-service/.env.example inference-service/.env`, проставить `BACKEND=openai_compat` + `OPENAI_BASE_URL=http://ollama:11434/v1`.
3. `docker compose -f docker-compose.doc-platform.yml -f docker-compose.local-models.yml up -d`.
4. Дождаться `ollama-bootstrap` (он pull'ит модель — может быть долго на холодном кэше).
5. Прогнать `run-smoke.sh` — если PASS, переходим к нужному сценарию.
6. Скопировать NDA-корпус в `$CORPUS_DIR` (вне репо). Запустить `lib.sh manifest_corpus` для фиксации хешей.
7. Запустить целевой сценарий.

---

## 7. Чек-лист после прогона

1. `scripts/network-test/report.sh runs/<run_id>` — генерит `summary.md`.
2. Скопировать `summary.md` в `docs/test-runs/<date>-<tag>.md` (шаблон: `_TEMPLATE.md`).
3. Снять скрины Grafana (если включена) за окно прогона — приложить в `docs/test-runs/`.
4. Если PASS: коммит отчёта в ветку релиза, тег прогона в commit message.
5. Если FAIL: завести запись в `TECH_DEBT.md`, прикрепить `summary.md` и логи, не катить релиз.

---

## 8. Хранение и ретеншн

- NDA-корпус: **только на сервере**, путь `/opt/parsdocs-corpus/` (или равноценный), `chmod 700`. В git не коммитим — `scripts/network-test/corpus/.gitignore` это закрывает.
- Артефакты прогонов (`runs/`): хранить 90 дней, потом архивировать.
- Отчёты (`docs/test-runs/*.md`): хранятся в git постоянно — это и есть журнал.

---

## 9. История регламента

| Версия | Дата | Изменения |
| --- | --- | --- |
| 0.1 | TBD | Первоначальная версия, числа в Pass-критериях помечены `TBD` до baseline. |
