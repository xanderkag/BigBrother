/**
 * Operational metrics — `/api/v1/metrics/operational` хуки для Dashboard.
 *
 * Response shape соответствует backend схеме (см. routes/operational-metrics.ts).
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type MetricsWindow = '1h' | '24h' | '7d' | '30d';

export interface MetricsBreakdownRow {
  total: number;
  done: number;
  needs_review: number;
  failed: number;
  validation_issues: number;
  llm_used: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  avg_confidence: number | null;
  done_rate: number;
  needs_review_rate: number;
  failed_rate: number;
  validation_issue_rate: number;
  llm_fallback_rate: number;
}

export interface OperationalMetrics {
  window: MetricsWindow;
  window_hours: number;
  generated_at: string;
  scope: 'all' | 'org' | 'projects';
  totals: {
    total: number;
    pending: number;
    processing: number;
    done: number;
    needs_review: number;
    failed: number;
    validation_issues: number;
    llm_used: number;
  };
  rates: {
    done_rate: number;
    needs_review_rate: number;
    failed_rate: number;
    validation_issue_rate: number;
    llm_fallback_rate: number;
  };
  latency: {
    p50_ms: number | null;
    p95_ms: number | null;
  };
  llm: {
    tokens_in_p95: number | null;
    tokens_out_p95: number | null;
    duration_p95_ms: number | null;
  };
  avg_confidence: number | null;
  throughput_per_hour: number;
  by_type: Array<MetricsBreakdownRow & { slug: string }>;
  by_engine: Array<MetricsBreakdownRow & { engine: string }>;
  by_tier: Array<MetricsBreakdownRow & { tier: string }>;
}

export function useOperationalMetrics(window: MetricsWindow = '7d') {
  return useQuery({
    queryKey: ['metrics', 'operational', window],
    queryFn: () =>
      api.get<OperationalMetrics>(`/api/v1/metrics/operational?window=${window}`),
    // Auto-refresh каждые 30 секунд — соответствует поведению старого UI
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
