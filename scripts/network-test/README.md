# scripts/network-test

Скелеты сценариев нагрузочного/сетевого прогона parsdocs.
Регламент: [`docs/TESTING_REGULATION.md`](../../docs/TESTING_REGULATION.md).

## Зависимости на хосте прогона

- `bash`, `curl`, `jq`, `awk`, `xargs`
- Желательно `nvidia-smi` (для GPU-метрик)
- Желательно `docker` CLI (для `docker stats`)

## Конфигурация

Скопируйте `.env.example` в `.env` и проставьте:

```bash
cp .env.example .env
$EDITOR .env
```

Минимум:
- `PARSDOCS_API_URL` — например `http://10.10.13.10:8085/api/v1`
- `PARSDOCS_TOKEN` — Bearer-токен (`pdpat_…`)
- `CORPUS_DIR` — путь к NDA-корпусу на хосте прогона (вне репо)

## Сценарии

| Скрипт | Сценарий | Регламент § |
| --- | --- | --- |
| `run-smoke.sh` | 5 файлов, последовательно | 3.1 |
| `run-load.sh` | весь корпус, конкурентность `CONCURRENCY` | 3.2 |
| `run-soak.sh` | равномерная подача `SOAK_DURATION_S` сек, rate `SOAK_RPM` док/мин | 3.3 |
| `run-stress.sh` | burst `STRESS_RPM` док/мин на `STRESS_DURATION_S` сек | 3.4 |

Все скрипты создают директорию `runs/<run_id>/` и пишут туда артефакты.

## Отчёт

```bash
./report.sh runs/<run_id>
```

Генерит `runs/<run_id>/summary.md` (p50/p95/p99, success-rate, тренд latency).
Дальше — переносим в `docs/test-runs/` по шаблону `_TEMPLATE.md`.

## Корпус

NDA-документы **не коммитим** — `corpus/.gitignore` блокирует. На сервере прогона корпус лежит по пути `$CORPUS_DIR`. Перед прогоном — фиксируем манифест:

```bash
source lib.sh && manifest_corpus > runs/<run_id>/manifest.txt
```

Состав минимального корпуса описан в [`corpus/README.md`](corpus/README.md).
