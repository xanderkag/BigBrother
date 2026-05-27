/**
 * HttpAsrTranscriber — client to inference-service /v1/transcribe.
 *
 * undici.request is mocked; no network. Verifies:
 *   - availability gating (no baseUrl → not available, transcribe throws),
 *   - the request hits /v1/transcribe with base64 audio + mime_type + language,
 *   - response {text, duration_s, confidence} is parsed,
 *   - the configured confidence default is applied when the server omits it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

// Metrics module reads no env at import; safe to import the client directly.
import { HttpAsrTranscriber } from '../src/pipeline/asr/transcribe.js';

function okResponse(json: unknown) {
  return {
    statusCode: 200,
    body: {
      json: async () => json,
      text: async () => JSON.stringify(json),
    },
  };
}

let workDir = '';
async function audioFile(bytes = Buffer.from('RIFFxxxxWAVE')): Promise<string> {
  if (!workDir) workDir = await mkdtemp(join(tmpdir(), 'docsvc-asr-client-'));
  const p = join(workDir, `clip-${Math.random().toString(36).slice(2)}.wav`);
  await writeFile(p, bytes);
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HttpAsrTranscriber.isAvailable', () => {
  it('false when no baseUrl', () => {
    const t = new HttpAsrTranscriber({ timeoutMs: 1000, confidenceDefault: 0.8 });
    expect(t.isAvailable()).toBe(false);
  });
  it('true when baseUrl set', () => {
    const t = new HttpAsrTranscriber({
      baseUrl: 'http://inference:8000',
      timeoutMs: 1000,
      confidenceDefault: 0.8,
    });
    expect(t.isAvailable()).toBe(true);
  });
});

describe('HttpAsrTranscriber.transcribe', () => {
  it('throws if not configured', async () => {
    const t = new HttpAsrTranscriber({ timeoutMs: 1000, confidenceDefault: 0.8 });
    await expect(
      t.transcribe({ filePath: await audioFile(), mimeType: 'audio/wav' }),
    ).rejects.toThrow(/not configured/);
    await rm(workDir, { recursive: true, force: true });
    workDir = '';
  });

  it('posts base64 audio + mime + language to /v1/transcribe and parses text', async () => {
    requestMock.mockResolvedValueOnce(
      okResponse({ text: '  привет мир  ', duration_s: 4.2, confidence: 0.91 }),
    );
    const t = new HttpAsrTranscriber({
      baseUrl: 'http://inference:8000',
      apiKey: 'k',
      timeoutMs: 5000,
      confidenceDefault: 0.8,
      language: 'ru',
    });
    const fp = await audioFile(Buffer.from('RIFFwave-bytes'));
    const r = await t.transcribe({ filePath: fp, mimeType: 'audio/wav' });

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, opts] = requestMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe('http://inference:8000/v1/transcribe');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authorization).toBe('Bearer k');
    const body = JSON.parse(opts.body);
    expect(body.mime_type).toBe('audio/wav');
    expect(body.language).toBe('ru');
    expect(Buffer.from(body.audio_base64, 'base64').toString()).toBe('RIFFwave-bytes');

    expect(r.text).toBe('привет мир'); // trimmed
    expect(r.durationS).toBe(4.2);
    expect(r.confidence).toBe(0.91);

    await rm(workDir, { recursive: true, force: true });
    workDir = '';
  });

  it('falls back to confidenceDefault when server omits confidence', async () => {
    requestMock.mockResolvedValueOnce(okResponse({ text: 'счёт на оплату', duration_s: 2 }));
    const t = new HttpAsrTranscriber({
      baseUrl: 'http://inference:8000',
      timeoutMs: 5000,
      confidenceDefault: 0.77,
    });
    const fp = await audioFile();
    const r = await t.transcribe({ filePath: fp, mimeType: 'audio/mpeg' });
    expect(r.confidence).toBe(0.77);
    expect(r.text).toBe('счёт на оплату');

    await rm(workDir, { recursive: true, force: true });
    workDir = '';
  });

  it('throws on a >=400 response', async () => {
    requestMock.mockResolvedValueOnce({
      statusCode: 503,
      body: { json: async () => ({}), text: async () => 'ASR off' },
    });
    const t = new HttpAsrTranscriber({
      baseUrl: 'http://inference:8000',
      timeoutMs: 5000,
      confidenceDefault: 0.8,
    });
    const fp = await audioFile();
    await expect(t.transcribe({ filePath: fp, mimeType: 'audio/ogg' })).rejects.toThrow(/503/);

    await rm(workDir, { recursive: true, force: true });
    workDir = '';
  });
});
