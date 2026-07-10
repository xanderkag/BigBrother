/**
 * Vanga gateway — интеграционный хаб внешних провайдеров (Яндекс.Карты,
 * DaData и т.п.) + учёт расхода (usage). Все ручки требуют super_admin.
 *
 * Backend endpoints — см. routes/gateway.ts:
 *   GET   /api/v1/gateway/connectors          — список коннекторов
 *   PATCH /api/v1/gateway/connectors/:slug    — {enabled?, daily_cap?, monthly_cap?}
 *                                               (null = снять лимит, поле опустить = не менять)
 *   GET   /api/v1/gateway/budgets             — все бюджеты потребителей
 *   GET   /api/v1/gateway/budgets?consumer=   — фильтр по потребителю
 *   PATCH /api/v1/gateway/budgets             — {consumer, connector, daily_budget?, enabled?}
 *                                               (daily_budget:null = без личного лимита)
 *   GET   /api/v1/gateway/usage?from=&to=&consumer=&connector=&by_day=true
 *                                             — {groups:[…], daily?:[…]}
 *
 * ВНИМАНИЕ: `consumer` может быть null (трафик с root-ключа) — в UI
 * показываем как «(root)», см. lib + страницу Integrations.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Чем меряется расход коннектора (запросы / символы / токены и т.п.). */
export type UnitKind = string;
/** Тип провайдера за коннектором (yandex_maps / dadata / llm / …). */
export type ProviderKind = string;

export interface GatewayConnector {
  slug: string;
  display_name: string;
  provider_kind: ProviderKind;
  unit_kind: UnitKind;
  /** Лимит ключа в сутки (null = без лимита). */
  daily_cap: number | null;
  /** Лимит ключа в месяц (null = без лимита). */
  monthly_cap: number | null;
  enabled: boolean;
}

export interface ConsumerBudget {
  /** Потребитель (имя системы/пользователя). null = трафик root-ключа. */
  consumer: string | null;
  connector: string;
  /** Личный суточный лимит потребителя (null = без личного лимита). */
  daily_budget: number | null;
  enabled: boolean;
}

export interface UsageGroup {
  /** null = трафик root-ключа → показываем «(root)». */
  consumer: string | null;
  connector: string;
  status: string;
  calls: number;
  units: number;
}

export interface UsageDailyRow {
  /** День (YYYY-MM-DD). Бэкенд отдаёт поле `day` (gateway-admin.ts). */
  day: string;
  consumer?: string | null;
  connector?: string;
  status?: string;
  calls?: number;
  units?: number;
}

export interface UsageResponse {
  groups: UsageGroup[];
  daily?: UsageDailyRow[];
}

export interface UsageQuery {
  from?: string;
  to?: string;
  consumer?: string;
  connector?: string;
  byDay?: boolean;
}

export const gatewayKeys = {
  all: ['gateway'] as const,
  connectors: () => ['gateway', 'connectors'] as const,
  budgets: (consumer?: string) => ['gateway', 'budgets', consumer ?? null] as const,
  usage: (q: UsageQuery) =>
    ['gateway', 'usage', q.from ?? null, q.to ?? null, q.consumer ?? null, q.connector ?? null, !!q.byDay] as const,
};

/* ─── Коннекторы ─────────────────────────────────────────────────── */

export function useConnectors() {
  return useQuery({
    queryKey: gatewayKeys.connectors(),
    // Эндпоинт отдаёт {items: [...]} (ConnectorsResponse в gateway-admin.ts), а
    // api.get возвращает res.json() как есть — без разворачивания. Раньше это
    // типизировалось как голый массив: `connectors.map(...)` падал с
    // «map is not a function» и ронял весь раздел «Коннекторы». Разворачиваем
    // здесь, чтобы хук возвращал массив, как ожидают все call-site'ы.
    queryFn: async () =>
      (await api.get<{ items: GatewayConnector[] }>('/api/v1/gateway/connectors')).items,
    staleTime: 30 * 1000,
  });
}

export interface PatchConnectorInput {
  slug: string;
  /** Поле опустить = не менять; null для cap = снять лимит. */
  patch: {
    enabled?: boolean;
    daily_cap?: number | null;
    monthly_cap?: number | null;
  };
}

export function usePatchConnector() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: PatchConnectorInput) =>
      api.patch<GatewayConnector>(
        `/api/v1/gateway/connectors/${encodeURIComponent(slug)}`,
        patch,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: gatewayKeys.connectors() });
    },
  });
}

/* ─── Бюджеты потребителей ───────────────────────────────────────── */

export function useBudgets(consumer?: string) {
  return useQuery({
    queryKey: gatewayKeys.budgets(consumer),
    // Та же история, что и у useConnectors: BudgetsResponse = {items: [...]}.
    queryFn: async () => {
      const qs = consumer ? `?consumer=${encodeURIComponent(consumer)}` : '';
      return (await api.get<{ items: ConsumerBudget[] }>(`/api/v1/gateway/budgets${qs}`)).items;
    },
    staleTime: 30 * 1000,
  });
}

export interface PatchBudgetInput {
  consumer: string;
  connector: string;
  /** null = без личного лимита; опустить = не менять. */
  daily_budget?: number | null;
  enabled?: boolean;
}

export function usePatchBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchBudgetInput) =>
      api.patch<ConsumerBudget>('/api/v1/gateway/budgets', body),
    onSuccess: () => {
      // префикс ['gateway','budgets'] обновляет и общий список, и фильтры.
      qc.invalidateQueries({ queryKey: ['gateway', 'budgets'] });
    },
  });
}

/* ─── Usage ──────────────────────────────────────────────────────── */

export function useGatewayUsage(q: UsageQuery) {
  return useQuery({
    queryKey: gatewayKeys.usage(q),
    queryFn: () => {
      const params = new URLSearchParams();
      if (q.from) params.set('from', q.from);
      if (q.to) params.set('to', q.to);
      if (q.consumer) params.set('consumer', q.consumer);
      if (q.connector) params.set('connector', q.connector);
      if (q.byDay) params.set('by_day', 'true');
      const qs = params.toString();
      return api.get<UsageResponse>(`/api/v1/gateway/usage${qs ? `?${qs}` : ''}`);
    },
    staleTime: 30 * 1000,
  });
}
