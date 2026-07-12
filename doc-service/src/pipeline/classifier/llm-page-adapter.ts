/**
 * §P0-1 (CLASSIFIER-PACKET-V2): адаптер LlmDocClassifier → интерфейс Classifier
 * для постраничной классификации в мультидоке.
 *
 * ПРОБЛЕМА (сверено): multidoc/runner зовёт `classifier.classify(text, orgId)`
 * на KeywordClassifier и читает `{type,confidence}`. Полный LLM-catalog путь
 * (`LlmDocClassifier`) НЕ `implements Classifier` — сигнатура другая
 * (`classify(input, isCatalogSlug, log, ctx)` → `{documentType, metadata}`),
 * подставить напрямую нельзя. Адаптер оборачивает LlmDocClassifier и маппит
 * outcome → ClassificationResult.
 *
 * Стоимость: per-page LLM classify = отдельные вызовы (15-стр композит ≈ 15
 * classify). Поэтому использование адаптера гейтится флагом
 * MULTIDOC_LLM_CLASSIFY (config.classifier.multidocLlmClassify, default false):
 * граница-детектор `boundaries.ts` уже типизирует boundary-страницы без LLM,
 * поэтому адаптер нужен лишь для безъякорных иноязычных страниц — включать по
 * данным eval-bctt.
 */
import type { Logger } from 'pino';
import type { Classifier, ClassificationResult } from './types.js';
import type { LlmDocClassifier } from './llm-classifier.js';

export class LlmPageClassifierAdapter implements Classifier {
  constructor(
    private readonly llmDoc: LlmDocClassifier,
    private readonly isCatalogSlug: (slug: string) => Promise<boolean>,
    private readonly log: Logger,
  ) {}

  async classify(
    text: string,
    organizationId?: string | null,
    fileName?: string | null,
  ): Promise<ClassificationResult> {
    const outcome = await this.llmDoc.classify(
      { text, fileName: fileName ?? null, organizationId: organizationId ?? null },
      this.isCatalogSlug,
      this.log,
      { source: 'multidoc-page' },
    );
    const method = outcome.metadata.method;
    const source: ClassificationResult['source'] =
      method === 'llm' ? 'llm' : method === 'hint' ? 'hint' : 'keyword';
    return {
      type: outcome.documentType,
      confidence: outcome.metadata.confidence,
      source,
    };
  }
}
