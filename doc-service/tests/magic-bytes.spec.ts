/**
 * Tests for detectFileType + ACCEPTED_DOCUMENT_MIMES.
 *
 * Writes minimal binary files with real magic byte signatures to a temp
 * directory and verifies the detector returns the expected mime. PDFs and
 * images don't need to be "valid" in the full-format sense — file-type
 * only inspects the leading bytes, which is exactly what we want a
 * client-Content-Type-trust-bypass to catch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Min env for config.ts (imported transitively).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { ACCEPTED_DOCUMENT_MIMES, detectFileType } from '../src/storage/files.js';

let workDir = '';

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'docsvc-magic-'));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeBytes(name: string, bytes: Buffer | Uint8Array): Promise<string> {
  const p = join(workDir, name);
  await writeFile(p, bytes);
  return p;
}

describe('ACCEPTED_DOCUMENT_MIMES', () => {
  it('covers the formats the OCR pipeline knows how to handle', () => {
    expect(ACCEPTED_DOCUMENT_MIMES.has('application/pdf')).toBe(true);
    expect(ACCEPTED_DOCUMENT_MIMES.has('image/jpeg')).toBe(true);
    expect(ACCEPTED_DOCUMENT_MIMES.has('image/png')).toBe(true);
    expect(ACCEPTED_DOCUMENT_MIMES.has('image/bmp')).toBe(true);
    expect(ACCEPTED_DOCUMENT_MIMES.has('image/tiff')).toBe(true);
    expect(ACCEPTED_DOCUMENT_MIMES.has('image/webp')).toBe(true);
  });

  it('excludes things we cannot OCR', () => {
    expect(ACCEPTED_DOCUMENT_MIMES.has('text/plain')).toBe(false);
    expect(ACCEPTED_DOCUMENT_MIMES.has('application/zip')).toBe(false);
    expect(ACCEPTED_DOCUMENT_MIMES.has('application/x-msdownload')).toBe(false);
  });
});

describe('detectFileType', () => {
  it('detects PDF', async () => {
    // %PDF-1.4 + minimal trailer
    const path = await writeBytes(
      'doc.pdf',
      Buffer.from('%PDF-1.4\n%%EOF\n', 'binary'),
    );
    const r = await detectFileType(path);
    expect(r?.mime).toBe('application/pdf');
    expect(r?.ext).toBe('pdf');
  });

  it('detects PNG', async () => {
    // 8-byte PNG signature + 4-byte length 0 + IHDR + dummy data
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d,                          // chunk length 13
      0x49, 0x48, 0x44, 0x52,                          // "IHDR"
      0x00, 0x00, 0x00, 0x01,                          // width 1
      0x00, 0x00, 0x00, 0x01,                          // height 1
      0x08, 0x06, 0x00, 0x00, 0x00,                    // depth, color, ...
    ]);
    const path = await writeBytes('img.png', png);
    const r = await detectFileType(path);
    expect(r?.mime).toBe('image/png');
  });

  it('detects JPEG', async () => {
    // SOI + APP0 marker (typical JFIF preamble)
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0,
      0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    ]);
    const path = await writeBytes('img.jpg', jpeg);
    const r = await detectFileType(path);
    expect(r?.mime).toBe('image/jpeg');
  });

  it('detects BMP', async () => {
    // "BM" + 14-byte BITMAPFILEHEADER + 40-byte BITMAPINFOHEADER stub
    const bmp = Buffer.alloc(60);
    bmp.write('BM', 0, 'ascii');
    const path = await writeBytes('img.bmp', bmp);
    const r = await detectFileType(path);
    expect(r?.mime).toBe('image/bmp');
  });

  it('detects WebP', async () => {
    // "RIFF" + size + "WEBP" — minimal container
    const webp = Buffer.from([
      0x52, 0x49, 0x46, 0x46,  // "RIFF"
      0x1a, 0x00, 0x00, 0x00,  // file size minus 8
      0x57, 0x45, 0x42, 0x50,  // "WEBP"
      0x56, 0x50, 0x38, 0x4c,  // "VP8L"
      0x00, 0x00, 0x00, 0x00,
    ]);
    const path = await writeBytes('img.webp', webp);
    const r = await detectFileType(path);
    expect(r?.mime).toBe('image/webp');
  });

  it('returns undefined for plain text', async () => {
    const path = await writeBytes('notes.txt', Buffer.from('hello world\n', 'utf-8'));
    const r = await detectFileType(path);
    expect(r).toBeUndefined();
  });

  it('returns undefined for empty / unrecognizable bytes', async () => {
    const path = await writeBytes(
      'unknown.bin',
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]),
    );
    const r = await detectFileType(path);
    expect(r).toBeUndefined();
  });

  it('catches a PDF served with image/jpeg Content-Type (the bug we are guarding against)', async () => {
    // A "PDF mislabelled as JPEG" scenario: detection must report
    // application/pdf regardless of what the multipart Content-Type said.
    const path = await writeBytes('lying.jpg', Buffer.from('%PDF-1.7\n', 'binary'));
    const r = await detectFileType(path);
    expect(r?.mime).toBe('application/pdf');
  });

  it('detects an executable as NOT in the accepted set', async () => {
    // PE/COFF (Windows EXE) starts with "MZ" — should be detected and
    // then rejected by the upstream filter even if file-type returns
    // application/x-msdownload (or similar).
    const exe = Buffer.alloc(128);
    exe.write('MZ', 0, 'ascii');
    const path = await writeBytes('payload.pdf', exe); // mislabelled as PDF
    const r = await detectFileType(path);
    // file-type may not always identify minimal MZ stubs; we still expect
    // either (a) detection of an exe-like mime, or (b) undefined — both
    // are correctly REJECTED by the route handler because they're not in
    // ACCEPTED_DOCUMENT_MIMES.
    if (r) {
      expect(ACCEPTED_DOCUMENT_MIMES.has(r.mime)).toBe(false);
    } else {
      expect(r).toBeUndefined();
    }
  });
});
