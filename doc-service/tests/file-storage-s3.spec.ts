/**
 * A2: S3FileStorage backend — saveStream / materialize / remove.
 *
 * Mockаем S3Client через `aws-sdk-client-mock`, чтобы не подымать MinIO
 * на каждый прогон. Покрываем happy-path + ленивую materialize-загрузку
 * при отсутствующем локальном кэше + remove с очисткой обоих
 * (S3 + кэш).
 *
 * Factory test проверяет селектор + fail-fast на отсутствующих credentials.
 *
 * Pattern: env заполняем ДО import'ов из src/, а сами src/-import'ы делаем
 * через `await import()` в beforeAll — это даёт config.ts увидеть env
 * после установки переменных. См. sweepers.spec.ts — тот же трюк.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

// Заполняем минимальный env для config.ts (zod-validation).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

type FilesModule = typeof import('../src/storage/files.js');
type Config = import('../src/config.js').Config;

let filesMod: FilesModule;

beforeAll(async () => {
  filesMod = await import('../src/storage/files.js');
});

const s3Mock = mockClient(S3Client);

function makeReadable(content: string | Buffer): Readable {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return Readable.from([buf]);
}

let cacheDir: string;

beforeEach(() => {
  s3Mock.reset();
  cacheDir = mkdtempSync(join(tmpdir(), 'docsvc-s3-test-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('S3FileStorage', () => {
  it('saveStream → PutObject + writes local cache', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const fs = new filesMod.S3FileStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA-fake',
      secretAccessKey: 'fake-secret',
      forcePathStyle: true,
      localCacheDir: cacheDir,
      client: new S3Client({ region: 'us-east-1' }),
    });

    const result = await fs.saveStream({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      stream: makeReadable('%PDF-1.4 dummy content'),
    });

    expect(result.fileName).toBe('invoice.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.size).toBe(Buffer.byteLength('%PDF-1.4 dummy content', 'utf8'));
    // Локальный кэш — `<cacheDir>/uploads/<storageId>/<file>`
    expect(result.absolutePath.replace(/\\/g, '/')).toContain(
      `uploads/${result.storageId}/invoice.pdf`,
    );
    expect(existsSync(result.absolutePath)).toBe(true);
    expect(readFileSync(result.absolutePath, 'utf8')).toBe('%PDF-1.4 dummy content');

    // PutObject вызван с правильным Bucket + Key
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const input = calls[0]!.args[0]!.input;
    expect(input.Bucket).toBe('test-bucket');
    expect(input.Key).toBe(`uploads/${result.storageId}/invoice.pdf`);
    expect(input.ContentType).toBe('application/pdf');
  });

  it('materialize: returns cached path when present (no GetObject)', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('should not be called'));

    // Подкладываем «уже сохранённый» файл в кэше
    const storageId = '11111111-1111-1111-1111-111111111111';
    const dir = join(cacheDir, 'uploads', storageId);
    await mkdir(dir, { recursive: true });
    const local = join(dir, 'doc.pdf');
    writeFileSync(local, 'cached body');

    const fs = new filesMod.S3FileStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA-fake',
      secretAccessKey: 'fake-secret',
      forcePathStyle: true,
      localCacheDir: cacheDir,
      client: new S3Client({ region: 'us-east-1' }),
    });

    const m = await fs.materialize(local);
    expect(m.absolutePath).toBe(local);
    expect(existsSync(m.absolutePath)).toBe(true);
    // Cleanup — no-op для cached
    await m.cleanup();
    expect(existsSync(local)).toBe(true);
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(0);
  });

  it('materialize: downloads from S3 when cache missing, cleanup unlinks tmp', async () => {
    const payload = 'downloaded from s3';
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from(payload, 'utf8')]) as never,
    });

    // Путь к НЕсуществующему файлу в кэше — materialize должен скачать
    const storageId = '22222222-2222-2222-2222-222222222222';
    const missing = join(cacheDir, 'uploads', storageId, 'lost.pdf');

    const fs = new filesMod.S3FileStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA-fake',
      secretAccessKey: 'fake-secret',
      forcePathStyle: true,
      localCacheDir: cacheDir,
      client: new S3Client({ region: 'us-east-1' }),
    });

    const m = await fs.materialize(missing);
    expect(m.absolutePath).not.toBe(missing);
    expect(existsSync(m.absolutePath)).toBe(true);
    expect(readFileSync(m.absolutePath, 'utf8')).toBe(payload);

    const calls = s3Mock.commandCalls(GetObjectCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0]!.input.Key).toBe(`uploads/${storageId}/lost.pdf`);

    // cleanup должен удалить tmp
    await m.cleanup();
    expect(existsSync(m.absolutePath)).toBe(false);
  });

  it('remove: DeleteObject + clears local cache', async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});

    const storageId = '33333333-3333-3333-3333-333333333333';
    const dir = join(cacheDir, 'uploads', storageId);
    await mkdir(dir, { recursive: true });
    const local = join(dir, 'gone.pdf');
    writeFileSync(local, 'soon to be deleted');
    expect(existsSync(local)).toBe(true);

    const fs = new filesMod.S3FileStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA-fake',
      secretAccessKey: 'fake-secret',
      forcePathStyle: true,
      localCacheDir: cacheDir,
      client: new S3Client({ region: 'us-east-1' }),
    });

    const changed = await fs.remove(local);
    expect(changed).toBe(true);
    expect(existsSync(local)).toBe(false);

    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args[0]!.input.Bucket).toBe('test-bucket');
    expect(calls[0]!.args[0]!.input.Key).toBe(`uploads/${storageId}/gone.pdf`);
  });
});

describe('deriveS3KeyFromPath', () => {
  it('extracts uploads/<id>/<name> from absolute path', () => {
    expect(filesMod.deriveS3KeyFromPath('/var/data/uploads/abc-123/file.pdf'))
      .toBe('uploads/abc-123/file.pdf');
  });
  it('normalises Windows-style backslashes', () => {
    expect(filesMod.deriveS3KeyFromPath('C:\\app\\data\\uploads\\xyz\\file.pdf'))
      .toBe('uploads/xyz/file.pdf');
  });
  it('accepts already-relative uploads/ prefixes', () => {
    expect(filesMod.deriveS3KeyFromPath('uploads/abc/file.pdf')).toBe('uploads/abc/file.pdf');
  });
  it('returns null for unrelated paths', () => {
    expect(filesMod.deriveS3KeyFromPath('/tmp/random/file.pdf')).toBeNull();
  });
});

describe('makeFileStorage factory', () => {
  // Минимальный shape Config — мы не зовём loadConfig (зод раскритикует
  // отсутствие DATABASE_URL etc.), а лепим объект руками для unit-теста.
  function baseCfg(): Config {
    return {
      storageDir: cacheDir,
      storageBackend: 'local',
      s3: {
        region: 'us-east-1',
        forcePathStyle: true,
      },
    } as unknown as Config;
  }

  it('local → LocalFileStorage', () => {
    const fs = filesMod.makeFileStorage(baseCfg());
    expect(fs).toBeInstanceOf(filesMod.LocalFileStorage);
  });

  it('s3 with full credentials → S3FileStorage', () => {
    const cfg = baseCfg();
    cfg.storageBackend = 's3';
    cfg.s3 = {
      ...cfg.s3,
      bucket: 'my-bucket',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    } as Config['s3'];
    const fs = filesMod.makeFileStorage(cfg);
    expect(fs).toBeInstanceOf(filesMod.S3FileStorage);
  });

  it('s3 with missing bucket throws with a useful message', () => {
    const cfg = baseCfg();
    cfg.storageBackend = 's3';
    cfg.s3 = {
      ...cfg.s3,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    } as Config['s3'];
    expect(() => filesMod.makeFileStorage(cfg)).toThrow(/S3_BUCKET/);
  });

  it('s3 with missing credentials throws listing each missing var', () => {
    const cfg = baseCfg();
    cfg.storageBackend = 's3';
    cfg.s3 = {
      ...cfg.s3,
      bucket: 'my-bucket',
    } as Config['s3'];
    expect(() => filesMod.makeFileStorage(cfg)).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => filesMod.makeFileStorage(cfg)).toThrow(/S3_SECRET_ACCESS_KEY/);
  });
});

describe('LocalFileStorage', () => {
  it('materialize returns the same path with no-op cleanup when file exists', async () => {
    const fs = new filesMod.LocalFileStorage(cacheDir);
    const dir = join(cacheDir, 'uploads', 'local-id');
    await mkdir(dir, { recursive: true });
    const p = join(dir, 'a.pdf');
    writeFileSync(p, 'x');
    const m = await fs.materialize(p);
    expect(m.absolutePath).toBe(p);
    await m.cleanup();
    expect(existsSync(p)).toBe(true);
  });

  it('materialize throws when file missing', async () => {
    const fs = new filesMod.LocalFileStorage(cacheDir);
    await expect(
      fs.materialize(join(cacheDir, 'no-such-file.pdf')),
    ).rejects.toThrow();
  });

  it('remove deletes file and tidies empty parent dir', async () => {
    const fs = new filesMod.LocalFileStorage(cacheDir);
    const dir = join(cacheDir, 'uploads', 'rm-id');
    await mkdir(dir, { recursive: true });
    const p = join(dir, 'a.pdf');
    writeFileSync(p, 'x');
    const changed = await fs.remove(p);
    expect(changed).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});
