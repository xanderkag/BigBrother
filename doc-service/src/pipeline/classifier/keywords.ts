import type { DocumentType } from '../../types/documents.js';
import type { Classifier, ClassificationResult } from './types.js';

// Order matters: more specific patterns first (УПД before "СЧЁТ", since УПД contains both).
const RULES: Array<{ type: DocumentType; pattern: RegExp; weight: number }> = [
  { type: 'UPD', pattern: /универсальный\s+передаточный\s+документ|\bУПД\b/i, weight: 1.0 },
  { type: 'CMR', pattern: /\bCMR\b|международная\s+товарно-транспортная/i, weight: 1.0 },
  { type: 'TTN', pattern: /транспортная\s+накладная|товарно-транспортная\s+накладная|\bТТН\b/i, weight: 1.0 },
  { type: 'factInvoice', pattern: /счет-фактура|счёт-фактура/i, weight: 1.0 },
  { type: 'AKT', pattern: /\bакт\b\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании/i, weight: 0.95 },
  { type: 'invoice', pattern: /\bсч[её]т\s+на\s+оплату\b|\bсч[её]т\s+№/i, weight: 0.9 },
  { type: 'invoice', pattern: /\bсч[её]т\b/i, weight: 0.6 }, // fallback, weakest
];

export class KeywordClassifier implements Classifier {
  async classify(text: string): Promise<ClassificationResult> {
    const haystack = text.slice(0, 4000); // header is usually enough; saves regex work on huge docs
    let best: { type: DocumentType; confidence: number; matched: string } | null = null;

    for (const rule of RULES) {
      const m = rule.pattern.exec(haystack);
      if (!m) continue;
      if (!best || rule.weight > best.confidence) {
        best = { type: rule.type, confidence: rule.weight, matched: m[0] };
      }
    }

    if (!best) return { type: null, confidence: 0, source: 'keyword' };
    return { type: best.type, confidence: best.confidence, source: 'keyword', matched: best.matched };
  }
}
