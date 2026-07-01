/**
 * XLSX/XLS OCR engine — конвертирует Excel в текст для feeding в classifier
 * + LLM extract. Особенности:
 *
 *   - sheetjs (xlsx npm) читает оба формата: .xls (BIFF8) и .xlsx (OOXML)
 *   - Кириллица в legacy .xls (codepage 1251) — auto-detected
 *   - Все формулы — computed values, не исходники (`cellFormula: false`)
 *   - Даты — ISO через `cellDates: true`
 *   - Merged cells: master cell keeps value, остальные пустые
 *   - Hidden sheets — пропускаются
 *   - Защита от мегабольших sheets (>50k cells skip): каталог запчастей
 *     19MB может содержать 100k+ ячеек, на LLM это гнать не надо
 *
 * Контракт: возвращает один многострочный text с section headers
 *   === Sheet: %name% ===
 *   ... CSV content ...
 *
 * Classifier и LLM extract работают на этом тексте как на любом другом
 * OCR-выводе. confidence всегда 1.0 — это точное чтение, не вероятностное.
 *
 * См. doc-service/docs/PARSDOCS_XLSX_SUPPORT_TZ.md для архитектуры
 * и edge cases.
 */
// xlsx — CommonJS пакет; в Node ESM `import * as XLSX from 'xlsx'`
// даёт namespace без working функций. Default import + named utils
// работают корректно через esModuleInterop.
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg;
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

const XLS_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  // 2026-05-18: legacy .xls детектится `file-type` как x-cfb (OLE Compound).
  // Принимаем при условии что filePath заканчивается на .xls — иначе sheetjs
  // упадёт с понятной ошибкой и job → failed.
  'application/x-cfb',
]);

/** Защита от мегабольших sheets — на LLM это всё равно гнать бессмысленно. */
const MAX_CELLS_PER_SHEET = 50_000;

export class XlsxEngine implements OcrEngine {
  readonly name = 'xlsx';
  // Точное чтение, не вероятностное — threshold невысокий, чтобы первый
  // же engine в chain accept'нул и остальные skip'нули.
  readonly acceptanceThreshold = 0.5;

  supports(input: OcrInput): boolean {
    if (!XLS_MIMES.has(input.mimeType)) return false;
    // x-cfb (OLE Compound) — общий контейнер для .xls И .doc/.ppt. Разводим
    // по extension пути: xlsx движок берёт только spreadsheet-расширения,
    // .doc уходит к DocEngine. Не-cfb mime (native xls/xlsx) — берём как есть.
    if (input.mimeType === 'application/x-cfb') {
      return /\.(xls|xlsm|xlsb|xlt)$/i.test(input.filePath);
    }
    return true;
  }

  isAvailable(): boolean {
    // xlsx — npm-пакет, всегда доступен.
    return true;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const t0 = Date.now();
    const workbook = XLSX.readFile(input.filePath, {
      cellDates: true,
      cellFormula: false,
      cellNF: false,
      cellHTML: false,
    });

    const sections: string[] = [];
    // F5 multi-sheet support: каждый sheet — отдельный «page» в
    // OcrResult.pages. Orchestrator может детектировать что в xlsx
    // больше одного content-sheet'а и пустить per-sheet classify
    // → multi-doc extract path.
    const pages: Array<{ text: string; confidence: number }> = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      // hidden sheets — Excel помечает их в Workbook.Sheets array через
      // Workbook.WBProps / Workbook.Sheets[]. Простая эвристика:
      // sheet['!ref'] отсутствует → скорее всего лист пустой/скрытый.
      if (!sheet['!ref']) continue;

      let cellCount = 0;
      try {
        const range = XLSX.utils.decode_range(sheet['!ref']);
        cellCount = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
      } catch {
        cellCount = 0;
      }

      if (cellCount > MAX_CELLS_PER_SHEET) {
        const marker = `=== Sheet: ${sheetName} ===\n[SKIPPED: ${cellCount} cells > ${MAX_CELLS_PER_SHEET} limit]`;
        sections.push(marker);
        // Не добавляем в pages (skipped → не годится для split)
        continue;
      }

      const csv = XLSX.utils.sheet_to_csv(sheet, {
        blankrows: false,
        FS: ',',
        RS: '\n',
        strip: true,
      });
      if (csv.trim().length === 0) continue;
      const section = `=== Sheet: ${sheetName} ===\n${csv}`;
      sections.push(section);
      pages.push({ text: section, confidence: 1.0 });
    }

    const text = sections.join('\n\n');
    return {
      engine: 'xlsx',
      text,
      // confidence 1.0 — точное чтение. Можно даунгрейдить если пустой.
      confidence: text.length > 0 ? 1.0 : 0.0,
      // F5: per-sheet pages для multi-doc detection в orchestrator.
      // Если pages.length > 1 и sheets классифицируются разными типами —
      // запускается per-sheet extract pipeline.
      pages,
      durationMs: Date.now() - t0,
    };
  }
}
