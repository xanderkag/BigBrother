/**
 * Минимально необходимые типы для UI v2. Расширяем по мере миграции
 * страниц. Источник истины — backend (doc-service/src/types/*), здесь
 * только то, что реально читаем в JSX.
 *
 * NOTE: НЕ дублируем JSON schemas из backend — TS-типы здесь чисто
 * compile-time, runtime валидация не нужна (доверяем backend'у).
 */

export type JobStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'needs_review'
  | 'failed'
  | 'approved';

export type DocumentTypeSlug = string;

export type ValidationIssue = string;

export interface Job {
  id: string;
  status: JobStatus;
  file_name: string;
  file_path: string | null;
  file_size: string | number;
  mime_type: string;
  document_hint: DocumentTypeSlug | null;
  document_type: DocumentTypeSlug | null;
  ocr_engine: string | null;
  raw_text: string | null;
  confidence: number | null;
  extracted: Record<string, unknown> | null;
  /** Кол-во заполненных бизнес-полей верхнего уровня (без `_*`). */
  extracted_fields_count?: number;
  metadata: Record<string, unknown> | null;
  webhook_url: string | null;
  webhook_attempts: number;
  webhook_delivered_at: string | null;
  webhook_last_error: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  organization_id: string;
  project_id: string;
  pipeline_steps?: PipelineStep[];
  last_llm_call?: LlmCallTrace | null;
  classification?: Classification | null;
}

/**
 * Трасса классификатора: как выбран тип документа. null для legacy jobs
 * (до внедрения фичи). Источник — Job.classification в backend api-schemas.
 */
export interface Classification {
  type: DocumentTypeSlug | null;
  confidence: number;
  method: 'llm' | 'keyword' | 'filename' | 'fallback' | 'hint';
  duration_ms: number | null;
  llm_said: string | null;
  keyword_said: { type: DocumentTypeSlug; score: number } | null;
  candidates: Array<{ type: DocumentTypeSlug; score: number }>;
  unknown: boolean;
}

export interface PipelineStep {
  step: string;
  status: 'started' | 'done' | 'failed' | 'skipped';
  at: string;
  duration_ms?: number;
  details?: Record<string, unknown>;
}

export interface LlmCallTrace {
  backend?: string;
  model?: string;
  prompt?: string;
  raw_response?: string;
  duration_ms?: number;
  prompt_tokens?: number;
  output_tokens?: number;
}

/**
 * Объект со списком валидационных проблем. В extracted под ключом `_issues`
 * — если есть, документ "needs_review". В UI показываем как warning banner.
 */
export type Issues = ValidationIssue[] | undefined;
