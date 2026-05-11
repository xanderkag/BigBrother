import type { DocumentTypeSlug } from '../../types/documents.js';
import { documentTypeResolver } from '../document-type-resolver.js';
import type { Classifier, ClassificationResult } from './types.js';

/**
 * KeywordClassifier — две стадии:
 *
 *   1. **DB-resolved keywords**. Берём список активных типов из БД
 *      (через DocumentTypeResolver, кэш TTL 60s) и компилируем
 *      `classification_keywords` каждого типа в RegExp'ы. Это позволяет
 *      админу через UI:
 *        - добавить новый тип (commercial_invoice, packing_list, …) и
 *          сразу включить его в классификацию;
 *        - подкрутить regex для существующего типа без релиза кода.
 *
 *   2. **Hardcoded fallback**. Если БД пустая (только что развёрнутый
 *      инстанс без миграций) или если ни одно DB-правило не подошло,
 *      пробуем встроенные правила для шести builtin-типов. Это значит,
 *      что админ может всё снести и платформа всё равно классифицирует
 *      базовые российские документы.
 *
 * Выбор лучшего матча:
 *   - DB-правила с большим `weight` побеждают. По умолчанию `weight=1.0`
 *     для всех (нет UI для этого, можно потом добавить в metadata.weight).
 *   - При равенстве выбирается тип с **более длинным** совпавшим текстом
 *     — длиннее = специфичнее.
 *
 * Производительность: regex-компиляция кэшируется внутри resolver-TTL
 * window'а (60s по умолчанию). На каждый classify-call — один проход по
 * скомпилированному списку без новых allocations.
 */

const HEADER_WINDOW = 4000; // первые 4 KB обычно достаточно — header всегда в начале

/** Hardcoded fallback для случая пустой БД. Тот же набор, что был в hardcoded RULES. */
const FALLBACK_RULES: Array<{ type: DocumentTypeSlug; pattern: RegExp; weight: number }> = [
  { type: 'UPD', pattern: /универсальный\s+передаточный\s+документ|\bУПД\b/i, weight: 1.0 },
  { type: 'CMR', pattern: /\bCMR\b|международная\s+товарно-транспортная/i, weight: 1.0 },
  { type: 'TTN', pattern: /транспортная\s+накладная|товарно-транспортная\s+накладная|\bТТН\b/i, weight: 1.0 },
  { type: 'factInvoice', pattern: /счет-фактура|счёт-фактура/i, weight: 1.0 },
  { type: 'AKT', pattern: /\bакт\b\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании/i, weight: 0.95 },
  { type: 'invoice', pattern: /\bсч[её]т\s+на\s+оплату\b|\bсч[её]т\s+№/i, weight: 0.9 },
  { type: 'invoice', pattern: /\bсч[её]т\b/i, weight: 0.6 },
];

type CompiledRule = {
  type: DocumentTypeSlug;
  pattern: RegExp;
  weight: number;
};

export class KeywordClassifier implements Classifier {
  async classify(text: string): Promise<ClassificationResult> {
    const haystack = text.slice(0, HEADER_WINDOW);

    // --- Stage 1: DB-driven rules ---
    const dbBest = await this.classifyByDbRules(haystack);
    if (dbBest) {
      return {
        type: dbBest.type,
        confidence: dbBest.confidence,
        source: 'keyword',
        matched: dbBest.matched,
        candidatesCount: dbBest.candidatesCount,
      };
    }

    // --- Stage 2: hardcoded fallback ---
    let best: { type: DocumentTypeSlug; confidence: number; matched: string } | null = null;
    let candidates = 0;
    for (const rule of FALLBACK_RULES) {
      const m = rule.pattern.exec(haystack);
      if (!m) continue;
      candidates += 1;
      if (this.beats(best, rule.weight, m[0])) {
        best = { type: rule.type, confidence: rule.weight, matched: m[0] };
      }
    }

    if (!best) return { type: null, confidence: 0, source: 'keyword', candidatesCount: 0 };
    return {
      type: best.type,
      confidence: best.confidence,
      source: 'keyword',
      matched: best.matched,
      candidatesCount: candidates,
    };
  }

  private async classifyByDbRules(
    haystack: string,
  ): Promise<
    | { type: DocumentTypeSlug; confidence: number; matched: string; candidatesCount: number }
    | null
  > {
    const rows = await documentTypeResolver.listActive();
    if (rows.length === 0) return null;

    const compiled: CompiledRule[] = [];
    for (const row of rows) {
      const weight = this.weightFromMetadata(row.metadata) ?? 1.0;
      for (const raw of row.classification_keywords) {
        try {
          compiled.push({ type: row.slug, pattern: new RegExp(raw, 'i'), weight });
        } catch {
          // Bad regex — skip silently.
        }
      }
    }
    if (compiled.length === 0) return null;

    let best: { type: DocumentTypeSlug; confidence: number; matched: string } | null = null;
    let candidates = 0;
    for (const rule of compiled) {
      const m = rule.pattern.exec(haystack);
      if (!m) continue;
      candidates += 1;
      if (this.beats(best, rule.weight, m[0])) {
        best = { type: rule.type, confidence: rule.weight, matched: m[0] };
      }
    }
    if (!best) return null;
    return { ...best, candidatesCount: candidates };
  }

  /** Per-rule весов в UI ещё нет — можно класть в metadata.classification_weight. */
  private weightFromMetadata(metadata: Record<string, unknown> | null): number | null {
    if (!metadata) return null;
    const w = (metadata as Record<string, unknown>).classification_weight;
    if (typeof w === 'number' && w >= 0 && w <= 1) return w;
    return null;
  }

  /** Новый кандидат побеждает текущего, если weight выше; при равенстве — длиннее матч. */
  private beats(
    current: { confidence: number; matched: string } | null,
    weight: number,
    matched: string,
  ): boolean {
    if (!current) return true;
    if (weight > current.confidence) return true;
    if (weight === current.confidence && matched.length > current.matched.length) return true;
    return false;
  }
}
