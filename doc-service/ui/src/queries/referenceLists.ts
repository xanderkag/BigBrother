/**
 * Reference lists — справочники контрагентов/номенклатуры/etc для
 * привязки документов к бизнес-сущностям.
 *
 * Endpoints — см. routes/reference-lists.ts:
 *   GET    /api/v1/reference-list-types?organization_id=:org
 *   GET    /api/v1/reference-list-types/:slug/entries?organization_id=:org&limit=&offset=&q=&active_only=
 *
 * org_id берётся из выбранного workspace (TODO: добавить workspace state).
 * Пока просто принимаем organization_id как параметр.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ReferenceListType {
  slug: string;
  label: string;
  search_hint: string | null;
  organization_id: string;
  created_at: string;
  updated_at?: string;
}

export interface ReferenceListEntry {
  id: string;
  external_id: string | null;
  display_name: string;
  search_keys: string[];
  attributes: Record<string, unknown> | null;
  is_active: boolean;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EntriesResponse {
  items: ReferenceListEntry[];
  total?: number;
}

export function useReferenceListTypes(orgId: string | null) {
  return useQuery({
    queryKey: ['reference-list-types', orgId],
    queryFn: () =>
      api.get<ReferenceListType[]>(
        `/api/v1/reference-list-types?organization_id=${encodeURIComponent(orgId ?? '')}`,
      ),
    enabled: !!orgId,
  });
}

export function useReferenceListEntries(
  slug: string | null,
  orgId: string | null,
  params: { q?: string; limit?: number; offset?: number; activeOnly?: boolean },
) {
  const qs = new URLSearchParams();
  if (orgId) qs.set('organization_id', orgId);
  if (params.q) qs.set('q', params.q);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  qs.set('active_only', String(params.activeOnly ?? false));

  return useQuery({
    queryKey: ['reference-list-entries', slug, orgId, params.q, params.limit, params.offset, params.activeOnly],
    queryFn: () =>
      api.get<EntriesResponse>(
        `/api/v1/reference-list-types/${encodeURIComponent(slug ?? '')}/entries?${qs.toString()}`,
      ),
    enabled: !!slug && !!orgId,
  });
}
