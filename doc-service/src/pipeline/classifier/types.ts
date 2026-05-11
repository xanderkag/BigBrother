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
};

export interface Classifier {
  classify(text: string): Promise<ClassificationResult>;
}
