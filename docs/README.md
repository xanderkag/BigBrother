# docs — путеводитель (кросс-сервисные доки)

> Доки уровня всего проекта BigBrother/parsedocs: испытания моделей,
> файловый приём, inference-backend, регламенты. Доки **сервиса** SLAI-интеграции
> и реестр типов — в [`../doc-service/docs/`](../doc-service/docs/README.md).
> Обновлено: 2026-06-02.

## Модели и испытания

| Док | О чём |
|---|---|
| [`TESTS_INDEX.md`](TESTS_INDEX.md) | **Единая точка входа во все тесты**: выбор модели, сводные таблицы (bench v2/v3), хронология прогонов |
| [`MODEL_REPORT.md`](MODEL_REPORT.md) | Детальные данные каждого прогона (#2–35) |
| [`BENCH_V3_PLAN.md`](BENCH_V3_PLAN.md) | План bench v3: большие модели на 96 ГБ VRAM |
| [`BENCH_REAL_DOCS.md`](BENCH_REAL_DOCS.md) | Сводный отчёт по бенчу на реальных документах |

**Победитель (bench v3):** Mistral Small 3.1 24B — поля 98.3%, `total` 100%, ~5 с/файл, ~15 ГБ.

## Инфраструктура и приём файлов

| Док | О чём |
|---|---|
| [`GPU_MIGRATION.md`](GPU_MIGRATION.md) | Миграция parsdocs на GPU-хост (96 ГБ, `10.10.33.10`) |
| [`INFERENCE_BACKEND_TZ.md`](INFERENCE_BACKEND_TZ.md) | parsdocs как потребитель OpenAI-совместимого LLM-backend (инстанс «slai») — *не путать с ERP-интеграцией SLAI* |
| [`FILE_INTAKE_OVERVIEW.md`](FILE_INTAKE_OVERVIEW.md) | Обзор «что и зачем» приёма разнородных входящих файлов |
| [`FILE_TYPES_SPEC.md`](FILE_TYPES_SPEC.md) | Детальная спецификация по каждому формату (как детектируем/обрабатываем) |

## Регламенты

| Док | О чём |
|---|---|
| [`TESTING_REGULATION.md`](TESTING_REGULATION.md) | Регламент нагрузочного и сетевого тестирования |
| [`test-runs/_TEMPLATE.md`](test-runs/_TEMPLATE.md) | Шаблон записи прогона |

## Доки сервиса SLAI-интеграции

Статус интеграции, реестр типов документов, очередь вопросов, ТЗ —
в [`../doc-service/docs/`](../doc-service/docs/README.md).
