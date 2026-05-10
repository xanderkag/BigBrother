import type { OcrEngineName } from '../../types/documents.js';

export type OcrInput = {
  filePath: string;
  mimeType: string;
};

export type OcrResult = {
  engine: OcrEngineName;
  text: string;
  confidence: number; // 0..1
  pages?: Array<{ text: string; confidence: number }>;
  durationMs: number;
};

export interface OcrEngine {
  readonly name: OcrEngineName;

  /** Whether this engine can in principle handle the given input. */
  supports(input: OcrInput): boolean;

  /** Whether this engine is configured (e.g., has API credentials). Disabled engines are skipped. */
  isAvailable(): boolean;

  /**
   * Confidence threshold above which the orchestrator stops trying further engines.
   * Returning a low value forces the orchestrator to keep falling through.
   */
  readonly acceptanceThreshold: number;

  run(input: OcrInput): Promise<OcrResult>;
}
