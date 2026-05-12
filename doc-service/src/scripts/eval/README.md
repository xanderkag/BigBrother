# Golden-set eval harness

Цель: автоматически замерить **качество извлечения** на наборе эталонных
документов и получить одну сводную картинку (точность / полнота /
скорость / стоимость) для каждого прогона пайплайна. Без него
«улучшения» получаются на глаз; с ним — мы видим число до/после
любого изменения (новый промпт, другая модель, иная цепочка OCR).

## Запуск

```bash
# 1. Подготовить набор: положить файлы и описать ожидания
cp src/scripts/eval/golden-set.example.json ./eval/golden-set.json
# отредактировать: указать instance, token, project_id, fixtures

# 2. Прогнать
npm run eval -- --golden-set ./eval/golden-set.json

# 3. С сохранением полного JSON-отчёта и CI-режимом
npm run eval -- \
  --golden-set ./eval/golden-set.json \
  --out ./eval/last-report.json \
  --max-parallel 2 \
  --fail-on-mismatch
```

Параметры:

| Флаг | Описание |
| --- | --- |
| `--golden-set <path>` | обязательный, путь до JSON c фикстурами |
| `--out <path>` | записать полный отчёт (per-fixture + per-field) |
| `--max-parallel <n>` | сколько фикстур заливать параллельно (1..16, по умолчанию 1) |
| `--fail-on-mismatch` | exit 1 если хоть одна фикстура не прошла — для CI |

## Формат golden-set.json

```jsonc
{
  "instance": "http://localhost:3000",
  "token": "pdpat_…",
  "project_id": "…",              // опц.
  "poll": { "interval_ms": 2000, "timeout_ms": 300000 },
  "fixtures": [
    {
      "id": "ttn-001",
      "file": "./samples/ttn-001.pdf",   // относительно golden-set.json
      "document_type_hint": "ttn",       // опц., прокидывается как document_hint
      "metadata": { "source": "smoke" }, // опц.
      "expected": {
        "document_type": "ttn",          // опц., классификатор должен совпасть
        "terminal_status": "done",       // опц., done | needs_review
        "no_issues": true,               // опц., validation_issues должен быть пустым
        "max_total_duration_ms": 60000,  // опц., SLA на эту фикстуру
        "fields": [
          { "path": "carrier.inn", "expected": "7707083893" },
          { "path": "total", "expected": 125000.50 },
          { "path": "loading_date", "expected": "2026-04-12" },
          { "path": "vehicle.plate", "expected": "А123ВВ77", "kind": "plate" }
        ]
      }
    }
  ]
}
```

### path

Dot-path внутри `extracted`. Поддерживаются вложенные объекты и индексы
массивов: `positions.0.qty`, `carrier.inn`. На корневые поля — просто
имя: `total`, `currency`.

### expected

Любое JSON-значение. Сравнение делается компаратором (см. ниже),
который понимает форматные различия (1234,56 ≈ 1234.56 ≈ "1 234.56 ₽").

### kind

Компаратор. Если не задан — выбирается автоматически по имени поля
(см. `compare.ts:inferKind`). Возможные значения:

| Kind | Что нормализуется |
| --- | --- |
| `string` | NFKC, casefold, trim, нормализация пробелов и пунктуации |
| `money` | принимает `1234.56`, `"1 234,56 ₽"`, `1234`. Tolerance ±0.01 |
| `percent` | принимает `20`, `"20%"`, `0.2`. Tolerance ±0.01 п.п. |
| `date` | ISO `YYYY-MM-DD` или `DD.MM.YYYY`/`DD/MM/YYYY` → нормализуется в ISO |
| `inn`, `kpp`, `account` | сравнение по цифрам |
| `plate` | uppercase + без пробелов и дефисов |
| `country` | ISO 3166 alpha-2, uppercase |
| `integer` | сравнение по округлённому до целого |
| `number` | произвольное число, tolerance ±0.01 |

## Метрики, которые считаются

### Качество (per-fixture)

- **classification_match** — `expected.document_type` совпал с фактическим
  определением.
- **field verdicts**: каждое ожидаемое поле получает один из:
  - `match` — значение нормализовано-равно
  - `mismatch` — значение есть, но не то
  - `missing` — значение `null`/`undefined`/`""`

### Качество (агрегаты)

- **classification_accuracy** = доля фикстур с `classification_match=true`,
  среди тех где `expected.document_type` задан.
- **field_coverage** = (match + mismatch) / total — какую долю
  ожидаемых полей пайплайн вообще извлёк.
- **field_exact_match** = match / total — какую долю он извлёк
  правильно. **Главная метрика качества.**
- **needs_review_rate**, **failed_rate** — статусы.
- **validation_issue_rate** — доля jobs с непустыми `validation_issues`.

### Скорость

- **latency_p50_ms / p95_ms** — round-trip от `POST /jobs` до
  терминального статуса. Включает время ожидания в очереди — это
  ровно то, что видит клиент.

### Стоимость

- **tokens_p95_in / out** — из `last_llm_call`. P95, не среднее, потому
  что хвост важнее (бюджет сжигается на больших документах).
- **llm_fallback_rate** — доля jobs, где сработал LLM-extract (а не
  пустой builtin parser).

## Как интерпретировать

Хорошие пороги для прода (по нашему опыту, можно ужесточить позже):

| Метрика | Цель | Тревога |
| --- | --- | --- |
| classification_accuracy | ≥ 0.95 | < 0.90 |
| field_exact_match | ≥ 0.85 | < 0.75 |
| field_coverage | ≥ 0.95 | < 0.90 |
| needs_review_rate | < 0.20 | > 0.40 |
| failed_rate | < 0.01 | > 0.05 |
| latency_p95 | < 60 с | > 120 с |

Регрессия после изменения пайплайна — это **любое падение field_exact_match
больше чем на 2 п.п.** Это правило blocker для деплоя.

## CI

```yaml
- run: npm run eval -- --golden-set ./eval/ci.json --fail-on-mismatch
```

`--fail-on-mismatch` даст exit 1 если в любой фикстуре есть
mismatch/missing/SLA-breach. На CI-инстансе golden-set обычно
маленький (5-10 документов), под прод-replay'ем — большой (50+).
