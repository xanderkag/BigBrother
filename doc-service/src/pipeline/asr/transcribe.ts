import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import { llmCallDurationSeconds, llmCallsTotal } from '../../metrics.js';

/**
 * ASR (speech-to-text) — «OCR for audio».
 *
 * Транскрайбер — это просто ещё один способ превратить вход в ТЕКСТ. Он
 * base64-кодирует аудио и зовёт inference-service `POST /v1/transcribe`
 * (тот же сервис, что и /v1/classify, /v1/extract). Сама ASR-модель и её
 * endpoint настраиваются НА СТОРОНЕ inference-service (ASR_BASE_URL/ASR_MODEL),
 * model-agnostic — doc-service о модели ничего не знает и НИКАКОГО ключа не
 * требует.
 *
 * После транскрипции оркестратор отдаёт текст в тот же downstream-пайплайн
 * (classify → extract → validate → webhook) — поведение ниже по потоку
 * полностью прежнее.
 */

export type TranscribeResult = {
  text: string;
  /** 0..1. ASR-серверы обычно не дают per-clip confidence → дефолт от вызывающего. */
  confidence: number;
  /** Длительность клипа в секундах, если сервер вернул. */
  durationS?: number;
  durationMs: number;
};

export type TranscribeClientOptions = {
  /** База inference-service (тот же LLM_INFERENCE_URL). */
  baseUrl?: string;
  apiKey?: string;
  timeoutMs: number;
  /** Дефолт confidence, если ASR-сервер не вернул своё значение. */
  confidenceDefault: number;
  /** Опц. ISO 639-1 language hint ('ru'), уходит в /v1/transcribe. */
  language?: string;
};

type TranscribeApiResponse = {
  text: string;
  duration_s?: number | null;
  confidence?: number | null;
};

export interface AsrTranscriber {
  isAvailable(): boolean;
  /** Транскрибировать аудио-файл с диска. */
  transcribe(input: { filePath: string; mimeType: string }): Promise<TranscribeResult>;
}

/**
 * HTTP-клиент к inference-service `/v1/transcribe`. Зеркалит сетевой паттерн
 * HttpLlmClient (undici + Prometheus-метрики), но это отдельный клиент —
 * транскрипция не зависит от LLM-провайдера (provider_settings).
 */
export class HttpAsrTranscriber implements AsrTranscriber {
  constructor(private readonly opts: TranscribeClientOptions) {}

  isAvailable(): boolean {
    return !!this.opts.baseUrl;
  }

  async transcribe(input: { filePath: string; mimeType: string }): Promise<TranscribeResult> {
    if (!this.opts.baseUrl) {
      throw new Error('ASR transcriber not configured (LLM_INFERENCE_URL unset)');
    }
    const started = Date.now();
    const buf = await readFile(input.filePath);
    const body: Record<string, unknown> = {
      audio_base64: buf.toString('base64'),
      mime_type: input.mimeType,
    };
    if (this.opts.language) body.language = this.opts.language;

    const res = await this.post('/v1/transcribe', body);
    const durationMs = Date.now() - started;

    const confidence =
      typeof res.confidence === 'number' && res.confidence >= 0 && res.confidence <= 1
        ? res.confidence
        : this.opts.confidenceDefault;

    return {
      text: (res.text ?? '').trim(),
      confidence,
      durationS: typeof res.duration_s === 'number' ? res.duration_s : undefined,
      durationMs,
    };
  }

  private async post(path: string, body: unknown): Promise<TranscribeApiResponse> {
    const url = new URL(path, this.opts.baseUrl).toString();
    const startedAt = Date.now();
    const endpointLabel = path.replace(/^\/+/, '');
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
      });
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, (Date.now() - startedAt) / 1000);
      if (res.statusCode >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        const text = await res.body.text();
        throw new Error(`ASR ${path} ${res.statusCode}: ${text.slice(0, 500)}`);
      }
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      return (await res.body.json()) as TranscribeApiResponse;
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('ASR '))) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
      }
      throw err;
    }
  }
}
