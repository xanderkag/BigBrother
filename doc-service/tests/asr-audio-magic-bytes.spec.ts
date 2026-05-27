/**
 * Magic-bytes detection for the ASR (voice) ingestion path.
 *
 * Writes minimal binary files with real audio signatures and verifies
 * `detectFileType` resolves them to an accepted audio MIME — including the
 * MP3-with-ID3 case that `file-type` alone misses (covered by the
 * `sniffAudioSignature` fallback). Content-Type is never trusted; only the
 * leading bytes decide.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import {
  ACCEPTED_AUDIO_MIMES,
  ACCEPTED_DOCUMENT_MIMES,
  detectFileType,
  sniffAudioSignature,
} from '../src/storage/files.js';

let workDir = '';
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'docsvc-asr-magic-'));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeBytes(name: string, bytes: Buffer): Promise<string> {
  const p = join(workDir, name);
  await writeFile(p, bytes);
  return p;
}

describe('ACCEPTED_AUDIO_MIMES', () => {
  it('contains the voice formats and is a subset of accepted document mimes', () => {
    for (const m of ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/ogg']) {
      expect(ACCEPTED_AUDIO_MIMES.has(m)).toBe(true);
      // Audio mimes are also in the global accepted set (gated by ASR_ENABLED at the route).
      expect(ACCEPTED_DOCUMENT_MIMES.has(m)).toBe(true);
    }
  });
});

describe('detectFileType — audio signatures', () => {
  it('detects WAV (RIFF....WAVE)', async () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'latin1');
    buf.write('WAVE', 8, 'latin1');
    const r = await detectFileType(await writeBytes('a.wav', buf));
    expect(r?.mime).toBe('audio/wav');
  });

  it('detects MP3 with ID3 tag (file-type misses this; sniffer catches it)', async () => {
    const buf = Buffer.alloc(32);
    buf.write('ID3', 0, 'latin1');
    buf[3] = 0x03; // version
    const r = await detectFileType(await writeBytes('a.mp3', buf));
    expect(r?.mime).toBe('audio/mpeg');
  });

  it('detects raw MP3 frame sync (0xFF 0xFB)', async () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
    const r = await detectFileType(await writeBytes('raw.mp3', buf));
    expect(r?.mime).toBe('audio/mpeg');
  });

  it('detects M4A (ftyp / M4A brand)', async () => {
    const buf = Buffer.alloc(32);
    buf.write('ftyp', 4, 'latin1');
    buf.write('M4A ', 8, 'latin1');
    const r = await detectFileType(await writeBytes('a.m4a', buf));
    expect(r && ACCEPTED_AUDIO_MIMES.has(r.mime)).toBe(true);
  });

  it('detects OGG (OggS) and coerces application/ogg → audio/ogg', async () => {
    const buf = Buffer.alloc(64);
    buf.write('OggS', 0, 'latin1');
    const r = await detectFileType(await writeBytes('a.ogg', buf));
    expect(r?.mime).toBe('audio/ogg');
  });

  it('returns undefined for plain text (not audio, not a document)', async () => {
    const r = await detectFileType(await writeBytes('notes.txt', Buffer.from('hello\n')));
    expect(r).toBeUndefined();
  });
});

describe('sniffAudioSignature — only fires on real audio heads', () => {
  it('returns undefined for random junk', async () => {
    const r = await sniffAudioSignature(
      await writeBytes('junk.bin', Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55])),
    );
    expect(r).toBeUndefined();
  });

  it('does not classify a PDF head as audio', async () => {
    const r = await sniffAudioSignature(await writeBytes('x.pdf', Buffer.from('%PDF-1.7\n')));
    expect(r).toBeUndefined();
  });
});
