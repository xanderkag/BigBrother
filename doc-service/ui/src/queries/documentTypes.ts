/**
 * Document types — справочник зарегистрированных типов документов.
 * Используется в фильтре JobsList и dropdown'ах Upload/Edit.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface DocumentTypeEntry {
  slug: string;
  display_name: string;
  is_active: boolean;
  description?: string | null;
  parser_kind?: string | null;
}

interface ListResponse {
  items: DocumentTypeEntry[];
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: ['document-types'],
    queryFn: () => api.get<ListResponse>('/api/v1/document-types'),
    staleTime: 5 * 60 * 1000, // 5 минут — справочник редко меняется
  });
}
