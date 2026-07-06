/**
 * Развод превью документа на детальной странице по типу файла.
 *
 * Excel рендерится гридом (SheetViewer, данные с backend'а), pdf/картинки —
 * через PdfViewer (react-pdf / <img>). Word и прочий office, что не
 * рисуется картинкой, — вне scope (пока остаётся на PdfViewer, отдельный фикс).
 */
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
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
