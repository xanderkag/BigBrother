import type { DocumentType } from '../../types/documents.js';

export type ClassificationResult = {
  type: DocumentType | null;
  confidence: number;
  // Trace which keyword/rule fired — useful for debugging and dataset building.
  source: 'keyword' | 'llm' | 'hint';
  matched?: string;
};

export interface Classifier {
  classify(text: string): Promise<ClassificationResult>;
}
