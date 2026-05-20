/**
 * Consumer-profile настройки организации (Phase 4a multi-tenancy).
 *
 * Backend: GET/PUT /api/v1/organizations/:id/settings.
 *   mode      — extract | classify_only
 *   output    — webhook | pull
 *   webhook_url, has_webhook_secret (секрет write-only — наружу не отдаётся),
 *   auto_approve_threshold (0..1 | null = глобальный дефолт).
 *
 * PUT принимает webhook_hmac_secret (write-only): строка = задать/сменить,
 * null = очистить, omit = оставить как есть.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ProcessingMode = 'extract' | 'classify_only';
export type OutputMode = 'webhook' | 'pull';

export interface OrganizationProfile {
  mode: ProcessingMode;
  output: OutputMode;
  webhook_url: string | null;
  has_webhook_secret: boolean;
  auto_approve_threshold: number | null;
}

export interface OrganizationProfileUpdate {
  mode?: ProcessingMode;
  output?: OutputMode;
  webhook_url?: string | null;
  /** write-only: строка — задать/сменить, null — очистить, omit — не трогать. */
  webhook_hmac_secret?: string | null;
  auto_approve_threshold?: number | null;
}

export function useOrganizationSettings(orgId: string | null | undefined) {
  return useQuery({
    queryKey: ['org-settings', orgId],
    enabled: !!orgId,
    queryFn: () =>
      api.get<OrganizationProfile>(
        `/api/v1/organizations/${encodeURIComponent(orgId as string)}/settings`,
      ),
  });
}

export function useUpdateOrganizationSettings(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: OrganizationProfileUpdate) =>
      api.put<OrganizationProfile>(
        `/api/v1/organizations/${encodeURIComponent(orgId)}/settings`,
        data,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-settings', orgId] });
    },
  });
}
