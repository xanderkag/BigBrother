/**
 * ASR → downstream pipeline flow.
 *
 * The architectural claim: ASR is just another way to produce TEXT; once we
 * have the transcript, the existing pipeline (classify → extract → validate)
 * is unchanged. This test proves it by:
 *   1. transcribing audio via HttpAsrTranscriber (undici mocked to return a
 *      spoken-invoice transcript),
 *   2. feeding that transcript into the SAME `runDocumentPipeline` used for
 *      OCR text, and asserting it classifies + extracts like any document.
 *
 * Also covers the `isAudioMime` routing predicate.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import pino from 'pino';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// No LLM/Yandex so the orchestrator wires NullLlmClient; regex parsers still run.
process.env.LLM_INFERENCE_URL = process.env.LLM_INFERENCE_URL ?? '';
process.env.YANDEX_VISION_API_KEY = '';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...a: unknown[]) => requestMock(...a) }));

const log = pino({ level: 'silent' });

let runDocumentPipeline: typeof import('../src/pipeline/orchestrator.js').runDocumentPipeline;
let HttpAsrTranscriber: typeof import('../src/pipeline/asr/transcribe.js').HttpAsrTranscriber;
let isAudioMime: typeof import('../src/pipeline/asr/mime.js').isAudioMime;

beforeAll(async () => {
  ({ runDocumentPipeline } = await import('../src/pipeline/orchestrator.js'));
  ({ HttpAsrTranscriber } = await import('../src/pipeline/asr/transcribe.js'));
  ({ isAudioMime } = await import('../src/pipeline/asr/mime.js'));
});

beforeEach(() => vi.clearAllMocks());

// A plausible transcript of a spoken invoice — the kind of text an ASR server
// would return. The keyword classifier should pick "invoice" from it.
const SPOKEN_INVOICE_TRANSCRIPT = `
  Счёт № 0042 от 15.03.2026 г.
  Поставщик: ООО "Ромашка" ИНН 7712345678
  Покупатель: ООО "Василёк" ИНН 7798765432
  Итого к оплате: 27 500,00 руб.
`;

describe('isAudioMime', () => {
  it('matches accepted audio formats and the audio/* prefix', () => {
    expect(isAudioMime('audio/wav')).toBe(true);
    expect(isAudioMime('audio/mpeg')).toBe(true);
    expect(isAudioMime('audio/ogg')).toBe(true);
    expect(isAudioMime('audio/flac')).toBe(true); // prefix fallback
  });
  it('rejects non-audio mimes', () => {
    expect(isAudioMime('application/pdf')).toBe(false);
    expect(isAudioMime('image/png')).toBe(false);
  });
});

describe('ASR transcript → runDocumentPipeline (same downstream)', () => {
  it('transcribes audio then classifies + extracts like any document', async () => {
    let workDir = await mkdtemp(join(tmpdir(), 'docsvc-asr-flow-'));
    try {
      // 1. ASR server (mocked) returns the transcript.
      requestMock.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          json: async () => ({ text: SPOKEN_INVOICE_TRANSCRIPT, duration_s: 12.0 }),
          text: async () => '',
        },
      });
      const transcriber = new HttpAsrTranscriber({
        baseUrl: 'http://inference:8000',
        timeoutMs: 5000,
        confidenceDefault: 0.8,
      });
      const fp = join(workDir, 'message.wav');
      await writeFile(fp, Buffer.from('RIFFxxxxWAVE-fake'));
      const asr = await transcriber.transcribe({ filePath: fp, mimeType: 'audio/wav' });

      expect(asr.text).toContain('Счёт');
      expect(asr.confidence).toBe(0.8); // server omitted → default

      // 2. Same pipeline as OCR text — no audio-specific branch downstream.
      const post = await runDocumentPipeline(asr.text, {}, log);
      expect(post.documentType).toBe('invoice');
      expect(post.classificationSource).toBe('keyword');
      expect(post.extracted.number).toBe('0042');
      expect(post.extracted.total).toBe(27500);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
