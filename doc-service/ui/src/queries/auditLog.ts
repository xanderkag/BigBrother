/**
 * Audit log — журнал изменений document_types и provider_settings.
 *
 * Backend endpoint — см. routes/audit-log.ts:
 *   GET /audit-log?entity=...&entity_id=...&limit=...&offset=...
 *
 * Secrets маскируются на backend'е перед записью в audit_log (api_key
 * не виден ни в before, ни в after snapshot'е). diff содержит только
 * изменённые поля.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type AuditEntity =
  | 'document_type'
  | 'provider_setting'
  | 'gateway_connector'
  | 'gateway_budget';
export type AuditAction = 'create' | 'update' | 'delete';

export interface AuditEntry {
  id: string | number;
  at: string;
  actor: string;
  entity: AuditEntity;
  entity_id: string;
  action: AuditAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  diff?: Record<string, { from: unknown; to: unknown }> | null;
}

interface ListResponse {
  items: AuditEntry[];
}

export interface AuditFilters {
  entity?: AuditEntity;
  entity_id?: string;
  limit?: number;
  offset?: number;
}

export function useAuditLog(filters: AuditFilters = {}, opts: { enabled?: boolean } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return useQuery({
    queryKey: ['audit-log', filters],
    queryFn: () =>
      api.get<ListResponse>(`/api/v1/audit-log${qs ? '?' + qs : ''}`),
    staleTime: 30_000,
    enabled: opts.enabled ?? true,
  });
}
