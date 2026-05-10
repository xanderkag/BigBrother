import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

type YandexConfig = {
  apiKey?: string;
  folderId?: string;
  timeoutMs: number;
};

/**
 * Yandex Cloud Vision (OCR) — last-resort engine. Only used when other
 * engines fall through their thresholds, and only if API key is configured.
 *
 * NOTE: Yandex Vision requires either an API key (Api-Key) or IAM token. We
 * use Api-Key for simplicity. Pricing applies — invoke sparingly.
 *
 * NOTE on PII: this engine uploads document images to a third-party cloud.
 * For documents that may contain personal data (TTN with driver passport,
 * CMR with sender contacts), the orchestrator can disable yandex via env or
 * a per-job flag (TODO: add `disable_external_ocr` to job metadata).
 */
export class YandexVisionEngine implements OcrEngine {
  readonly name = 'yandex' as const;

  // Yandex is the final fallback — accept whatever it returns. The orchestrator
  // ranks results by confidence regardless.
  readonly acceptanceThreshold = 0;

  constructor(private readonly cfg: YandexConfig) {}

  supports(input: OcrInput): boolean {
    return (
      input.mimeType === 'application/pdf' ||
      input.mimeType.startsWith('image/')
    );
  }

  isAvailable(): boolean {
    return !!this.cfg.apiKey && !!this.cfg.folderId;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const started = Date.now();
    const buf = await readFile(input.filePath);

    const body = {
      folderId: this.cfg.folderId,
      analyze_specs: [
        {
          content: buf.toString('base64'),
          features: [
            {
              type: 'TEXT_DETECTION',
              text_detection_config: { language_codes: ['ru', 'en'] },
            },
          ],
          mime_type: input.mimeType,
        },
      ],
    };

    const res = await request('https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze', {
      method: 'POST',
      headers: {
        authorization: `Api-Key ${this.cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: this.cfg.timeoutMs,
      bodyTimeout: this.cfg.timeoutMs,
    });

    if (res.statusCode >= 400) {
      const errText = await res.body.text();
      throw new Error(`Yandex Vision ${res.statusCode}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.body.json()) as YandexResponse;
    const text = extractText(data);
    const confidence = estimateConfidence(data);

    return {
      engine: this.name,
      text,
      confidence,
      durationMs: Date.now() - started,
    };
  }
}

// --- Yandex response shape (minimal — only fields we read) ---
type YandexResponse = {
  results?: Array<{
    results?: Array<{
      textDetection?: {
        pages?: Array<{
          blocks?: Array<{
            lines?: Array<{
              words?: Array<{ text?: string; confidence?: number }>;
              text?: string;
            }>;
          }>;
        }>;
      };
    }>;
  }>;
};

function extractText(data: YandexResponse): string {
  const lines: string[] = [];
  for (const r0 of data.results ?? []) {
    for (const r1 of r0.results ?? []) {
      for (const page of r1.textDetection?.pages ?? []) {
        for (const block of page.blocks ?? []) {
          for (const line of block.lines ?? []) {
            const lineText =
              line.text ??
              (line.words ?? [])
                .map((w) => w.text ?? '')
                .filter(Boolean)
                .join(' ');
            if (lineText) lines.push(lineText);
          }
        }
      }
    }
  }
  return lines.join('\n');
}

function estimateConfidence(data: YandexResponse): number {
  const confs: number[] = [];
  for (const r0 of data.results ?? []) {
    for (const r1 of r0.results ?? []) {
      for (const page of r1.textDetection?.pages ?? []) {
        for (const block of page.blocks ?? []) {
          for (const line of block.lines ?? []) {
            for (const word of line.words ?? []) {
              if (typeof word.confidence === 'number') confs.push(word.confidence);
            }
          }
        }
      }
    }
  }
  if (confs.length === 0) return 0.7; // Yandex often omits confidence; assume "good enough"
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}
