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
 * **Таймаут (инцидент 2026-07-20).** `XLSX.readFile` СИНХРОННЫЙ. На битом
 * legacy `.xls` (BIFF) sheetjs может зациклиться навсегда — и, будучи sync,
 * блокирует event loop ВСЕГО воркера: один такой файл застопорил всю очередь,
 * concurrency не спасала (застыли все слоты). Поэтому парсинг уводится в
 * worker_thread с таймаутом+terminate (как tesseract-бинарь с SIGKILL):
 * зависший файл падает в `failed` за `XLSX_PARSE_TIMEOUT_MS`, а не вешает
 * процесс. Воркер — inline eval:true CJS (без отдельного файла, чтобы работать
 * одинаково в prod/dev/тестах; путь к .ts/.js модулю в worker_thread иначе
 * разъезжается между окружениями).
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
import { Worker } from 'node:worker_threads';
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

/**
 * Таймаут парсинга одного xls/xlsx (мс). Битый BIFF-.xls виснет синхронно —
 * без таймаута он вешает воркер навсегда. Дефолт 30с: с запасом на большие
 * легитимные книги, но убивает настоящие зависания. env-override.
 */
const XLSX_PARSE_TIMEOUT_MS = Number(process.env.XLSX_PARSE_TIMEOUT_MS) || 30_000;

/** Результат парсинга из worker'а. */
interface ParseOut {
  text: string;
  pages: Array<{ text: string; confidence: number }>;
}

// Тело worker'а (CommonJS, eval:true). Переводы строк передаём через workerData
// (`NL`), а не литералами — чтобы в этой строке не было ни `\n`-эскейпов, ни
// backtick/`${}`, и она безопасно жила внутри template literal.
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');
try {
  const { filePath, maxCells, NL } = workerData;
  const wb = XLSX.readFile(filePath, { cellDates: true, cellFormula: false, cellNF: false, cellHTML: false });
  const sections = [];
  const pages = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    let cellCount = 0;
    try { const r = XLSX.utils.decode_range(sheet['!ref']); cellCount = (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1); } catch (e) { cellCount = 0; }
    if (cellCount > maxCells) { sections.push('=== Sheet: ' + name + ' ===' + NL + '[SKIPPED: ' + cellCount + ' cells > ' + maxCells + ' limit]'); continue; }
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, FS: ',', RS: NL, strip: true });
    if (csv.trim().length === 0) continue;
    const section = '=== Sheet: ' + name + ' ===' + NL + csv;
    sections.push(section);
    pages.push({ text: section, confidence: 1.0 });
  }
  parentPort.postMessage({ ok: true, text: sections.join(NL + NL), pages });
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
}
`;

/**
 * Парсит xls/xlsx в worker_thread с таймаутом. Экспортируется для теста
 * таймаут-пути. Битый/зависший файл → reject('timeout'), не вешает процесс.
 */
export function parseXlsxInWorker(
  filePath: string,
  maxCells: number,
  timeoutMs: number,
): Promise<ParseOut> {
  return new Promise<ParseOut>((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { filePath, maxCells, NL: '\n' },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`xlsx parse timeout after ${timeoutMs}ms (битый/зависший .xls): ${filePath}`)),
      );
    }, timeoutMs);
    worker.once('message', (msg: { ok: boolean; text?: string; pages?: ParseOut['pages']; error?: string }) => {
      finish(() => {
        if (msg.ok) resolve({ text: msg.text ?? '', pages: msg.pages ?? [] });
        else reject(new Error(`xlsx parse failed: ${msg.error ?? 'unknown'}`));
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      if (settled) return;
      finish(() => reject(new Error(`xlsx worker exited unexpectedly (code ${code})`)));
    });
  });
}

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
    // Парсинг в worker_thread с таймаутом: битый sync-.xls не вешает воркер.
    const { text, pages } = await parseXlsxInWorker(
      input.filePath,
      MAX_CELLS_PER_SHEET,
      XLSX_PARSE_TIMEOUT_MS,
    );
    return {
      engine: 'xlsx',
      text,
      // confidence 1.0 — точное чтение. 0 если пусто.
      confidence: text.length > 0 ? 1.0 : 0.0,
      // F5: per-sheet pages для multi-doc detection в orchestrator.
      pages,
      durationMs: Date.now() - t0,
    };
  }
}
