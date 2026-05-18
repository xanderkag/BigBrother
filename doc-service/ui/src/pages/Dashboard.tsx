import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  useOperationalMetrics,
  type MetricsWindow,
} from '@/queries/metrics';
import { formatPercent, formatDateTime, formatNumber } from '@/lib/format';

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

export default function DashboardPage() {
  const [window, setWindow] = useState<MetricsWindow>(() => {
    return (localStorage.getItem(WINDOW_KEY) as MetricsWindow) || '7d';
  });

  const { data, isLoading, error, refetch, isFetching } = useOperationalMetrics(window);

  useEffect(() => {
    localStorage.setItem(WINDOW_KEY, window);
  }, [window]);

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

      {error && (
        <div className="error-banner">
          Ошибка загрузки метрик: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading && !data && (
        <div className="card">
          <div className="card-body text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">Загрузка метрик…</div>
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
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">По типам документов</h3>
                <span className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{data.by_type.length} типов</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 dark:text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Тип</th>
                      <th className="px-4 py-2 text-right">Всего</th>
                      <th className="px-4 py-2 text-right">Готово</th>
                      <th className="px-4 py-2 text-right">На проверке</th>
                      <th className="px-4 py-2 text-right">Ошибки</th>
                      <th className="px-4 py-2 text-right">p95 ms</th>
                      <th className="px-4 py-2 text-right">avg conf.</th>
                      <th className="px-4 py-2 text-right">LLM %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {data.by_type.map((t) => (
                      <tr key={t.slug} className="hover:bg-slate-50 dark:bg-slate-900/40">
                        <td className="px-4 py-2">
                          <Link
                            to={`/jobs?document_type=${t.slug}`}
                            className="font-medium text-slate-900 dark:text-slate-100 hover:underline"
                          >
                            {t.slug}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{formatNumber(t.total)}</td>
                        <td className="px-4 py-2 text-right">
                          <span className="font-mono text-emerald-700 dark:text-emerald-300">{formatNumber(t.done)}</span>
                        </td>
                        <td className="px-4 py-2 text-right">
                          {t.needs_review > 0 ? (
                            <span className="font-mono text-amber-700 dark:text-amber-300">
                              {formatNumber(t.needs_review)}
                            </span>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {t.failed > 0 ? (
                            <span className="font-mono text-rose-700 dark:text-rose-300">
                              {formatNumber(t.failed)}
                            </span>
                          ) : (
                            <span className="text-slate-400 dark:text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-400 dark:text-slate-500">
                          {fmtMs(t.latency_p95_ms)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">
                          {t.avg_confidence !== null
                            ? formatPercent(t.avg_confidence)
                            : '—'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-600 dark:text-slate-400 dark:text-slate-500">
                          {formatPercent(t.llm_fallback_rate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

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
