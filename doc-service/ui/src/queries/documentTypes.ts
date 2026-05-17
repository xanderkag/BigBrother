/**
 * Document types CRUD — справочник зарегистрированных типов документов.
 * Используется в фильтре JobsList, dropdown'ах Upload/Edit и админ-странице.
 *
 * Backend endpoints — см. routes/document-types.ts:
 *   GET    /document-types        — list
 *   GET    /document-types/:slug  — read one
 *   POST   /document-types        — create (slug unique, 409 если есть)
 *   PATCH  /document-types/:slug  — partial update
 *   DELETE /document-types/:slug  — delete (только is_builtin=false)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ParserKind =
  | 'builtin:invoice_regex'
  | 'builtin:upd_regex'
  | 'llm_extract'
  | 'llm_extract_multipass';

export interface DocumentTypeEntry {
  slug: string;
  display_name: string;
  description?: string | null;
  is_active: boolean;
  is_builtin?: boolean;
  parser_kind?: ParserKind | null;
  llm_prompt?: string | null;
  llm_schema?: Record<string, unknown> | null;
  expected_fields?: string[];
  validators?: string[];
  confidence_threshold?: number | null;
  regex_fallback_threshold?: number | null;
  classification_keywords?: string[];
  metadata?: Record<string, unknown> | null;
  resolution_config?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

interface ListResponse {
  items: DocumentTypeEntry[];
}

export const documentTypesKeys = {
  all: ['document-types'] as const,
  list: () => ['document-types', 'list'] as const,
  detail: (slug: string) => ['document-types', slug] as const,
};

export function useDocumentTypes() {
  return useQuery({
    queryKey: documentTypesKeys.list(),
    queryFn: () => api.get<ListResponse>('/api/v1/document-types'),
    staleTime: 5 * 60 * 1000, // 5 минут — справочник редко меняется
  });
}

export function useDocumentType(slug: string | undefined) {
  return useQuery({
    queryKey: documentTypesKeys.detail(slug ?? ''),
    queryFn: () => api.get<DocumentTypeEntry>(`/api/v1/document-types/${slug}`),
    enabled: !!slug,
  });
}

/**
 * Create — 201 на success, 409 если slug уже есть. Body — все поля
 * DocumentTypeEntry (slug required).
 */
export function useCreateDocumentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<DocumentTypeEntry> & { slug: string; display_name: string }) =>
      api.post<DocumentTypeEntry>('/api/v1/document-types', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentTypesKeys.all });
    },
  });
}

export function useUpdateDocumentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      patch,
    }: {
      slug: string;
      patch: Partial<DocumentTypeEntry>;
    }) => api.patch<DocumentTypeEntry>(`/api/v1/document-types/${slug}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: documentTypesKeys.all });
      qc.setQueryData(documentTypesKeys.detail(data.slug), data);
    },
  });
}

export function useDeleteDocumentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.delete(`/api/v1/document-types/${slug}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentTypesKeys.all });
    },
  });
}
