# Test run — <YYYY-MM-DD> — <tag>

> Скопируйте этот шаблон в `docs/test-runs/<YYYY-MM-DD>-<tag>.md` и заполните по итогам прогона.
> Источник цифр: `scripts/network-test/runs/<run_id>/summary.md`.

## Окружение

- **Git SHA:** `…`
- **Ветка/тег:** `…`
- **Хост:** 10.10.13.10 (или иной — указать)
- **GPU:** `…` (модель, VRAM, driver)
- **CPU / RAM:** `…`
- **Backend:** `openai_compat → ollama`
- **Модель:** `qwen2.5vl:7b` (или иная — указать)
- **doc-service:** `WORKER_CONCURRENCY=…`, `JOB_DEADLINE_MS=…`, `RATE_LIMIT_*=…`
- **Корпус:** `<N>` файлов, sha256-манифест в `runs/<run_id>/manifest.txt`

## Сценарии

### Smoke
- Результат: PASS / FAIL
- Job-ов: N/5
- E2E latency (max): `…` сек

### Load
- Документов: N
- Конкурентность: K
- Throughput: `…` док/мин
- E2E latency: p50 `…` / p95 `…` / p99 `…` сек
- Success-rate: `…` %
- В разрезе типов: см. `runs/<run_id>/summary.md`

### Soak
- Длительность: `…` ч
- Тренд p95 (1-й час → последний час): `…` → `…` сек (rate `×…`)
- Память Ollama: start `…` MB → end `…` MB (рост `…` MB/ч)
- Очередь после остановки подачи опустошилась за: `…` сек

### Stress
- Burst: `…` % от Load
- HTTP 429 / 5xx: `…` / `…`
- Job переведённых в `failed` по deadline: `…`
- Потери (accepted − terminal): `…`

## Pass / Fail

- **Smoke:** …
- **Load:** …
- **Soak:** …
- **Stress:** …
- **Общий вердикт:** PASS / FAIL

## Выводы и ToDo

- …
- …

## Артефакты

- `runs/<run_id>/jobs.csv`
- `runs/<run_id>/ollama-stats.csv`
- `runs/<run_id>/ops-metrics-pre.json` / `…-post.json`
- Скрины Grafana: `docs/test-runs/<date>-<tag>-grafana-*.png`
