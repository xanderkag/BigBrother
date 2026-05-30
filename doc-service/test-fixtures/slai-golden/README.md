# SLAI Golden Test Fixtures

> **Назначение:** реальные документы (анонимизированные при необходимости) +
> ground-truth JSON для замера accuracy parsdocs extractor'а на распределении
> SLAI. Используется для AC замера из `SLAI_TZ_v1` (Q9) и AC §B.4 из EXT-LINE
> request 2026-05-29.

---

## Source / канал передачи

Канал — **PR в этот репозиторий**, в эту директорию. SLAI шлёт PR с PDF +
парные `.gt.json`. Версионируется, видно git-blame по каждому исправлению
ground-truth.

**Альтернатива:** Я.Диск ссылка → положим вручную с commit-message
`fixtures(slai-golden): batch N from Я.Диск <date>`.

## Структура

```
slai-golden/
├── README.md                 ← этот файл
├── maritime/                 ← морские/мультимодал (для container_no, bl_no)
│   ├── 001-msc-shanghai.pdf
│   ├── 001-msc-shanghai.gt.json
│   ├── 002-cma-rotterdam.pdf
│   └── ...
├── international-auto/       ← междунар. авто (для cmr_no)
│   └── ...
├── customs-broker/           ← счета брокеров (для declaration_no)
│   └── ...
└── domestic-auto/            ← внутр. авто с ТТН (для ttn_no)
    └── ...
```

## Состав (ожидаемый, от SLAI 2026-06-02..04)

| Категория | Кол-во PDF | Целевое AC | Что покрывает |
|-----------|------------|------------|---------------|
| Морские/мультимодал | 5 | `container_no` ≥80%, `bl_no` ≥70% | EXT-LINE P0 |
| Международные авто | 3 | `cmr_no` ≥70% | EXT-LINE P1 |
| Таможенные брокеры | 3 | `declaration_no` ≥80% | EXT-LINE P1 |
| Внутренние авто (ТТН) | 2 | `ttn_no` ≥70% | EXT-LINE P2 |
| **Итого** | **13** | | |

Плюс на каждом — регрессия по базовым: `vehicle_plate` ≥90%, `trip_date` ≥80%.

## Формат `.gt.json` (ground-truth)

Один файл на PDF, имя совпадает (`001-msc-shanghai.pdf` → `001-msc-shanghai.gt.json`).
Содержит ожидаемые значения по контракту parsdocs `ExtractedDocument v1`:

```jsonc
{
  "document_type": "invoice",
  "number": "MSC-2026-04-117",
  "date": "2026-04-15",
  "total": 285000,
  "vat_total": 47500,
  "seller": { "name": "MSC Russia LLC", "inn": "7707012345" },
  "buyer":  { "name": "ООО Импортер", "inn": "5006012345" },
  "period_from": "2026-04-01",
  "period_to": "2026-04-30",
  "contract_no": "Д-2026-417",
  "contract_date": "2026-01-10",
  "items": [
    {
      "name": "Фрахт MSC SHANGHAI/Vladivostok",
      "qty": 1,
      "price": 285000,
      "vat_rate": 20,
      "vat_amount": 47500,
      "total_with_vat": 285000,
      "container_no": "MSCU1234567",
      "bl_no": "MEDUH7654321",
      "route_from": "Shanghai",
      "route_to": "Vladivostok",
      "trip_date": "2026-04-12"
    }
  ]
}
```

Поля, которых в документе физически НЕТ — пропускать (не писать `null`), чтобы
diff показывал явно «модель добавила лишнее» vs «модель не нашла нужное».

## Runner

После accumulation первого batch'а — eval-скрипт прогонит каждый PDF через
prod-конфиг (Qwen-VL 32B vision + LLM extract) и посчитает:
- Per-field precision/recall/F1 по `.gt.json` vs `.extracted.json`
- Aggregated по категориям и по полям
- Сравнение с AC порогами из EXT-LINE §B.4

См. `doc-service/scripts/eval/run-golden.ts` (TBD — добавим после первого batch'а).

## PII / 152-ФЗ

SLAI договорились что **не анонимизируют** — наш `redact_pii` гард уберёт
паспорта/телефоны при необходимости, и **30d ETL** в `file_cleanup` удалит
оригиналы. Если конкретный PDF содержит особо чувствительные данные —
SLAI может пометить в `.gt.json`:

```jsonc
{ "_pii_sensitive": true, ... }
```

И мы добавим его в `.gitignore` (только `.gt.json` остаётся, сам PDF на
S3/MinIO с TTL).

## Статус

- 2026-05-29: директория создана. Ждём первый batch от SLAI (ETA 2026-06-02..04
  по `PARSDOCS_REPLY_TO_FOLLOWUP_2026-05-29.md` §Q9).
