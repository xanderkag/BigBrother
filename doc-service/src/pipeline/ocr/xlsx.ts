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
import type { OcrEngine, OcrInput, OcrResult, OcrTable } from './types.js';

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

/**
 * SPEED-2 (2026-07-21, SheetCompressor-стиль): дедуп повторяющихся длинных
 * ячеек при сериализации. Замер боевого 128КБ .xls: 38% документа — ячейки,
 * повторённые ≥5 раз (производитель ×156, его адрес ×116, категория ×48).
 * Такие значения выносятся в словарь секции (@N = значение), в строках
 * остаётся @N — вход LLM короче на треть без потери информации (по
 * SpreadsheetLLM сжатие точность ПОВЫШАЕТ). Страховка от протаскивания @N
 * в extracted — детерминированный разворот в normalize (xlsx-ref-expand).
 * XLSX_DEDUP_MAX_ENTRIES=0 выключает механизм целиком.
 */
const XLSX_DEDUP_MIN_COUNT = Number(process.env.XLSX_DEDUP_MIN_COUNT) || 5;
const XLSX_DEDUP_MIN_LEN = Number(process.env.XLSX_DEDUP_MIN_LEN) || 15;
const XLSX_DEDUP_MAX_ENTRIES = process.env.XLSX_DEDUP_MAX_ENTRIES === '0'
  ? 0
  : Number(process.env.XLSX_DEDUP_MAX_ENTRIES) || 60;

/**
 * XLSX-FAST: сколько ячеек максимум отдаём наружу структурой (суммарно по книге).
 * Матрица нужна, чтобы разложить позиции кодом вместо 20+ вызовов модели, но
 * тащить через postMessage каталог на миллион ячеек незачем — выше лимита
 * структуру просто не отдаём и работает прежний текстовый путь.
 */
const MAX_TABLE_CELLS_TOTAL = Number(process.env.XLSX_MAX_TABLE_CELLS) || 200_000;

/** Результат парсинга из worker'а. */
interface ParseOut {
  text: string;
  pages: Array<{ text: string; confidence: number }>;
  /** XLSX-FAST: матрицы листов (могут отсутствовать — см. MAX_TABLE_CELLS_TOTAL). */
  tables?: OcrTable[];
}

// Тело worker'а (CommonJS, eval:true). Переводы строк передаём через workerData
// (`NL`), а не литералами — чтобы в этой строке не было ни `\n`-эскейпов, ни
// backtick/`${}`, и она безопасно жила внутри template literal.
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');
try {
  const { filePath, maxCells, maxTableCells, NL, dedupMinCount, dedupMinLen, dedupMaxEntries } = workerData;
  const CR = String.fromCharCode(13);
  const QUOTE = String.fromCharCode(34);
  const wb = XLSX.readFile(filePath, { cellDates: true, cellFormula: false, cellNF: false, cellHTML: false });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet || !sheet['!ref']) continue;
    let cellCount = 0;
    try { const r = XLSX.utils.decode_range(sheet['!ref']); cellCount = (r.e.r - r.s.r + 1) * (r.e.c - r.s.c + 1); } catch (e) { cellCount = 0; }
    if (cellCount > maxCells) { sheets.push({ name, skipped: cellCount }); continue; }
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
    sheets.push({ name, matrix });
  }
  // SPEED-2: частоты длинных строковых ячеек по всей книге -> словарь @N.
  const dict = new Map();
  if (dedupMaxEntries > 0) {
    const freq = new Map();
    for (const s of sheets) {
      if (!s.matrix) continue;
      for (const row of s.matrix) for (const cell of row) {
        if (typeof cell === 'string') {
          const v = cell.trim();
          if (v.length >= dedupMinLen) freq.set(v, (freq.get(v) || 0) + 1);
        }
      }
    }
    const cand = [];
    for (const e of freq) { if (e[1] >= dedupMinCount) cand.push(e); }
    cand.sort((a, b) => (b[1] - 1) * b[0].length - (a[1] - 1) * a[0].length);
    cand.slice(0, dedupMaxEntries).forEach((e, i) => dict.set(e[0], '@' + (i + 1)));
  }
  const esc = (v) => {
    const s = String(v == null ? '' : v).trim();
    return (s.indexOf(',') !== -1 || s.indexOf(QUOTE) !== -1 || s.indexOf(NL) !== -1 || s.indexOf(CR) !== -1)
      ? QUOTE + s.split(QUOTE).join(QUOTE + QUOTE) + QUOTE
      : s;
  };
  const sections = [];
  const pages = [];
  for (const s of sheets) {
    if (s.skipped) { sections.push('=== Sheet: ' + s.name + ' ===' + NL + '[SKIPPED: ' + s.skipped + ' cells > ' + maxCells + ' limit]'); continue; }
    const usedRefs = new Map();
    const lines = [];
    for (const row of s.matrix) {
      const cells = [];
      for (const cell of row) {
        let v = cell;
        if (typeof cell === 'string') {
          const t = cell.trim();
          const ref = dict.get(t);
          if (ref) { usedRefs.set(ref, t); v = ref; }
        }
        cells.push(esc(v));
      }
      const line = cells.join(',');
      if (line.split(',').join('').trim().length > 0) lines.push(line);
    }
    if (lines.length === 0) continue;
    let legend = '';
    if (usedRefs.size > 0) {
      const legendLines = [];
      for (const e of usedRefs) legendLines.push(e[0] + ' = ' + e[1]);
      legend = '[Словарь повторов листа: @N — сокращение повторяющегося значения, при извлечении подставляй полное значение]' + NL + legendLines.join(NL) + NL;
    }
    const section = '=== Sheet: ' + s.name + ' ===' + NL + legend + lines.join(NL);
    sections.push(section);
    pages.push({ text: section, confidence: 1.0 });
  }
  // XLSX-FAST: отдаём наружу и саму матрицу (строки × колонки) — по ней парсер
// разложит позиции кодом вместо 20+ вызовов модели. Значения БЕЗ @N-сокращений
// (dict применяется только к тексту выше), поэтому раскладка идёт по исходным.
// Выше лимита ячеек структуру не отдаём — работает прежний текстовый путь.
var tables = [];
var tableCells = 0;
for (var ti = 0; ti < sheets.length; ti++) {
  var sh = sheets[ti];
  if (sh.skipped || !sh.matrix) continue;
  var rowsOut = [];
  for (var ri = 0; ri < sh.matrix.length; ri++) {
    var srcRow = sh.matrix[ri];
    var cellsOut = [];
    for (var ci = 0; ci < srcRow.length; ci++) {
      cellsOut.push(String(srcRow[ci] == null ? '' : srcRow[ci]).trim());
    }
    tableCells += cellsOut.length;
    if (tableCells > maxTableCells) { rowsOut = null; break; }
    rowsOut.push(cellsOut);
  }
  if (rowsOut === null) { tables = null; break; }
  if (rowsOut.length > 0) tables.push({ sheet: sh.name, rows: rowsOut });
}
parentPort.postMessage({ ok: true, text: sections.join(NL + NL), pages, tables: tables || undefined });
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
      workerData: {
        filePath,
        maxCells,
        maxTableCells: MAX_TABLE_CELLS_TOTAL,
        NL: '\n',
        dedupMinCount: XLSX_DEDUP_MIN_COUNT,
        dedupMinLen: XLSX_DEDUP_MIN_LEN,
        dedupMaxEntries: XLSX_DEDUP_MAX_ENTRIES,
      },
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
    worker.once(
      'message',
      (msg: {
        ok: boolean;
        text?: string;
        pages?: ParseOut['pages'];
        tables?: OcrTable[];
        error?: string;
      }) => {
        finish(() => {
          if (msg.ok) {
            resolve({ text: msg.text ?? '', pages: msg.pages ?? [], tables: msg.tables });
          } else reject(new Error(`xlsx parse failed: ${msg.error ?? 'unknown'}`));
        });
      },
    );
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
    const { text, pages, tables } = await parseXlsxInWorker(
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
      // XLSX-FAST: структура таблиц для быстрой раскладки позиций (см. OcrTable).
      tables,
      durationMs: Date.now() - t0,
    };
  }
}
