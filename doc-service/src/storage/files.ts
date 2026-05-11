import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join, basename, dirname, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { config } from '../config.js';

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

export interface FileStorage {
  saveStream(input: SaveStreamInput): Promise<SavedFile>;
}

/**
 * Local filesystem storage. Files land in `<STORAGE_DIR>/uploads/<storageId>/<fileName>`.
 * Per-job directory keeps the multi-page artefacts (debug/per-page) co-located later.
 *
 * The S3/MinIO implementation will share the SaveStreamInput/SavedFile types
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

// Default singleton bound to env-configured storage dir.
export const localFileStorage: FileStorage = new LocalFileStorage(config.storageDir);

// Re-exports kept for tests and future S3 adapter.
export { extname };
