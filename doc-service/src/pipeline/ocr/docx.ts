/**
 * DOCX OCR engine — конвертирует Word документ в markdown-текст для
 * feeding в classifier + LLM extract.
 *
 * Использует mammoth (читает .docx / Office Open XML) → HTML, затем свой
 * узкий HTML→Markdown конвертер (`html-to-markdown.ts`). До 2026-07-02
 * использовался `extractRawText`, который ПЛЮЩИЛ таблицы в поток строк
 * (ячейки склеивались через `\n`, колонки исчезали) — на ВЭД-доках с
 * таблицами это резало fill (SDS-доки батча 232 давали 4 бизнес-поля).
 * Теперь таблицы отдаются pipe-таблицами (`| a | b |`) — LLM видит
 * «строка × колонка». Картинки в docx на этом шаге отбрасываются
 * (base64 не тащим); vision-fallback для картиночных docx — P1-B.
 *
 * Не поддерживает .doc (legacy Word 97-2003 binary) — для них нужен
 * catdoc/antiword (см. doc.ts).
 *
 * Сценарии из реального ЭДО-кейса 2026-05-18:
 *   - Акт к договору №0401-260001.docx (services_act / AKT)
 *   - Спец 1, 5 от ИП.docx (contract_specification)
 */
import mammothPkg from 'mammoth';
const mammoth = mammothPkg;
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import { htmlToMarkdown } from './html-to-markdown.js';

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
    // mammoth.convertToHtml читает docx → HTML (сохраняет структуру таблиц),
    // затем свой конвертер → markdown (таблицы pipe'ами). convertImage-хук
    // возвращает пустой src, чтобы mammoth НЕ инлайнил base64 картинок
    // (мы их всё равно отбрасываем; экономим память на картиночных docx).
    const result = await mammoth.convertToHtml(
      { path: input.filePath },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
    );
    let text = htmlToMarkdown(result.value || '');

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
