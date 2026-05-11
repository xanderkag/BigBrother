import type { DocumentTypeSlug } from '../../types/documents.js';

export type ClassificationResult = {
  /**
   * Slug of the classified type. Может быть как builtin (`invoice`, `UPD`,
   * ...), так и пользовательский, заведённый админом через UI. `null`,
   * если ничего не распозналось — оркестратор тогда оставляет тип пустым
   * и переводит в needs_review.
   */
  type: DocumentTypeSlug | null;
  confidence: number;
  // Trace which keyword/rule fired — useful for debugging and dataset building.
  source: 'keyword' | 'llm' | 'hint';
  matched?: string;
  /**
   * Сколько правил сматчилось в текст (best wins). Для лога и метрик —
   * помогает понять «классификатор уверенно выбрал из 1» vs «выбрал
   * один из 5 кандидатов».
   */
  candidatesCount?: number;
};

export interface Classifier {
  classify(text: string): Promise<ClassificationResult>;
}
