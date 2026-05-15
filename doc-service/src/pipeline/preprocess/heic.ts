/**
 * HEIC handler — конвертация iPhone-фото в JPG до основного pipeline.
 *
 * Apple HEIC/HEIF — основной формат iPhone начиная с iOS 11. Tesseract
 * и pdf-parse его не понимают, поэтому без явной конвертации файл
 * отлетал бы по 415 на whitelist.
 *
 * Стратегия:
 *   1. Magic-bytes check: `....ftypheic` или `....ftypheix` / `....ftypmif1`
 *   2. spawn `heif-convert input.heic /tmp/converted.jpg -q 92`
 *   3. Возвращаем 1 страницу с путём к JPG — дальше обычный pipeline
 *      (Tesseract OCR + extract).
 *
 * Edge cases:
 *   - **Live Photo / HDR**: HEIC может содержать 2 кадра (main + still).
 *     `heif-convert` без флагов вытаскивает main — нам этого хватает.
 *   - **HEIC encrypted**: реально не встречается в потоке документов,
 *     не обрабатываем (просто упадёт `heif-convert` с ошибкой → CONVERSION_FAILED).
 *   - **HEIC с EXIF GPS**: после конвертации EXIF переходит в JPG. Если включён
 *     `STRIP_EXIF_ON_UPLOAD` — в дальнейшем зачищается отдельным шагом.
 *
 * Зависимости: `libheif-examples` (heif-convert binary, ~5 МБ к Docker image).
 * Установка в Dockerfile через apt-get.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FormatHandler, PreprocessInput, PreprocessResult } from './types.js';

/**
 * Magic-bytes HEIC файла. На позиции 4-7 находится `ftyp`, далее brand:
 *   - `heic` — обычное iPhone-фото
 *   - `heix` — HEIC с extension
 *   - `mif1` — HEIF base
 *   - `msf1` — HEIF Image Sequence
 *   - `heim`, `heis`, `hevm`, `hevs` — другие HEIF variants
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']);

async function isHeic(filePath: string): Promise<boolean> {
  try {
    const head = await readFile(filePath, { flag: 'r' });
    // ftyp box: смещение 4-7 = 'ftyp', 8-11 = brand
    if (head.length < 12) return false;
    const ftyp = head.subarray(4, 8).toString('ascii');
    if (ftyp !== 'ftyp') return false;
    const brand = head.subarray(8, 12).toString('ascii').toLowerCase();
    return HEIC_BRANDS.has(brand);
  } catch {
    return false;
  }
}

export class HeicHandler implements FormatHandler {
  readonly name = 'heic';

  detect(input: PreprocessInput): boolean {
    // Дешёвая проверка по MIME / extension. Полная — через magic-bytes
    // в process() поскольку detect() синхронный по контракту.
    if (input.detectedMime === 'image/heic' || input.detectedMime === 'image/heif') {
      return true;
    }
    const lower = input.fileName.toLowerCase();
    return lower.endsWith('.heic') || lower.endsWith('.heif');
  }

  async process(input: PreprocessInput): Promise<PreprocessResult> {
    // Двойная проверка через magic-bytes — на случай если detectedMime
    // соврал (например файл назвали .heic но это JPG)
    if (!(await isHeic(input.filePath))) {
      return {
        kind: 'error',
        code: 'UNSUPPORTED_FORMAT',
        message: 'Файл назван HEIC, но содержимое не похоже на HEIF',
        details: { detected_mime: input.detectedMime },
      };
    }

    // Готовим временную папку. Cleanup orchestrator делает в общем finally;
    // на нашей стороне отдельный cleanup не нужен — tmp очищается ОС / cron.
    const tempDir = await mkdtemp(join(tmpdir(), 'parsdocs-heic-'));
    const outputPath = join(tempDir, 'converted.jpg');

    try {
      await runHeifConvert(input.filePath, outputPath);
    } catch (err) {
      return {
        kind: 'error',
        code: 'CONVERSION_FAILED',
        message: `Не удалось конвертировать HEIC в JPG: ${(err as Error).message}`,
        details: { source: input.fileName },
      };
    }

    return {
      kind: 'pages',
      pages: [
        {
          index: 0,
          imagePath: outputPath,
          pageNumber: 1,
        },
      ],
      meta: {
        originalFormat: 'heic',
        convertedTo: 'jpg',
        converter: 'libheif heif-convert',
      },
    };
  }
}

/**
 * Запускает `heif-convert <in> <out> -q 92`. Quality 92 — баланс между
 * размером и читаемостью текста OCR'ом. Ниже 85 — Tesseract начинает
 * терять confidence на мелком тексте.
 */
function runHeifConvert(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('heif-convert', ['-q', '92', inputPath, outputPath]);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      reject(new Error(`heif-convert spawn error: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`heif-convert exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
