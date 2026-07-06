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
 * «строка × колонка». Картинки в HTML не инлайнятся (base64 не тащим), но
 * собираются в буферы: для картиночных docx (скан в ворде, текста почти нет)
 * работает vision-fallback (P1-B) — крупные картинки прогоняются через
 * vision-движок и склеиваются с текстом. Гейтится config.officeImageFallback.
 *
 * Не поддерживает .doc (legacy Word 97-2003 binary) — для них нужен
 * catdoc/antiword (см. doc.ts).
 *
 * Сценарии из реального ЭДО-кейса 2026-05-18:
 *   - Акт к договору №0401-260001.docx (services_act / AKT)
 *   - Спец 1, 5 от ИП.docx (contract_specification)
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mammothPkg from 'mammoth';
const mammoth = mammothPkg;
import type { OcrEngine, OcrInput, OcrResult } from './types.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { readDocxHeadersFooters } from './docx-parts.js';
import { config } from '../../config.js';

const DOCX_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Mammoth не поддерживает .doc — для него нужен другой engine.
  // Принимаем только OOXML format.
]);

/** Защита от мегабольших docx'ов (огромных контрактов) */
const MAX_TEXT_CHARS = 500_000; // ~125k tokens — больше Qwen context window

/**
 * Отбор картинок для vision-fallback (P1-B). Чистая функция — вся рискованная
 * логика порогов/сортировки/капа здесь, чтобы юнит-тестить без реального docx.
 * Возвращает буферы ≥ minBytes, крупнейшие первыми, не более max штук.
 */
export function selectImagesForVision(
  images: Array<{ buffer: Buffer }>,
  minBytes: number,
  max: number,
): Buffer[] {
  return images
    .map((i) => i.buffer)
    .filter((b) => b.length >= minBytes)
    .sort((a, b) => b.length - a.length)
    .slice(0, Math.max(0, max));
}

/**
 * Решение о запуске vision-fallback (P1-B). Чистая функция — юнит-тестится без
 * реального docx. Триггерим при ОДНОМ из:
 *   1) текста почти нет (< minTextChars) и есть хоть одна картинка ≥ minImageKb;
 *   2) документ картинко-доминирован: есть скан-размерная картинка (≥ largeImageKb)
 *      И текста меньше «страницы» (< imageDocMaxChars) — содержание в картинке,
 *      текст лишь шапка/заголовок. Именно этот случай упускал порог по тексту
 *      (Тех.описание: 588 симв, но 582/231 KB картинки).
 * Если ни одной картинки ≥ minImageKb нет — vision не нужен (логотипы отсеяны).
 */
export function decideVisionFallback(
  textLength: number,
  imageSizes: number[],
  cfg: { minTextChars: number; minImageKb: number; largeImageKb: number; imageDocMaxChars: number },
): boolean {
  const candidates = imageSizes.filter((s) => s >= cfg.minImageKb * 1024);
  if (candidates.length === 0) return false;
  const veryThinText = textLength < cfg.minTextChars;
  const hasScanImage = candidates.some((s) => s >= cfg.largeImageKb * 1024);
  const imageDominated = hasScanImage && textLength < cfg.imageDocMaxChars;
  return veryThinText || imageDominated;
}

export class DocxEngine implements OcrEngine {
  readonly name = 'docx';
  readonly acceptanceThreshold = 0.5;

  constructor(
    private readonly visionOcr?: (imagePath: string) => Promise<{ text: string; confidence: number }>,
  ) {}

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
    // возвращает пустой src (mammoth НЕ инлайнит base64 в HTML), но
    // ПАРАЛЛЕЛЬНО собирает буферы картинок в `images` — для vision-fallback
    // на картиночных docx (P1-B).
    const images: Array<{ buffer: Buffer; contentType: string }> = [];
    const result = await mammoth.convertToHtml(
      { path: input.filePath },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          try {
            const buffer = await image.read();
            images.push({ buffer, contentType: image.contentType });
          } catch {
            /* картинку не прочитать — пропускаем */
          }
          return { src: '' };
        }),
      },
    );
    let text = htmlToMarkdown(result.value || '');

    // P2.2: колонтитулы — mammoth их не отдаёт, а реквизиты (ИНН/КПП/банк)
    // в русских договорах часто в футере. Дочитываем header/footer XML из zip
    // и приклеиваем секцией (пропуская строки, уже присутствующие в теле).
    const headersFooters = await readDocxHeadersFooters(input.filePath);
    if (headersFooters) {
      const bodyLower = text.toLowerCase();
      const extra = headersFooters
        .split('\n')
        .filter((l) => l.trim().length > 0 && !bodyLower.includes(l.trim().toLowerCase()));
      if (extra.length > 0) {
        text =
          text.length > 0
            ? `${text}\n\n=== Колонтитулы ===\n${extra.join('\n')}`
            : extra.join('\n');
      }
    }

    // P1-B: картиночный docx (скан в ворде). Триггер — decideVisionFallback:
    // либо текста почти нет, либо док картинко-доминирован (скан-картинка +
    // мало текста). Если текста достаточно и нет скан-картинки — не трогаем
    // (не жжём GPU). См. чистую функцию выше.
    const cfg = config.officeImageFallback;
    let confidence = text.length > 0 ? 1.0 : 0.0;
    if (
      cfg.enabled &&
      this.visionOcr &&
      decideVisionFallback(text.length, images.map((i) => i.buffer.length), cfg)
    ) {
      const picked = selectImagesForVision(images, cfg.minImageKb * 1024, cfg.maxImages);
      if (picked.length > 0) {
        const visionText = await this.runVision(picked);
        if (visionText.trim().length > 0) {
          text = text.length > 0
            ? `${text}\n\n=== [OCR изображений документа] ===\n${visionText}`
            : visionText;
          confidence = 0.7; // vision-derived, ниже точного чтения
        }
      }
    }

    // Защита от мегабольших: trim до limit с маркером
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) +
        `\n\n[TRUNCATED: документ длиннее ${MAX_TEXT_CHARS} chars, обрезан]`;
    }

    return {
      engine: 'docx',
      text,
      // confidence 1.0 для непустого точного чтения OOXML; 0.7 когда текст
      // получен vision-OCR картинок (вероятностный); 0.0 для пустого.
      confidence: text.length > 0 ? confidence : 0.0,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Пишет буферы во временные файлы, прогоняет каждый через vision-OCR
   * последовательно, склеивает непустые результаты. Один битый файл не роняет
   * документ (guard на каждый вызов). Временная папка чистится в finally.
   */
  private async runVision(buffers: Buffer[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'docsvc-docx-img-'));
    try {
      const texts: string[] = [];
      for (let i = 0; i < buffers.length; i++) {
        const buf = buffers[i]!;
        const ext = sniffExt(buf);
        const path = join(dir, `img-${i}.${ext}`);
        try {
          await writeFile(path, buf);
          const r = await this.visionOcr!(path);
          const t = r.text.trim();
          if (t.length > 0) texts.push(t);
        } catch {
          /* один битый кадр не роняет документ — пропускаем */
        }
      }
      return texts.join('\n\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Определяет расширение по magic-байтам. PNG / JPEG, иначе .png по умолчанию. */
function sniffExt(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  return 'png';
}
