/**
 * Фототочное превью office-файлов: конвертируем xls/xlsx/doc/docx → PDF через
 * headless LibreOffice и показываем в готовом PDF-просмотрщике UI. Даёт верный
 * рендер (объединённые ячейки, ширины, шрифты, цвета) — в отличие от грид-
 * превью (`/sheets`), которое остаётся как «данные».
 *
 * Кеш: конвертация дорогая (~1-4 с, первый запуск LO ещё дольше), поэтому
 * результат кладём в <STORAGE_DIR>/preview-cache/<key>.pdf и переиспользуем.
 * Ключ = file_sha256 (байт-в-байт тот же файл → тот же PDF) или job.id fallback.
 *
 * Конкурентность: каждый вызов — свой UserInstallation-профиль во временной
 * папке (без общего профиля LO-инстансы дерутся за него и падают). Таймаут +
 * SIGKILL — LO иногда виснет на битых файлах.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { config } from '../../config.js';

const execFileP = promisify(execFile);

const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  // OLE-контейнер — legacy .xls или .doc; расширение берём из file_name.
  'application/x-cfb',
]);

/** Можно ли сконвертировать этот файл в PDF-превью через LibreOffice. */
export function isOfficePreviewable(mimeType: string): boolean {
  return OFFICE_MIMES.has(mimeType);
}

/** Расширение для LibreOffice: он выбирает фильтр импорта по нему. */
function deriveExt(fileName: string, mimeType: string): string {
  const m = /\.(xlsx|xls|xlsm|xlsb|xlt|docx|doc)$/i.exec(fileName);
  if (m) return m[1]!.toLowerCase();
  // Fallback по mime, если у сохранённого файла нет расширения.
  if (mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel')) return 'xlsx';
  if (mimeType.includes('wordprocessingml')) return 'docx';
  if (mimeType === 'application/msword') return 'doc';
  return 'xls';
}

function cachePathFor(key: string): string {
  // key = sha256 (64 hex) или job-uuid — оба безопасны как имя файла.
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(config.storageDir, 'preview-cache', `${safe}.pdf`);
}

/**
 * Конвертирует office-файл в PDF (с кешем). Возвращает путь к готовому PDF.
 * Бросает, если LibreOffice упал/завис/не выдал файл.
 */
export async function officeToPdf(
  srcAbsPath: string,
  cacheKey: string,
  fileName: string,
  mimeType: string,
  timeoutMs = 90_000,
): Promise<string> {
  const cached = cachePathFor(cacheKey);
  try {
    await stat(cached);
    return cached; // hit
  } catch {
    /* miss — конвертируем */
  }

  const work = await mkdtemp(join(tmpdir(), 'lo-conv-'));
  try {
    // Копируем исходник с ПРАВИЛЬНЫМ расширением — LO выбирает фильтр по нему,
    // а сохранённый файл может лежать под uuid без расширения.
    const ext = deriveExt(fileName, mimeType);
    const inPath = join(work, `in.${ext}`);
    await copyFile(srcAbsPath, inPath);

    const profile = join(work, 'profile');
    await execFileP(
      'libreoffice',
      [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to',
        'pdf',
        '--outdir',
        work,
        inPath,
      ],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // LO трогает HOME — даём временный, чтобы не писать в /home/node.
        env: { ...process.env, HOME: work },
      },
    );

    const outPdf = join(work, 'in.pdf');
    await stat(outPdf); // убеждаемся, что PDF реально создан

    await mkdir(dirname(cached), { recursive: true });
    await copyFile(outPdf, cached);
    return cached;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
