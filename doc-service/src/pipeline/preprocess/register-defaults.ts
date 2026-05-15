/**
 * Регистрация default-handler'ов при запуске worker'а.
 *
 * Порядок ВАЖЕН — handlers проверяются по очереди, первый matching берёт
 * файл. Специфичные форматы (HEIC по magic, EML по headers) должны
 * перехватывать ДО общих image/PDF handlers.
 *
 * Сейчас зарегистрирован только HEIC. По мере реализации добавляются:
 *   - EML / MSG (email с вложениями)
 *   - ZIP / RAR / 7Z (архивы)
 *   - DOCX / XLSX (через sidecar unoserver, опционально)
 *   - PDF (с error handling для encrypted/corrupted)
 *   - Multi-page TIFF splitter
 *   - Generic image (JPG / PNG / BMP / WebP — pass-through)
 */

import { preprocessRegistry } from './registry.js';
import { HeicHandler } from './heic.js';

let registered = false;

export function registerDefaultHandlers(): void {
  if (registered) return;
  registered = true;
  preprocessRegistry.register(new HeicHandler());
  // … TODO: EmlHandler, ZipHandler, DocxHandler, PdfHandler, TiffMultipageHandler
}
