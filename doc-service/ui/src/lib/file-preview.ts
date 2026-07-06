/**
 * Развод превью документа на детальной странице по типу файла.
 *
 * Office-файлы (Excel И Word) рендерятся фототочно через сконвертированный
 * backend'ом PDF (GET /jobs/:id/preview-pdf) в общем PdfViewer'е. Обычные
 * pdf/картинки — тоже PdfViewer (react-pdf / <img>). isExcelPreview остаётся
 * как fallback: если конвертация Excel в PDF не удалась, показываем грид
 * (SheetViewer), чтобы данные были видны всегда.
 */
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
]);

const WORD_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

// x-cfb — обобщённый OLE-контейнер (старый .xls, но и .doc). Считаем Excel'ем
// только когда расширение имени файла явно табличное.
const XLS_EXTENSIONS = ['.xls', '.xlsm', '.xlsb', '.xlt'];

export function isExcelPreview(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (EXCEL_MIMES.has(mime)) return true;
  if (mime === 'application/x-cfb') {
    const name = (fileName ?? '').toLowerCase();
    return XLS_EXTENSIONS.some((ext) => name.endsWith(ext));
  }
  return false;
}

export function isWordPreview(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): boolean {
  const mime = (mimeType ?? '').toLowerCase();
  if (WORD_MIMES.has(mime)) return true;
  if (mime === 'application/x-cfb') {
    const name = (fileName ?? '').toLowerCase();
    return name.endsWith('.doc');
  }
  return false;
}

/**
 * Office-файл (Excel ИЛИ Word) — превью идёт через сконвертированный PDF.
 * Для x-cfb расширение имени определяет ветку: .xls* → Excel, .doc → Word.
 */
export function isOfficePreview(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): boolean {
  return isExcelPreview(mimeType, fileName) || isWordPreview(mimeType, fileName);
}
