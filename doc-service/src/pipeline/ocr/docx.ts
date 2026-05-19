/**
 * DOCX OCR engine — конвертирует Word документ в plain text для
 * feeding в classifier + LLM extract.
 *
 * Использует mammoth — npm-пакет, читает .docx (Office Open XML).
 * Извлекает чистый текст без styling. Структура (parag breaks, lists,
 * tables) сохраняется через `\n` separator'ы — этого хватает LLM
 * чтобы понять разделы документа.
 *
 * Не поддерживает .doc (legacy Word 97-2003 binary) — для них нужен
 * libreoffice/antiword. Если редко встречаются — клиент конвертирует
 * вручную в .docx или PDF.
 *
 * Сценарии из реального ЭДО-кейса 2026-05-18:
 *   - Акт к договору №0401-260001.docx (services_act / AKT)
 *   - Спец 1, 5 от ИП.docx (contract_specification)
 */
import mammothPkg from 'mammoth';
const mammoth = mammothPkg;
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Mammoth не поддерживает .doc — для него нужен другой engine.
  // Принимаем только OOXML format.
]);

/** Защита от мегабольших docx'ов (огромных контрактов) */
const MAX_TEXT_CHARS = 500_000; // ~125k tokens — больше Qwen context window

export class DocxEngine implements OcrEngine {
  readonly name = 'docx';
  readonly acceptanceThreshold = 0.5;

  supports(input: OcrInput): boolean {
    return DOCX_MIMES.has(input.mimeType);
  }

  isAvailable(): boolean {
    return true;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const t0 = Date.now();
    // mammoth.extractRawText читает docx и возвращает plain text +
    // массив messages (warnings про неподдерживаемые элементы, не
    // блокирующие).
    const result = await mammoth.extractRawText({ path: input.filePath });
    let text = result.value || '';

    // Защита от мегабольших: trim до limit с маркером
    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      truncated = true;
      text = text.slice(0, MAX_TEXT_CHARS) +
        `\n\n[TRUNCATED: документ длиннее ${MAX_TEXT_CHARS} chars, обрезан]`;
    }

    return {
      engine: 'docx',
      text,
      // confidence 1.0 для непустого — это точное чтение через OOXML XML,
      // не вероятностное OCR на изображении.
      confidence: text.length > 0 ? 1.0 : 0.0,
      durationMs: Date.now() - t0,
    };
  }
}
