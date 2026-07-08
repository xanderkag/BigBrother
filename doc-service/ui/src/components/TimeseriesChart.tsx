import { useMemo, useState } from 'react';
import type { TimeseriesBucket } from '@/queries/metrics';

/**
 * TimeseriesChart — простой SVG-график из бакетов /metrics/timeseries.
 *
 * Показывает стек-бары: `done` (изумруд), `needs_review` (янтарь),
 * `failed` (розовый), плюс серый залив для «всего остального» (pending +
 * processing). Ось X подписана по 4 равномерным точкам, ось Y — макс.
 * Скошенная линия сверху дублирует latency_p95_ms в mс если задан
 * пропс `showLatencyOverlay`.
 *
 * Без внешних chart-библиотек — 100% ручной SVG. Причины:
 *   - recharts/chart.js добавляют 130+ KB gzipped, здесь нужно 4 бара + 1 линия
 *   - консистентность стиля с брутальным sidebar'ом легче держать своим кодом
 *   - responsive легко: viewBox + preserveAspectRatio делают SVG scale'абельным
 *
 * Ховер по бару: маленький tooltip с временем + числами. Достаточно для
 * оператора «а что вон там за спайк был». Без клика — детали открываются
 * через смежную ленту документов.
 */

interface TimeseriesChartProps {
  buckets: TimeseriesBucket[];
  bucketMinutes: number;
  /** Показать линию latency P95 поверх баров. Default false. */
  showLatencyOverlay?: boolean;
  /** Пропорции. Default 800×200. */
  width?: number;
  height?: number;
}

// SVG viewBox константы. Padding даёт место под подписи осей.
const PAD_L = 40; // левое поле (метки Y)
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 24; // нижнее (метки X)

export default function TimeseriesChart({
  buckets,
  bucketMinutes,
  showLatencyOverlay = false,
  width = 800,
  height = 200,
}: TimeseriesChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const chartW = width - PAD_L - PAD_R;
  const chartH = height - PAD_T - PAD_B;

  // Максимум по стеку (total) — для скейла оси Y.
  const yMax = useMemo(() => {
    const m = buckets.reduce((acc, b) => Math.max(acc, b.total), 0);
    // Round up to nearest 5 / 10 / 100 для чистых меток.
    if (m === 0) return 1;
    if (m <= 5) return m;
    if (m <= 20) return Math.ceil(m / 5) * 5;
    if (m <= 100) return Math.ceil(m / 10) * 10;
    return Math.ceil(m / 50) * 50;
  }, [buckets]);

  // Latency max (для overlay)
  const latMax = useMemo(() => {
    if (!showLatencyOverlay) return 0;
    const m = buckets.reduce(
      (acc, b) => (b.latency_p95_ms !== null ? Math.max(acc, b.latency_p95_ms) : acc),
      0,
    );
    return m || 1;
  }, [buckets, showLatencyOverlay]);

  // Ширина одного бара с небольшим gap'ом.
  const barW = buckets.length > 0 ? (chartW / buckets.length) * 0.85 : 0;
  const barStep = buckets.length > 0 ? chartW / buckets.length : 0;

  // Форматирование метки времени по ширине бакета.
  const fmtTs = (ts: string): string => {
    const d = new Date(ts);
    // <24h окно → часы:минуты; иначе день+месяц.
    if (bucketMinutes < 60 * 12) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  };

  // 4 равномерных подписи X — первая, треть, две трети, последняя.
  const xLabels = useMemo(() => {
    if (buckets.length === 0) return [];
    const idxs = [
      0,
      Math.floor(buckets.length / 3),
      Math.floor((buckets.length * 2) / 3),
      buckets.length - 1,
    ];
    return idxs.map((i) => ({ i, label: fmtTs(buckets[i]!.ts) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, bucketMinutes]);

  // Точки линии latency (в SVG-координатах).
  const latencyPath = useMemo(() => {
    if (!showLatencyOverlay || buckets.length === 0) return '';
    const pts = buckets
      .map((b, i) => {
        if (b.latency_p95_ms === null) return null;
        const x = PAD_L + barStep * i + barStep / 2;
        const y = PAD_T + chartH - (b.latency_p95_ms / latMax) * chartH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter((p): p is string => p !== null);
    return pts.length === 0 ? '' : `M${pts.join(' L')}`;
  }, [buckets, barStep, latMax, chartH, showLatencyOverlay]);

  if (buckets.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-slate-400 dark:text-slate-500">
        Нет данных за период
      </div>
    );
  }

  const yTicks = [0, 0.5, 1].map((f) => Math.round(yMax * f));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Y-grid + метки */}
        {yTicks.map((v, i) => {
          const y = PAD_T + chartH - (v / yMax) * chartH;
          return (
            <g key={i}>
              <line
                x1={PAD_L}
                y1={y}
                x2={width - PAD_R}
                y2={y}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-slate-200 dark:text-slate-800"
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                fontSize="10"
                textAnchor="end"
                className="fill-slate-500 dark:fill-slate-400 font-mono"
              >
                {v}
              </text>
            </g>
          );
        })}

        {/* Бары */}
        {buckets.map((b, i) => {
          const x = PAD_L + barStep * i + (barStep - barW) / 2;
          const totalH = (b.total / yMax) * chartH;
          const doneH = (b.done / yMax) * chartH;
          const nrH = (b.needs_review / yMax) * chartH;
          const failedH = (b.failed / yMax) * chartH;
          // Оставшееся (pending + processing) = total - done - nr - failed
          const restH = totalH - doneH - nrH - failedH;
          let cursorY = PAD_T + chartH;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoverIdx(i)}
              className={hoverIdx === i ? 'opacity-100' : hoverIdx === null ? 'opacity-100' : 'opacity-40'}
            >
              {/* невидимый ловец событий на всю высоту столбца */}
              <rect
                x={PAD_L + barStep * i}
                y={PAD_T}
                width={barStep}
                height={chartH}
                fill="transparent"
              />
              {/* done — самый низ (emerald-500) */}
              {doneH > 0 && (
                <rect
                  x={x}
                  y={(cursorY -= doneH)}
                  width={barW}
                  height={doneH}
                  className="fill-emerald-500 dark:fill-emerald-400"
                />
              )}
              {/* needs_review (amber-500) */}
              {nrH > 0 && (
                <rect
                  x={x}
                  y={(cursorY -= nrH)}
                  width={barW}
                  height={nrH}
                  className="fill-amber-500 dark:fill-amber-400"
                />
              )}
              {/* failed (rose-500) */}
              {failedH > 0 && (
                <rect
                  x={x}
                  y={(cursorY -= failedH)}
                  width={barW}
                  height={failedH}
                  className="fill-rose-500 dark:fill-rose-400"
                />
              )}
              {/* «в очереди/обработке» — серый сверху */}
              {restH > 0 && (
                <rect
                  x={x}
                  y={(cursorY -= restH)}
                  width={barW}
                  height={restH}
                  className="fill-slate-300 dark:fill-slate-600"
                />
              )}
            </g>
          );
        })}

        {/* Latency overlay */}
        {showLatencyOverlay && latencyPath && (
          <path
            d={latencyPath}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-indigo-500 dark:text-indigo-400"
          />
        )}

        {/* Ось X — базовая линия */}
        <line
          x1={PAD_L}
          y1={PAD_T + chartH}
          x2={width - PAD_R}
          y2={PAD_T + chartH}
          stroke="currentColor"
          className="text-slate-300 dark:text-slate-700"
          strokeWidth={0.5}
        />

        {/* X-метки */}
        {xLabels.map(({ i, label }) => (
          <text
            key={i}
            x={PAD_L + barStep * i + barStep / 2}
            y={height - 8}
            fontSize="10"
            textAnchor="middle"
            className="fill-slate-500 dark:fill-slate-400 font-mono"
          >
            {label}
          </text>
        ))}
      </svg>

      {/* Tooltip при hover'е — простой div поверх */}
      {hoverIdx !== null && buckets[hoverIdx] && (
        <TooltipBox bucket={buckets[hoverIdx]!} />
      )}

      {/* Легенда */}
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <LegendDot color="bg-emerald-500 dark:bg-emerald-400" label="готово" />
        <LegendDot color="bg-amber-500 dark:bg-amber-400" label="на проверке" />
        <LegendDot color="bg-rose-500 dark:bg-rose-400" label="ошибка" />
        <LegendDot color="bg-slate-300 dark:bg-slate-600" label="в работе" />
        {showLatencyOverlay && (
          <LegendDot color="bg-indigo-500 dark:bg-indigo-400" label="latency p95" />
        )}
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${color}`} />
      {label}
    </span>
  );
}

function TooltipBox({ bucket }: { bucket: TimeseriesBucket }) {
  const ts = new Date(bucket.ts);
  return (
    <div className="pointer-events-none absolute right-2 top-1 rounded-sm border border-slate-200 bg-white/95 px-2 py-1 text-[10px] font-mono text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-300">
      <div className="text-slate-500 dark:text-slate-400">
        {ts.toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
      <div className="mt-0.5 space-y-0.5">
        <div>всего: <span className="font-semibold">{bucket.total}</span></div>
        {bucket.done > 0 && (
          <div>
            готово: <span className="font-semibold text-emerald-700 dark:text-emerald-300">{bucket.done}</span>
          </div>
        )}
        {bucket.needs_review > 0 && (
          <div>
            на проверке: <span className="font-semibold text-amber-700 dark:text-amber-300">{bucket.needs_review}</span>
          </div>
        )}
        {bucket.failed > 0 && (
          <div>
            ошибок: <span className="font-semibold text-rose-700 dark:text-rose-300">{bucket.failed}</span>
          </div>
        )}
        {bucket.latency_p95_ms !== null && (
          <div className="text-slate-500 dark:text-slate-400">
            latency p95: {bucket.latency_p95_ms < 1000
              ? `${bucket.latency_p95_ms} мс`
              : `${(bucket.latency_p95_ms / 1000).toFixed(1)} с`}
          </div>
        )}
      </div>
    </div>
  );
}
