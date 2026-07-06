/**
 * Превью листов Excel для UI (GET /jobs/:id/sheets). Читаем файл тем же
 * SheetJS, что и OCR-движок, но отдаём НЕ CSV-текст, а грид ячеек по листам —
 * фронт рисует таблицы. Так оператор видит истинный источник рядом с
 * извлечением (и может ловить недоборы позиций).
 *
 * Дисплей-капы (не путать с 50k-cell OCR-гардом): ограничиваем размер ответа,
 * чтобы гигантский лист (тысячи строк) не улетел в браузер целиком. Если лист
 * обрезан — `truncated: true`, фронт показывает «показаны первые N строк».
 */
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg;

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

/** Читает xlsx/xls в грид по листам (с дисплей-капами). Бросает при битом файле. */
export function readSheetsForPreview(absolutePath: string): SheetPreview[] {
  const wb = XLSX.readFile(absolutePath, {
    cellDates: true,
    cellFormula: false,
    cellNF: false,
    cellHTML: false,
  });
  const out: SheetPreview[] = [];
  for (const name of wb.SheetNames.slice(0, PREVIEW_MAX_SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) {
      out.push({ name, rows: [], totalRows: 0, totalCols: 0, truncated: false });
      continue;
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    // header:1 → array-of-arrays; raw:false → форматированные строки (даты как текст);
    // blankrows:false → выкидываем полностью пустые строки; defval:'' → дыры пустой строкой.
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    });
    const truncated = aoa.length > PREVIEW_MAX_ROWS || totalCols > PREVIEW_MAX_COLS;
    const rows = aoa
      .slice(0, PREVIEW_MAX_ROWS)
      .map((r) =>
        (r as unknown[])
          .slice(0, PREVIEW_MAX_COLS)
          .map((c) => (c === null || c === undefined ? '' : String(c))),
      );
    out.push({ name, rows, totalRows, totalCols, truncated });
  }
  return out;
}
