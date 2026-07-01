/**
 * DOC OCR engine — legacy Word 97-2003 (.doc, OLE Compound Binary) → plain text.
 *
 * `.doc` детектится `file-type` как `application/x-cfb` — тот же контейнер,
 * что и legacy `.xls`. Разводим по extension: XlsxEngine берёт `.xls*`,
 * этот движок — `.doc`. mammoth (DocxEngine) читает только OOXML `.docx` и
 * на `.doc` падает, поэтому нужен отдельный бинарный конвертер.
 *
 * Конвертер: `catdoc` (Debian-пакет, ~200 KB) — читает WinWord-бинарь,
 * знает cp1251 → кириллица не ломается. Лёгкий по сравнению с libreoffice.
 * Устанавливается в Dockerfile (apt: catdoc). Если бинаря нет — isAvailable
 * вернёт false и движок скипнется (job упадёт на "all OCR engines failed"
 * как раньше, без регресса).
 *
 * Извлечённый текст идёт в тот же downstream: classify → extract → validate,
 * ровно как docx/xlsx.
 */
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

const execP = promisify(exec);
const execFileP = promisify(execFile);

/** x-cfb + расширение .doc → legacy Word. Точечное правило, не трогает .xls. */
const DOC_MIMES = new Set(['application/x-cfb', 'application/msword']);

/** Защита от мегабольших doc'ов. ~125k tokens — больше context window. */
const MAX_TEXT_CHARS = 500_000;

export class DocEngine implements OcrEngine {
  readonly name = 'doc' as const;
  // Точное бинарное чтение (не вероятностный OCR) — низкий threshold, чтобы
  // первый же движок в цепочке accept'нул и остальные скипнулись.
  readonly acceptanceThreshold = 0.5;

  // Кэш проверки наличия catdoc (один probe на процесс).
  private available: boolean | null = null;

  supports(input: OcrInput): boolean {
    if (!DOC_MIMES.has(input.mimeType)) return false;
    // native msword — берём. x-cfb — только если extension .doc (иначе это .xls).
    if (input.mimeType === 'application/x-cfb') {
      return /\.doc$/i.test(input.filePath);
    }
    return true;
  }

  isAvailable(): boolean {
    if (this.available !== null) return this.available;
    // Синхронной проверки нет — считаем доступным, реальный probe в run().
    // Если catdoc не установлен, run() бросит и оркестратор перейдёт к
    // следующему движку (для .doc следующего нет → all engines failed).
    // Помечаем true оптимистично; фактическую доступность даёт Dockerfile.
    this.available = true;
    return this.available;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const t0 = Date.now();
    let text = '';
    try {
      // catdoc -w: без переносов строк по ширине; -d utf-8: вывод в UTF-8.
      const { stdout } = await execFileP(
        'catdoc',
        ['-w', '-d', 'utf-8', input.filePath],
        { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      );
      text = (stdout || '').trim();
    } catch (err) {
      // catdoc отсутствует / упал → пробуем antiword как запасной (если стоит).
      try {
        const { stdout } = await execP(
          `antiword -m UTF-8.txt "${input.filePath}"`,
          { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
        );
        text = (stdout || '').trim();
      } catch {
        // Оба конвертера недоступны/упали — пробрасываем понятную ошибку,
        // оркестратор пойдёт дальше по цепочке (для .doc — конец → failed).
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`doc engine: catdoc failed (${msg})`);
      }
    }

    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) +
        `\n\n[TRUNCATED: документ длиннее ${MAX_TEXT_CHARS} chars, обрезан]`;
    }

    return {
      engine: 'doc',
      text,
      // Точное чтение бинаря, не вероятностный OCR.
      confidence: text.length > 0 ? 1.0 : 0.0,
      durationMs: Date.now() - t0,
    };
  }
}
