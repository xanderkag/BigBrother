import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useOperationalMetrics,
  useTimeseriesMetrics,
  type MetricsWindow,
  type MetricsBreakdownRow,
} from '@/queries/metrics';
import { useJobsList } from '@/queries/jobs';
import { formatPercent, formatDateTime, formatNumber } from '@/lib/format';
import ConfidenceBar from '@/components/ConfidenceBar';
import TierBadge from '@/components/TierBadge';
import TimeseriesChart from '@/components/TimeseriesChart';
import SystemHealthStrip from '@/components/SystemHealthStrip';
import type { DocumentTypeTier } from '@/queries/documentTypes';
import type { Job } from '@/lib/types';

/**
 * Dashboard — главная страница UI v2. Показывает операционные метрики
 * (тоталы, latency, LLM-стоимость, breakdown по типам) за выбранное
 * окно (1h / 24h / 7d / 30d). Авто-refresh каждые 30s.
 *
 * Эквивалент `#dashboard` в старом UI. Endpoint: GET /api/v1/metrics/operational.
 *
 * Выбранное окно хранится в localStorage чтобы пользователь возвращался
 * к тому же view после перезагрузки страницы.
 */

const WINDOW_KEY = 'parsdocs.v2.dashboardWindow';
const WINDOWS: { value: MetricsWindow; label: string }[] = [
  { value: '1h', label: '1 час' },
  { value: '24h', label: '24 часа' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
];

/** Окно → длительность в мс, для вычисления нижней границы ленты документов. */
const WINDOW_MS: Record<MetricsWindow, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const FEED_LIMIT = 50;

export default function DashboardPage() {
  const [window, setWindow] = useState<MetricsWindow>(() => {
    return (localStorage.getItem(WINDOW_KEY) as MetricsWindow) || '24h';
  });

  const { data, isLoading, error, refetch, isFetching } = useOperationalMetrics(window);
  const timeseries = useTimeseriesMetrics(window);

  useEffect(() => {
    localStorage.setItem(WINDOW_KEY, window);
  }, [window]);

  // Лента «что прошло за период» — реальные документы внутри выбранного
  // окна, новые сверху. from пересчитываем при смене окна; Date.now() в
  // браузере достаточно точен для границы выборки.
  const feedFrom = useMemo(
    () => new Date(Date.now() - WINDOW_MS[window]).toISOString(),
    [window],
  );
  const feed = useJobsList({ from: feedFrom, limit: FEED_LIMIT });

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Дашборд</h1>
          {data && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
              Обновлено {formatDateTime(data.generated_at)} ·{' '}
              <button
                type="button"
                className="text-brand-600 dark:text-brand-400 hover:underline"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                {isFetching ? 'обновляю…' : 'обновить ↻'}
              </button>
            </p>
          )}
        </div>
        <div className="flex rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5 text-sm">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              className={`rounded px-3 py-1 ${
                window === w.value
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:text-slate-100'
              }`}
              onClick={() => setWindow(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* UX-3: одна строка «всё ли работает» + куда идти чинить */}
      <SystemHealthStrip />

      {error && (
        <div className="error-banner">
          Ошибка загрузки метрик: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading && !data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="card">
                <div className="card-body space-y-3">
                  <div className="h-3 w-24 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                  <div className="h-8 w-20 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[1, 2].map((i) => (
              <div key={i} className="card">
                <div className="card-body space-y-3">
                  <div className="h-3 w-32 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                  <div className="h-24 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Totals — 4 ключевых карточки */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard
              label="Всего"
              value={formatNumber(data.totals.total)}
              hint={`${formatNumber(data.throughput_per_hour)} doc/час`}
            />
            <KpiCard
              label="Готово"
              value={formatNumber(data.totals.done)}
              hint={formatPercent(data.rates.done_rate)}
              tone="emerald"
            />
            <KpiCard
              label="На проверке"
              value={formatNumber(data.totals.needs_review)}
              hint={formatPercent(data.rates.needs_review_rate)}
              tone="amber"
              link={data.totals.needs_review > 0 ? '/jobs?status=needs_review' : undefined}
            />
            <KpiCard
              label="Ошибок"
              value={formatNumber(data.totals.failed)}
              hint={formatPercent(data.rates.failed_rate)}
              tone="rose"
              link={data.totals.failed > 0 ? '/jobs?status=failed' : undefined}
            />
          </div>

          {/* Time-series — как менялась активность внутри окна.
              Показывает то, чего нет в тоталах: спайки, тихие периоды,
              сдвиг ошибок относительно нормального потока. */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Активность по времени</h3>
              <span className="text-xs text-slate-500 dark:text-slate-500">
                {timeseries.data
                  ? `${timeseries.data.buckets.length} бакетов по ${fmtBucket(timeseries.data.bucket_minutes)}`
                  : ''}
              </span>
            </div>
            <div className="card-body">
              {timeseries.isLoading && !timeseries.data ? (
                <div className="h-40 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
              ) : timeseries.error ? (
                <div className="text-sm text-rose-700 dark:text-rose-300">
                  Ошибка загрузки графика:{' '}
                  {timeseries.error instanceof Error ? timeseries.error.message : String(timeseries.error)}
                </div>
              ) : timeseries.data ? (
                <TimeseriesChart
                  buckets={timeseries.data.buckets}
                  bucketMinutes={timeseries.data.bucket_minutes}
                  showLatencyOverlay
                />
              ) : null}
            </div>
          </div>

          {/* Последние документы — реальная активность за выбранное окно */}
          <RecentDocuments
            items={feed.data?.items ?? []}
            total={feed.data?.total}
            isLoading={feed.isLoading}
            error={feed.error}
          />

          {/* Latency + LLM + Confidence */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Latency</h3>
              </div>
              <div className="card-body space-y-3">
                <Stat label="p50" value={fmtMs(data.latency.p50_ms)} />
                <Stat label="p95" value={fmtMs(data.latency.p95_ms)} />
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">LLM (p95)</h3>
              </div>
              <div className="card-body space-y-3">
                <Stat label="duration" value={fmtMs(data.llm.duration_p95_ms)} />
                <Stat
                  label="tokens in"
                  value={data.llm.tokens_in_p95 !== null ? formatNumber(data.llm.tokens_in_p95) : '—'}
                />
                <Stat
                  label="tokens out"
                  value={data.llm.tokens_out_p95 !== null ? formatNumber(data.llm.tokens_out_p95) : '—'}
                />
                <Stat
                  label="LLM fallback"
                  value={formatPercent(data.rates.llm_fallback_rate)}
                />
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Качество</h3>
              </div>
              <div className="card-body space-y-3">
                <Stat
                  label="avg confidence"
                  value={
                    data.avg_confidence !== null ? formatPercent(data.avg_confidence) : '—'
                  }
                />
                <Stat
                  label="valid. issues"
                  value={formatPercent(data.rates.validation_issue_rate)}
                />
                <Stat
                  label="processing now"
                  value={formatNumber(data.totals.processing + data.totals.pending)}
                />
              </div>
            </div>
          </div>

          {/* By document type */}
          {data.by_type.length > 0 && (
            <BreakdownTable
              title="По типам документов"
              count={`${data.by_type.length} типов`}
              keyHeader="Тип"
              rows={data.by_type}
              rowKey={(t) => t.slug}
              renderKey={(t) =>
                t.slug === '_unknown' ? (
                  <span className="font-medium text-slate-500 dark:text-slate-400">без типа</span>
                ) : (
                  <Link
                    to={`/jobs?document_types=${encodeURIComponent(t.slug)}`}
                    className="font-medium text-slate-900 dark:text-slate-100 hover:underline"
                  >
                    {t.slug}
                  </Link>
                )
              }
            />
          )}

          {/* By OCR engine */}
          {data.by_engine.length > 0 && (
            <BreakdownTable
              title="По OCR-движку"
              count={`${data.by_engine.length} движков`}
              keyHeader="Движок"
              rows={data.by_engine}
              rowKey={(e) => e.engine}
              renderKey={(e) =>
                e.engine === '_none' ? (
                  <span className="text-slate-400 dark:text-slate-500">без движка</span>
                ) : (
                  <span className="font-medium text-slate-900 dark:text-slate-100">{e.engine}</span>
                )
              }
            />
          )}

          {/* By document-type tier (maturity) */}
          {data.by_tier.length > 0 && (
            <BreakdownTable
              title="По зрелости типа (tier)"
              count={`${data.by_tier.length}`}
              keyHeader="Зрелость"
              rows={data.by_tier}
              rowKey={(t) => t.tier}
              showNeedsReviewRate
              renderKey={(t) =>
                t.tier === '_untyped' ? (
                  <span className="text-slate-400 dark:text-slate-500">без типа</span>
                ) : (
                  <TierBadge tier={t.tier as DocumentTypeTier} />
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function BreakdownTable<T extends MetricsBreakdownRow>({
  title,
  count,
  keyHeader,
  rows,
  rowKey,
  renderKey,
  showNeedsReviewRate = false,
}: {
  title: string;
  count: string;
  keyHeader: string;
  rows: T[];
  rowKey: (row: T) => string;
  renderKey: (row: T) => React.ReactNode;
  showNeedsReviewRate?: boolean;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">{title}</h3>
        <span className="text-xs text-slate-500 dark:text-slate-500">{count}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-500">
            <tr>
              <th className="px-4 py-2">{keyHeader}</th>
              <th className="px-4 py-2 text-right">Всего</th>
              <th className="px-4 py-2 text-right">Готово</th>
              <th className="px-4 py-2 text-right">На проверке</th>
              {showNeedsReviewRate && <th className="px-4 py-2 text-right">% проверки</th>}
              <th className="px-4 py-2 text-right">Ошибки</th>
              <th className="px-4 py-2 text-right">p95 ms</th>
              <th className="px-4 py-2 text-right">avg conf.</th>
              <th className="px-4 py-2 text-right">LLM %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="hover:bg-slate-50 dark:bg-slate-900/40">
                <td className="px-4 py-2">{renderKey(r)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatNumber(r.total)}</td>
                <td className="px-4 py-2 text-right">
                  <span className="font-mono text-emerald-700 dark:text-emerald-300">
                    {formatNumber(r.done)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  {r.needs_review > 0 ? (
                    <span className="font-mono text-amber-700 dark:text-amber-300">
                      {formatNumber(r.needs_review)}
                    </span>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500">—</span>
                  )}
                </td>
                {showNeedsReviewRate && (
                  <td className="px-4 py-2 text-right">
                    {r.needs_review > 0 ? (
                      <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                        {formatPercent(r.needs_review_rate)}
                      </span>
                    ) : (
                      <span className="font-mono text-slate-400 dark:text-slate-500">
                        {formatPercent(r.needs_review_rate)}
                      </span>
                    )}
                  </td>
                )}
                <td className="px-4 py-2 text-right">
                  {r.failed > 0 ? (
                    <span className="font-mono text-rose-700 dark:text-rose-300">
                      {formatNumber(r.failed)}
                    </span>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-500">
                  {fmtMs(r.latency_p95_ms)}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  {r.avg_confidence !== null ? formatPercent(r.avg_confidence) : '—'}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-500">
                  {formatPercent(r.llm_fallback_rate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  tone,
  link,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'emerald' | 'amber' | 'rose';
  link?: string;
}) {
  const valueClass =
    tone === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-300'
      : tone === 'amber'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'rose'
      ? 'text-rose-700 dark:text-rose-300'
      : 'text-slate-900 dark:text-slate-100';

  const inner = (
    <div className="card-body">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 dark:text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{hint}</div>}
    </div>
  );

  if (link) {
    return (
      <Link to={link} className="card block transition-shadow hover:shadow-md">
        {inner}
      </Link>
    );
  }
  return <div className="card">{inner}</div>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{label}</span>
      <span className="font-mono text-sm text-slate-900 dark:text-slate-100">{value}</span>
    </div>
  );
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Ширина бакета time-series в человекочитаемой форме («1ч», «6ч», «1д»). */
function fmtBucket(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 60 * 24) return `${minutes / 60} ч`;
  return `${minutes / (60 * 24)} д`;
}

/* ------------------------------------------------------------------ */
/* Последние документы — лента «что прошло за период»                 */
/* ------------------------------------------------------------------ */

function RecentDocuments({
  items,
  total,
  isLoading,
  error,
}: {
  items: Job[];
  total?: number;
  isLoading: boolean;
  error: unknown;
}) {
  const navigate = useNavigate();
  const count =
    total !== undefined && total > items.length
      ? `${items.length} из ${formatNumber(total)}`
      : `${items.length}`;

  const webhookSummary = useMemo(() => {
    let delivered = 0;
    let failed = 0;
    for (const job of items) {
      const status = webhookStatus(job);
      if (status === 'delivered') delivered += 1;
      else if (status === 'error') failed += 1;
    }
    return { delivered, failed };
  }, [items]);

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Последние документы</h3>
        <div className="flex items-center gap-3">
          {items.length > 0 && (
            <span
              className="text-xs text-slate-500 dark:text-slate-500"
              title={`по загруженным ${items.length} докам`}
            >
              вебхуки: {webhookSummary.delivered}✓ ·{' '}
              <span
                className={
                  webhookSummary.failed > 0
                    ? 'text-rose-600 dark:text-rose-400'
                    : undefined
                }
              >
                {webhookSummary.failed}⚠
              </span>
            </span>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-500">{count}</span>
          <Link
            to="/jobs"
            className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
          >
            Все →
          </Link>
        </div>
      </div>

      {error ? (
        <div className="card-body">
          <p className="text-sm text-rose-700 dark:text-rose-300">
            Ошибка загрузки документов:{' '}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : isLoading && items.length === 0 ? (
        <div className="card-body space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-6 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="card-body">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            За период документов нет.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Время</th>
                <th className="px-4 py-2 font-medium">Файл</th>
                <th className="px-4 py-2 font-medium">Тип</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium">Вебхук</th>
                <th className="px-4 py-2 font-medium">Увер.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {items.map((job) => (
                <tr
                  key={job.id}
                  onClick={(e) => {
                    if (e.defaultPrevented) return;
                    const target = e.target as HTMLElement;
                    if (target.closest('a, button')) return;
                    if (globalThis.getSelection?.()?.toString()) return;
                    navigate(`/jobs/${job.id}`);
                  }}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {formatDateTime(job.created_at)}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      to={`/jobs/${job.id}`}
                      className="block max-w-[320px] truncate text-slate-900 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400"
                      title={job.file_name}
                    >
                      {job.file_name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {job.document_type ? (
                      <span className="badge-indigo uppercase">{job.document_type}</span>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-2">
                    <WebhookBadge job={job} />
                  </td>
                  <td className="px-4 py-2">
                    <ConfidenceBar
                      value={job.confidence !== null ? Number(job.confidence) : null}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Бейдж статуса — та же маппинг-схема, что в JobsList (визуальная консистентность). */
function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'done' || status === 'approved'
      ? 'badge-emerald'
      : status === 'needs_review'
      ? 'badge-amber'
      : status === 'failed'
      ? 'badge-rose'
      : status === 'processing' || status === 'pending'
      ? 'badge-sky'
      : 'badge-slate';
  return <span className={`${cls} uppercase`}>{status}</span>;
}

type WebhookStatus = 'delivered' | 'error' | 'pending' | 'none';

/**
 * Статус доставки вебхука по полям job. ВАЖНО: profile-routed джобы имеют
 * webhook_url === null, но всё равно доставляются (webhook_delivered_at /
 * webhook_attempts проставляются) — поэтому «есть ли вебхук» определяем
 * по активности доставки, а не по webhook_url.
 */
function webhookStatus(job: Job): WebhookStatus {
  if (job.webhook_delivered_at != null) return 'delivered';
  if (job.webhook_attempts > 0) return 'error';
  if (job.webhook_url != null) return 'pending';
  return 'none';
}

/** Бейдж доставки вебхука для интеграционного владельца (SLAI). */
function WebhookBadge({ job }: { job: Job }) {
  const status = webhookStatus(job);
  if (status === 'delivered') {
    return (
      <span className="badge-emerald" title={formatDateTime(job.webhook_delivered_at!)}>
        ✓ доставлен
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="badge-rose" title={job.webhook_last_error || 'нет деталей'}>
        ⚠ ошибка
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span className="badge-amber" title={job.webhook_url || undefined}>
        ⏳ в очереди
      </span>
    );
  }
  return <span className="text-slate-400 dark:text-slate-500">—</span>;
}
