import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, mkdtemp, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join, basename, dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { fileTypeFromFile } from 'file-type';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config, type Config } from '../config.js';

export type SaveStreamInput = {
  filename?: string;
  mimeType: string;
  stream: Readable;
};

export type SavedFile = {
  storageId: string;
  fileName: string;
  absolutePath: string;
  mimeType: string;
  size: number;
};

/**
 * Materialized file = что-то на локальном диске, доступное для чтения
 * sync-движкам OCR (tesseract, pdftoppm, pdf-parse). Local backend
 * возвращает оригинальный путь (cleanup — no-op). S3 backend стримит
 * объект в tmp и возвращает путь к нему (cleanup — unlink).
 */
export type MaterializedFile = {
  absolutePath: string;
  cleanup: () => Promise<void>;
};

export interface FileStorage {
  saveStream(input: SaveStreamInput): Promise<SavedFile>;
  materialize(absolutePath: string): Promise<MaterializedFile>;
  remove(absolutePath: string): Promise<boolean>;
}

/**
 * Local filesystem storage. Files land in `<STORAGE_DIR>/uploads/<storageId>/<fileName>`.
 * Per-job directory keeps the multi-page artefacts (debug/per-page) co-located later.
 *
 * The S3/MinIO implementation shares the SaveStreamInput/SavedFile types
 * so swapping is a single-line change in the route handler.
 */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly baseDir: string) {}

  async saveStream(input: SaveStreamInput): Promise<SavedFile> {
    const storageId = randomUUID();
    const safeName = sanitize(input.filename ?? `upload${guessExt(input.mimeType)}`);
    const dir = join(this.baseDir, 'uploads', storageId);
    await mkdir(dir, { recursive: true });

    const absolutePath = join(dir, safeName);
    await pipeline(input.stream, createWriteStream(absolutePath));

    const s = await stat(absolutePath);
    return {
      storageId,
      fileName: safeName,
      absolutePath,
      mimeType: input.mimeType,
      size: s.size,
    };
  }

  async materialize(absolutePath: string): Promise<MaterializedFile> {
    // Local backend: stat-check и возврат оригинала. cleanup = no-op.
    await stat(absolutePath);
    return { absolutePath, cleanup: async () => {} };
  }

  async remove(absolutePath: string): Promise<boolean> {
    return removeStoredFile(absolutePath);
  }
}

function sanitize(name: string): string {
  // Strip path components (defends against ../ traversal), keep extension,
  // allow Unicode letters and digits so Cyrillic/Greek/Chinese filenames
  // don't degrade to "_______". Spaces and shell-meaningful punctuation
  // stay out — keeps downstream `pdftoppm`/`tesseract` shell-out simple.
  const just = basename(name);
  return just.replace(/[^\p{L}\p{N}._\-]/gu, '_').slice(0, 200) || 'upload';
}

function guessExt(mime: string): string {
  switch (mime) {
    case 'application/pdf': return '.pdf';
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/bmp': return '.bmp';
    case 'image/tiff': return '.tiff';
    case 'image/webp': return '.webp';
    // 2026-05-18: XLSX support для CI/PL/Price list от поставщиков ВЭД
    case 'application/vnd.ms-excel': return '.xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    case 'application/vnd.ms-excel.sheet.macroEnabled.12':
      return '.xlsm';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    default: return '';
  }
}

/**
 * Remove a stored file plus its per-upload directory if empty. ENOENT is
 * treated as success — the sweeper can be retried at any time without
 * worrying about partial cleanups, and a race with manual deletion is fine.
 *
 * Returns `true` if any filesystem state actually changed.
 */
export async function removeStoredFile(absolutePath: string): Promise<boolean> {
  let changed = false;
  try {
    await unlink(absolutePath);
    changed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Storage layout is `<base>/uploads/<storageId>/<file>` — the storageId
  // dir holds exactly one file by construction, so it's safe to rmdir when
  // empty. We never touch `<base>/uploads/` itself.
  const dir = dirname(absolutePath);
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) {
      await rmdir(dir);
      changed = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return changed;
}

/**
 * Parse `<...>/uploads/<storageId>/<fileName>` → `uploads/<storageId>/<fileName>`.
 * Возвращает null если путь не соответствует формату (нет сегмента `uploads`).
 *
 * Используется S3 backend'ом для конвертации locallyCached path → S3 key.
 * Path separator нормализуем — на Windows backslash превращаем в slash для S3.
 */
export function deriveS3KeyFromPath(absolutePath: string): string | null {
  const normalized = absolutePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/uploads/');
  if (idx < 0) {
    // Возможно путь начинается с uploads/ без префикса
    if (normalized.startsWith('uploads/')) return normalized;
    return null;
  }
  return normalized.slice(idx + 1); // отрезаем ведущий слэш
}

export type S3FileStorageOpts = {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  localCacheDir: string;
  /**
   * Опциональный inject готового S3Client (используется в тестах через
   * `aws-sdk-client-mock`, который mock'ает singleton клиент по
   * constructor reference). В проде undefined — клиент создаётся внутри.
   */
  client?: S3Client;
};

/**
 * S3 / MinIO backend. Поведение durability-first с write-through локальным
 * кэшем: каждый загруженный файл пишется в S3 И в локальный кэш-путь
 * `<localCacheDir>/uploads/<storageId>/<fileName>`. Это позволяет
 * последующему пайплайн-шагу (OCR в том же worker'е) читать с диска без
 * round-trip в S3. Для горизонтального масштабирования (worker в другом
 * pod'е) включается ленивая materialize-загрузка из S3.
 *
 * NOTE: полное storage-decoupling (один worker пишет, другой читает без
 * локального кэша вообще) требует чтобы все OCR-движки умели stream-mode
 * или хотя бы переустанавливать локальные temporaries. Сейчас движки
 * привязаны к локальным путям — это deferred в TECH_DEBT (см. A2 закрытие).
 */
export class S3FileStorage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly localCacheDir: string;

  constructor(private readonly opts: S3FileStorageOpts) {
    this.bucket = opts.bucket;
    this.localCacheDir = opts.localCacheDir;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const cfg: S3ClientConfig = {
        region: opts.region,
        credentials: {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        },
        forcePathStyle: opts.forcePathStyle,
      };
      if (opts.endpoint) cfg.endpoint = opts.endpoint;
      this.client = new S3Client(cfg);
    }
  }

  async saveStream(input: SaveStreamInput): Promise<SavedFile> {
    const storageId = randomUUID();
    const safeName = sanitize(input.filename ?? `upload${guessExt(input.mimeType)}`);
    const key = `uploads/${storageId}/${safeName}`;
    const cacheDir = join(this.localCacheDir, 'uploads', storageId);
    await mkdir(cacheDir, { recursive: true });
    const localPath = join(cacheDir, safeName);

    // Стримим в S3 и одновременно зеркалим в локальный кэш через tee.
    // Создаём два независимых стрима: оригинал → файл, оригинал → S3.
    // Простейший подход — pipe в файл, потом read обратно для S3. Это
    // проще чем PassThrough-тройник и не требует backpressure-фьюза.
    // Для крупных файлов (50MB cap) extra disk I/O незначителен.
    await pipeline(input.stream, createWriteStream(localPath));

    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(localPath),
          ContentType: input.mimeType,
        },
      });
      await upload.done();
    } catch (err) {
      // Если S3 upload упал — чистим локальный кэш чтобы не оставался
      // orphan. Иначе sweeper'у не за что зацепиться (нет job row).
      await unlink(localPath).catch(() => undefined);
      await rmdir(cacheDir).catch(() => undefined);
      throw new Error(
        `S3 upload failed for key ${key}: ${(err as Error).message ?? String(err)}`,
      );
    }

    const s = await stat(localPath);
    return {
      storageId,
      fileName: safeName,
      absolutePath: localPath,
      mimeType: input.mimeType,
      size: s.size,
    };
  }

  async materialize(absolutePath: string): Promise<MaterializedFile> {
    // 1. Быстрый путь: кэш на диске жив, отдаём как есть.
    try {
      await stat(absolutePath);
      return { absolutePath, cleanup: async () => {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // 2. Кэша нет — тянем из S3 в tmp.
    const key = deriveS3KeyFromPath(absolutePath);
    if (!key) {
      throw new Error(
        `S3 materialize: cannot derive S3 key from path "${absolutePath}" (expected uploads/<id>/<name>)`,
      );
    }
    const tmpRoot = await mkdtemp(join(tmpdir(), 'docsvc-s3-'));
    const tmpPath = join(tmpRoot, basename(absolutePath));
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = resp.Body;
      if (!body) {
        throw new Error(`S3 GetObject returned empty body for key ${key}`);
      }
      // SDK returns a Node Readable; стримим в файл.
      await pipeline(body as Readable, createWriteStream(tmpPath));
    } catch (err) {
      await rmdir(tmpRoot, { recursive: true }).catch(() => undefined);
      throw new Error(
        `S3 download failed for key ${key}: ${(err as Error).message ?? String(err)}`,
      );
    }
    return {
      absolutePath: tmpPath,
      cleanup: async () => {
        await unlink(tmpPath).catch(() => undefined);
        await rmdir(tmpRoot).catch(() => undefined);
      },
    };
  }

  async remove(absolutePath: string): Promise<boolean> {
    let changed = false;
    const key = deriveS3KeyFromPath(absolutePath);
    if (key) {
      try {
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        changed = true;
      } catch (err) {
        // 404 / NoSuchKey — фактически как ENOENT в local: считаем
        // успешным no-op (sweeper может прогоняться повторно).
        const name = (err as { name?: string }).name ?? '';
        if (name !== 'NoSuchKey' && name !== 'NotFound') {
          throw new Error(
            `S3 delete failed for key ${key}: ${(err as Error).message ?? String(err)}`,
          );
        }
      }
    }
    // Локальный кэш чистим всегда — даже если S3 уже пуст, локальный
    // путь мог пережить рестарт worker'а с пустым S3 (race during initial
    // upload). removeStoredFile сам глушит ENOENT.
    const localChanged = await removeStoredFile(absolutePath);
    return changed || localChanged;
  }
}

/**
 * Audio MIME types accepted for the ASR (voice) ingestion path. Normalized
 * to canonical forms — the audio sniffer + file-type both report these.
 * (`audio/wave`, `audio/x-wav`, `audio/mp3` aliases are normalized to these
 * canonical values by the detectors below.)
 */
const AUDIO_MIME_LIST = [
  'audio/wav',
  'audio/mpeg', // MP3
  'audio/mp4', // .m4a in an ISO-BMFF container
  'audio/x-m4a',
  'audio/ogg',
] as const;

/**
 * Set of MIME types we know how to OCR. The route handler rejects uploads
 * whose magic bytes resolve to anything outside this set — defence against
 * a client that mis-labels Content-Type (innocent extension mix-up) or
 * actively tries to stash arbitrary blobs through the upload path.
 */
export const ACCEPTED_DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/bmp',
  'image/tiff',
  'image/webp',
  // HEIC/HEIF — iPhone-фото. Конвертируется в JPG через HeicHandler
  // в preprocess-pipeline перед основной обработкой. См.
  // src/pipeline/preprocess/heic.ts
  'image/heic',
  'image/heif',
  // 2026-05-18: XLS/XLSX от поставщиков ВЭД (CI/PL, Price list).
  // Парсятся sheetjs через XlsxEngine в src/pipeline/ocr/xlsx.ts.
  // Не идёт через preprocess — engine читает напрямую.
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  // Legacy .xls (BIFF8) детектится `file-type` пакетом как
  // application/x-cfb (OLE Compound File Binary — общий контейнер для
  // MS Office 97-2003). Принимаем при условии что extension .xls;
  // если внутри окажется .doc/.ppt — sheetjs упадёт с понятной ошибкой
  // на runtime в XlsxEngine.
  'application/x-cfb',
  // 2026-05-18: DOCX от ЭДО — Акты, Спецификации, Договоры.
  // Парсятся mammoth через DocxEngine в src/pipeline/ocr/docx.ts.
  // .doc (legacy binary, не OOXML) НЕ поддерживается — для него
  // клиент конвертирует в .docx или PDF.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // ASR (voice/audio) — «OCR for audio». Аудио транскрибируется в текст
  // ASR-движком, после чего идёт тот же downstream-пайплайн. Принимается
  // ТОЛЬКО когда ASR_ENABLED=true (route гейтит); набор MIME — см.
  // ACCEPTED_AUDIO_MIMES ниже.
  ...AUDIO_MIME_LIST,
]);

/**
 * Audio MIME types we route to the ASR (speech-to-text) engine. Kept as a
 * separate set so the route handler can gate them behind ASR_ENABLED — when
 * the feature is off an audio upload is rejected with a clear error instead
 * of being silently fed to an OCR engine that can't read it.
 *
 * `audio/wav`/`audio/x-m4a`/`audio/ogg` are detected by `file-type`;
 * `audio/mpeg` (MP3) with a leading ID3 tag is NOT, so `detectFileType` falls
 * back to `sniffAudioSignature` for the formats file-type misses.
 */
export const ACCEPTED_AUDIO_MIMES: ReadonlySet<string> = new Set(AUDIO_MIME_LIST);

export type DetectedFileType = { ext: string; mime: string };

/**
 * Inspect a file's leading bytes and report its real MIME type. Returns
 * `undefined` when no signature matches — for our purposes that's a hard
 * reject (plaintext, encrypted blobs, junk, executables all land here).
 *
 * Implementation lives in this module so the S3FileStorage variant can
 * share it without a separate utility import path.
 */
export async function detectFileType(absolutePath: string): Promise<DetectedFileType | undefined> {
  const result = await fileTypeFromFile(absolutePath);
  if (result) {
    // `file-type` reports OGG audio as the generic `application/ogg` — coerce
    // to `audio/ogg` so it lands in ACCEPTED_AUDIO_MIMES and routes to ASR.
    if (result.mime === 'application/ogg') {
      return { ext: result.ext, mime: 'audio/ogg' };
    }
    return { ext: result.ext, mime: result.mime };
  }
  // Fallback for audio signatures `file-type` misses (notably MP3 with a
  // leading ID3 tag → file-type returns undefined). Magic-bytes only; we
  // never trust the client Content-Type.
  return sniffAudioSignature(absolutePath);
}

/**
 * Minimal magic-bytes sniffer for the audio formats the ASR path accepts.
 * Runs only when `file-type` returns nothing, so it doesn't override the
 * library's stronger detection. Reads just the leading 16 bytes.
 *
 * Covers:
 *   - RIFF....WAVE         → audio/wav
 *   - "ID3" tag prefix     → audio/mpeg (MP3 with metadata; file-type misses this)
 *   - 0xFF 0xE_/0xF_ sync  → audio/mpeg (raw MP3 frame; usually file-type catches it)
 *   - ....ftyp(M4A/mp4/iso)→ audio/mp4 / audio/x-m4a
 *   - "OggS"               → audio/ogg
 */
export async function sniffAudioSignature(
  absolutePath: string,
): Promise<DetectedFileType | undefined> {
  let head: Buffer;
  try {
    const fh = await open(absolutePath, 'r');
    try {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await fh.read(buf, 0, 16, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  if (head.length < 4) return undefined;

  const ascii = (start: number, len: number): string =>
    head.subarray(start, start + len).toString('latin1');

  // RIFF container with WAVE form-type.
  if (ascii(0, 4) === 'RIFF' && head.length >= 12 && ascii(8, 4) === 'WAVE') {
    return { ext: 'wav', mime: 'audio/wav' };
  }
  // OggS — Ogg bitstream (Vorbis/Opus audio).
  if (ascii(0, 4) === 'OggS') {
    return { ext: 'ogg', mime: 'audio/ogg' };
  }
  // ID3v2 tag → MP3 with metadata (the case file-type returns undefined for).
  if (ascii(0, 3) === 'ID3') {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }
  // Raw MPEG audio frame sync: 0xFF followed by 0xE_ or 0xF_ (MPEG-1/2 layer).
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    return { ext: 'mp3', mime: 'audio/mpeg' };
  }
  // ISO-BMFF ftyp box at offset 4. Major brand M4A/mp4*/isom/M4B → audio.
  if (head.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('M4A') || brand.startsWith('M4B') || brand.startsWith('mp4') || brand === 'isom') {
      // M4A is the audio-only profile; keep its dedicated mime so the router
      // treats it as audio even when the brand is a generic mp4 container.
      return { ext: 'm4a', mime: brand.startsWith('M4A') ? 'audio/x-m4a' : 'audio/mp4' };
    }
  }
  return undefined;
}

/**
 * Factory: выбирает реализацию по cfg.storageBackend. Для 's3' валидирует
 * обязательные опции до создания клиента, чтобы pod не падал на первой
 * загрузке а отказывался стартовать с понятной ошибкой.
 */
export function makeFileStorage(cfg: Config): FileStorage {
  if (cfg.storageBackend === 's3') {
    const missing: string[] = [];
    if (!cfg.s3.bucket) missing.push('S3_BUCKET');
    if (!cfg.s3.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
    if (!cfg.s3.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
    if (missing.length > 0) {
      throw new Error(
        `S3 backend selected but ${missing.join(' / ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set`,
      );
    }
    return new S3FileStorage({
      bucket: cfg.s3.bucket!,
      endpoint: cfg.s3.endpoint,
      region: cfg.s3.region,
      accessKeyId: cfg.s3.accessKeyId!,
      secretAccessKey: cfg.s3.secretAccessKey!,
      forcePathStyle: cfg.s3.forcePathStyle,
      localCacheDir: cfg.storageDir,
    });
  }
  return new LocalFileStorage(cfg.storageDir);
}

// Default singleton bound to env-configured storage dir / S3 settings.
export const fileStorage: FileStorage = makeFileStorage(config);

// Backwards-compat alias: код / тесты, существующие до A2-закрытия,
// импортируют `localFileStorage`. Сохраняем имя как тонкий alias на
// активный backend — поведение saveStream остаётся то же.
export const localFileStorage: FileStorage = fileStorage;

// Re-exports kept for tests and future S3 adapter.
export { extname };
