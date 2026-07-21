/**
 * Превью листов Excel для UI (GET /jobs/:id/sheets). Читаем файл тем же
 * SheetJS, что и OCR-движок, но отдаём НЕ CSV-текст, а грид ячеек по листам —
 * фронт рисует таблицы. Так оператор видит истинный источник рядом с
 * извлечением (и может ловить недоборы позиций).
 *
 * Дисплей-капы (не путать с 50k-cell OCR-гардом): ограничиваем размер ответа,
 * чтобы гигантский лист (тысячи строк) не улетел в браузер целиком. Если лист
 * обрезан — `truncated: true`, фронт показывает «показаны первые N строк».
 *
 * **Таймаут (инцидент 2026-07-20).** `XLSX.readFile` СИНХРОННЫЙ — на битом
 * legacy `.xls` виснет навсегда. Здесь это API-поток (не воркер), но битый файл,
 * открытый в превью, так же подвесил бы event loop сервера. Поэтому — тот же
 * приём, что в ocr/xlsx.ts: парсинг в worker_thread с таймаутом+terminate.
 */
import { Worker } from 'node:worker_threads';

export interface SheetPreview {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
  truncated: boolean;
}

export const PREVIEW_MAX_SHEETS = 20;
export const PREVIEW_MAX_ROWS = 300;
export const PREVIEW_MAX_COLS = 60;

/** Таймаут парсинга превью (мс). Короче OCR-таймаута — превью интерактивно. */
const PREVIEW_PARSE_TIMEOUT_MS = Number(process.env.XLSX_PREVIEW_TIMEOUT_MS) || 20_000;

/** MIME/расширения, для которых доступно превью листов. */
const SPREADSHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
]);

export function isSpreadsheet(mimeType: string, fileName: string): boolean {
  if (SPREADSHEET_MIMES.has(mimeType)) return true;
  // x-cfb — общий OLE-контейнер для legacy .xls и .doc; разводим по расширению.
  if (mimeType === 'application/x-cfb') return /\.(xls|xlsm|xlsb|xlt)$/i.test(fileName);
  return false;
}

// Тело worker'а (CommonJS, eval:true — без файла, чтобы работать в prod/dev/тестах).
// Строит грид SheetPreview[] с дисплей-капами. Капы передаём через workerData.
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const XLSX = require('xlsx');
try {
  const { filePath, maxSheets, maxRows, maxCols } = workerData;
  const wb = XLSX.readFile(filePath, { cellDates: true, cellFormula: false, cellNF: false, cellHTML: false });
  const out = [];
  for (const name of wb.SheetNames.slice(0, maxSheets)) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) { out.push({ name: name, rows: [], totalRows: 0, totalCols: 0, truncated: false }); continue; }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '', raw: false });
    const truncated = aoa.length > maxRows || totalCols > maxCols;
    const rows = aoa.slice(0, maxRows).map(function (r) {
      return r.slice(0, maxCols).map(function (c) { return (c === null || c === undefined) ? '' : String(c); });
    });
    out.push({ name: name, rows: rows, totalRows: totalRows, totalCols: totalCols, truncated: truncated });
  }
  parentPort.postMessage({ ok: true, sheets: out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
}
`;

/**
 * Читает xlsx/xls в грид по листам (с дисплей-капами), в worker_thread с
 * таймаутом. Reject при битом/зависшем файле (роут отдаёт 422). Тот же паттерн,
 * что `parseXlsxInWorker` в ocr/xlsx.ts.
 */
export function readSheetsForPreview(
  absolutePath: string,
  timeoutMs: number = PREVIEW_PARSE_TIMEOUT_MS,
): Promise<SheetPreview[]> {
  return new Promise<SheetPreview[]>((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: {
        filePath: absolutePath,
        maxSheets: PREVIEW_MAX_SHEETS,
        maxRows: PREVIEW_MAX_ROWS,
        maxCols: PREVIEW_MAX_COLS,
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
      finish(() => reject(new Error(`xlsx preview timeout after ${timeoutMs}ms (битый/зависший .xls): ${absolutePath}`)));
    }, timeoutMs);
    worker.once('message', (msg: { ok: boolean; sheets?: SheetPreview[]; error?: string }) => {
      finish(() => {
        if (msg.ok) resolve(msg.sheets ?? []);
        else reject(new Error(`xlsx preview parse failed: ${msg.error ?? 'unknown'}`));
      });
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      if (settled) return;
      finish(() => reject(new Error(`xlsx preview worker exited unexpectedly (code ${code})`)));
    });
  });
}
