# ТЗ: XLSX/XLS поддержка в parsdocs

> **Дата:** 2026-05-18
> **Драйвер:** Реальный VED-кейс EWL/ANJI MINGPAI — 5 из 12 файлов в комплекте поставщика приходят в `.xls/.xlsx`
> **Статус:** Draft v1

---

## 0. TL;DR

Из реального комплекта документов внешнеэкономической деятельности 40% файлов — Excel. Поставщики (особенно китайские) шлют CI, Packing List и прайс-листы в `.xls/.xlsx`. Российские службы делают внутренние сводки для таможенного оформления в Excel. **parsdocs пока умеет только PDF + image** — Excel остаётся ручной обработкой.

Это ТЗ описывает MVP добавления XLSX/XLS в OCR-цепочку. Оценка: **2-3 рабочих дня** до production.

---

## 1. Контекст и обоснование

### 1.1 Реальные xls/xlsx из VED-кейса

| Файл | Тип | Размер | Source |
|---|---|---|---|
| `MP-701-62 CI&PL.xls` | Commercial Invoice + Packing List (multi-sheet) | 47 KB | Поставщик ANJI MINGPAI |
| `Price List №13.xlsx` | Прайс-лист | 73 KB | Поставщик ANJI MINGPAI |
| `НАШИ для ТО_Mingpai.xls` | Сводный документ для ТО | 355 KB | Внутренний EWL |
| `Запчасти к креслам.xls` | Каталог запчастей (reference) | 19 MB | Поставщик |
| `Техничка офисные кресла.xlsx` | Техническое описание | 3.6 MB | Поставщик |

### 1.2 Почему важно

- **CI/PL в xls** — типовая практика китайских поставщиков. Без поддержки клиент конвертирует в PDF вручную → теряет таблицы, форматирование, точность LLM extract'а
- **Прайс-листы** в xls — единственный осмысленный формат (структурированные таблицы)
- **Multi-sheet** документы (CI на одном листе + PL на другом) — стандарт для одного PO

### 1.3 Что НЕ в скоупе этого ТЗ

- ❌ Конвертация xlsx → PDF через LibreOffice headless (тяжело, медленно, ломает таблицы)
- ❌ Извлечение картинок/штампов из xls — sheetjs их не видит
- ❌ Macro-execution (xlsm) — игнорируем все macros, парсим только листы
- ❌ Multi-document split (CI lists + PL lists в одном файле) — определяем тип по первому матчу, остальные листы идут в `_other_sheets`

---

## 2. Архитектура

### 2.1 Новый OCR engine

Добавляется `XlsxEngine` рядом с существующими (PdfTextEngine, TesseractEngine, VisionLlmEngine, YandexVisionEngine):

```typescript
// doc-service/src/pipeline/ocr/xlsx.ts
import { readFile } from 'xlsx';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

export class XlsxEngine implements OcrEngine {
  readonly name = 'xlsx';
  readonly acceptanceThreshold = 1.0; // xlsx — точное чтение, не вероятностное

  supportsMimeType(mime: string): boolean {
    return mime === 'application/vnd.ms-excel'
        || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || mime === 'application/vnd.ms-excel.sheet.macroEnabled.12';
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const t0 = Date.now();
    const workbook = readFile(input.filePath, {
      cellDates: true,    // даты как Date, не serial number
      cellFormula: false, // computed values, не формулы
      cellNF: false,
    });

    const sections: string[] = [];
    let totalCells = 0;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (sheet['!hidden']) continue;

      // Защита от мегабольших sheets (19MB каталог)
      const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
      const cells = range ? (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) : 0;
      if (cells > 50_000) {
        sections.push(`=== Sheet: ${sheetName} ===\n[SKIPPED: ${cells} cells > 50k limit]`);
        continue;
      }

      const csv = XLSX.utils.sheet_to_csv(sheet, {
        blankrows: false,
        FS: ',',
        RS: '\n',
        strip: true,
      });
      sections.push(`=== Sheet: ${sheetName} ===\n${csv}`);
      totalCells += cells;
    }

    return {
      engine: 'xlsx',
      text: sections.join('\n\n'),
      confidence: 1.0, // exact read
      durationMs: Date.now() - t0,
      metadata: { sheets: workbook.SheetNames.length, total_cells: totalCells },
    };
  }
}
```

**Почему CSV per sheet:**
- LLM (Qwen 2.5 VL 32B, любая) хорошо понимает CSV — это структурированный табличный формат с явными границами строк/колонок
- Markdown tables были бы красивее, но `sheet_to_csv` нативный в sheetjs (без потери данных), а markdown потребовал бы custom-конвертер
- Если sheet содержит merged cells, sheetjs кладёт значение в master-cell, остальные становятся пустыми — это правильное поведение для LLM
- Section header `=== Sheet: %name% ===` даёт LLM context для multi-sheet файлов (CI на 1, PL на 2)

### 2.2 Изменения в существующем pipeline

| Файл | Изменение |
|---|---|
| `doc-service/package.json` | + `"xlsx": "^0.18.5"`, + `"file-type": "^19.6"` |
| `doc-service/src/pipeline/ocr/xlsx.ts` | новый (~80 строк) |
| `doc-service/src/pipeline/ocr/types.ts` | `OcrEngineName` enum + `'xlsx'` |
| `doc-service/src/pipeline/orchestrator.ts` | `new XlsxEngine()` в engines array |
| `doc-service/src/pipeline/router.ts` | роутинг xls/xlsx → XlsxEngine only |
| `doc-service/src/routes/jobs.ts` | accepted MIME-types: + `application/vnd.ms-excel`, + `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `doc-service/src/storage/magic-bytes.ts` | XLS sig `D0 CF 11 E0 A1 B1 1A E1`, XLSX через `file-type` (zip-based) |
| `doc-service/migrations/...23_xlsx_engine_metric.sql` | (опц.) расширить `ocr_engine` enum в БД |

### 2.3 Magic-bytes валидация

Сейчас magic-bytes валидатор принимает только PDF / image. Добавляем:

| MIME | Signature | Method |
|---|---|---|
| `application/vnd.ms-excel` (.xls) | `D0 CF 11 E0 A1 B1 1A E1` | byte-prefix match |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (.xlsx) | `50 4B 03 04` + zip-content sniff | через `file-type` npm package |

Из-за того что xlsx — это zip, простой prefix-match даёт false-positives (любой zip пройдёт). Используем `file-type` библиотеку — она читает первые байты zip и проверяет `[Content_Types].xml` для xlsx detection.

### 2.4 OCR chain routing

В `router.ts` для xls/xlsx mime — **только** XlsxEngine, без fallback на tesseract/vision (бессмысленно). Если XlsxEngine упал (corrupt file), job → status `failed`.

```typescript
if (input.mimeType.startsWith('application/vnd.ms-excel') ||
    input.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  return [engines.find((e) => e.name === 'xlsx')!];
}
```

---

## 3. Edge cases

### 3.1 Большие xlsx (>5MB, >50,000 cells)

Каталог запчастей (19MB, потенциально 100k+ ячеек) — это **reference data**, не транзакционный документ. На LLM такой объём гнать бессмысленно.

**Поведение:** XlsxEngine читает первые N cells per sheet (limit 50k), остальные skip с пометкой `[SKIPPED: N cells > 50k limit]`. Sheet не пропускается целиком — даже урезанный header даёт classifier'у достаточно сигнала чтобы определить тип.

### 3.2 Multi-sheet файлы

`MP-701-62 CI&PL.xls` имеет 2 листа: Sheet1=Commercial Invoice, Sheet2=Packing List. Single-doc strategy:

- Все sheets конкатенируются с `=== Sheet: %name% ===` headers
- Classifier работает на полном тексте — пожжог по сумме сигналов от обоих sheets
- Если document_hint указан клиентом (например `commercial_invoice`) — overrides classify
- В extracted кладём всё в один объект; если нужны разные документы — клиент шлёт 2 раза

**Этот подход:**
- Минимально-инвазивный (один job = один extracted)
- Совместимый с существующим F5 multi-doc skeleton (когда дойдёт до production — splitter может разрезать xlsx по sheets как PDF по страницам)

### 3.3 Hidden sheets

В xlsx бывают скрытые служебные sheets (templates, configs). Skip их через `sheet['!hidden']`.

### 3.4 Encoding (legacy .xls с CP1251)

sheetjs auto-detects encoding в xls (BIFF8) — кириллица читается корректно. Тест: `MP-701-62 CI&PL.xls` (Author: phoenix, codepage 1251) должен читаться без mojibake.

### 3.5 Дата-серриалы (Excel epoch)

Excel хранит даты как serial numbers (43831 = 2020-01-01). Опция `cellDates: true` в sheetjs автоматически конвертирует в `Date` объекты, которые `sheet_to_csv` сериализует в ISO-формат. Регуляция:

- `2020-01-01` (date) → `"2020-01-01"` в CSV ✓
- `2020-01-01 12:34:56` (datetime) → `"2020-01-01T12:34:56.000Z"` ✓

LLM поймёт оба варианта.

### 3.6 Formulas vs values

`cellFormula: false` заставляет sheetjs давать **результаты** формул, не исходники. Это то что нужно — клиент видит вычисленные суммы, не `=SUM(B2:B30)`.

### 3.7 Merged cells

Если в xlsx есть merged-region (например title через A1:F1), sheetjs кладёт значение в A1, остальные ячейки region — пустые. CSV получит:
```
"Commercial Invoice",,,,,
"No. MP-701-62","Date: 24.12.2025",,,,
"Item","Qty","Price"
```

Это нормально для LLM — пустые ячейки игнорируются, заголовки видятся как контекст.

---

## 4. Тестирование

### 4.1 Unit tests

`tests/ocr-xlsx.spec.ts`:
1. Простой xlsx с одним sheet → text содержит section header + CSV
2. Multi-sheet xlsx → все sheets с headers
3. Hidden sheet → пропускается
4. Большой sheet (>50k cells) → header + `[SKIPPED]` marker
5. Legacy .xls c CP1251 → кириллица читается корректно
6. Corrupt file → throws с понятным error
7. Дата как Date-object → ISO в CSV

Fixture файлы — копии из `~/Desktop/Доки/` + 1-2 synthetic edge cases.

### 4.2 Integration smoke

После deploy на kb-docker:
1. `MP-701-62 CI&PL.xls` → classify должен дать `commercial_invoice` или `packing_list` (multi-sig, любой OK)
2. `Price List №13.xlsx` → `price_list`
3. `НАШИ для ТО.xls` → unknown (это внутренняя сводка, не имеет четкого type signature) — но job не должен крашить, OCR должен пройти, classifier вернёт null

### 4.3 E2E с LLM extract

Прогон через Qwen 2.5 VL 32B (`10.10.28.10`):
1. CI/PL → должны вытаскиваться поля seller/buyer/items/total
2. Price List → currency, supplier, items[] первые 50 позиций

Latency: для xlsx 50 KB OCR ~200 мс (sheetjs быстрый), LLM extract как для PDF (~30-90 сек на 32B).

---

## 5. Backward compatibility

- ✅ Существующие PDF/image jobs не затрагиваются
- ✅ UI v2 (`/ui/upload`) — `accept` атрибут расширяется добавлением `.xls,.xlsx,application/vnd.ms-excel,...`
- ✅ Webhook payload не меняется — `extracted` имеет тот же контракт
- ✅ `ocr_engine` поле получит новое значение `xlsx` (метрики поддерживают cardinality)

---

## 6. Open questions

1. **Прайс-лист на 5000 позиций** — extract'им первые 50 или режем по логике? Решение: первые 50 + `_truncated: true` flag в metadata. Клиент может попросить дополнительный прогон со sheet-level фильтром.

2. **xlsm (с macros)** — принимаем как xlsx, macros игнорируются. Конкретно стоит ли отдельный MIME-validator: `application/vnd.ms-excel.sheet.macroEnabled.12` — обычно у российских клиентов из 1С.

3. **doc-service/UI/upload** — accept-types update тривиально, но dropzone иконка для xlsx (vs PDF/image) — нужно ли? Decision: показывать всем как `<svg>` иконкой документа, mime в metadata, label `file_type`.

4. **CSV vs TSV vs JSON для intermediate text** — для CI/PL с цифрами, TSV меньше escape'ит. Решение: оставляем CSV (sheetjs дефолт), переходим на TSV если будут проблемы с числами content'ящими запятые (например `1,234.56`).

---

## 7. Сроки и план

| День | Что |
|---|---|
| День 1 | XlsxEngine + magic-bytes + unit tests |
| День 2 | Integration в orchestrator, router, routes/jobs. Build, deploy, smoke |
| День 3 | Полировка edge cases, E2E с реальными xls/xlsx из VED-кейса, документация |

Итого **2-3 дня** до production-ready.

---

## 8. Зависимости

- npm `xlsx` v0.18+ — sheetjs CE, MIT license, поддержка xls (BIFF8) + xlsx (OOXML)
- npm `file-type` v19+ — для MIME detection в magic-bytes validator

Обе библиотеки — open source, корп.политике не противоречат, никаких API calls к третьим сторонам.

---

## 9. Связано

- [PARSDOCS_REQUIREMENTS_TZ.md](PARSDOCS_REQUIREMENTS_TZ.md) — общее ТЗ интеграции
- migration 0022 — VED document_types (где зарегистрированы commercial_invoice, packing_list, price_list)
- Реальные образцы: `~/Desktop/Доки/MP-701-62 CI&PL.xls`, `Price List №13.xlsx`, `НАШИ для ТО.xls`
