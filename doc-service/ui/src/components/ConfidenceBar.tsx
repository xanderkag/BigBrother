import { formatPercent } from '@/lib/format';

/**
 * Inline-bar для отображения confidence в таблицах. В отличие от
 * текстового %, полоса даёт мгновенный «сканируемый глазами» сигнал
 * качества OCR/extraction: зелёный — ок, жёлтый — проверить,
 * красный — точно нет.
 *
 * Цветовая шкала зашита в trichromacy-friendly палитру:
 *   ≥ 0.85  emerald (норма)
 *   ≥ 0.6   amber   (нужен глаз)
 *   <  0.6  rose    (вероятно мусор)
 *
 * Размер: 90px полоса + 4ch % справа. Помещается в обычную колонку
 * таблицы без overflow. width=auto чтобы можно было расширять —
 * например в карточке job detail.
 */
interface ConfidenceBarProps {
  value: number | null | undefined;
  /** Ширина полоски в пикселях. По умолчанию 90 — для таблицы. */
  width?: number;
  /** Показывать ли % текстом справа. По умолчанию true. */
  showLabel?: boolean;
}

export default function ConfidenceBar({
  value,
  width = 90,
  showLabel = true,
}: ConfidenceBarProps) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="text-slate-400 dark:text-slate-500">—</span>;
  }
  const pct = Math.max(0, Math.min(1, value));
  const colorCls =
    pct >= 0.85
      ? 'bg-emerald-500 dark:bg-emerald-400'
      : pct >= 0.6
      ? 'bg-amber-500 dark:bg-amber-400'
      : 'bg-rose-500 dark:bg-rose-400';
  const labelCls =
    pct >= 0.85
      ? 'text-emerald-700 dark:text-emerald-300'
      : pct >= 0.6
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-rose-700 dark:text-rose-300';

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        className="relative inline-block h-1 overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-700"
        style={{ width }}
        aria-hidden="true"
      >
        <span
          className={`absolute inset-y-0 left-0 ${colorCls}`}
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      {showLabel && (
        <span className={`font-mono text-xs tabular-nums ${labelCls}`}>
          {formatPercent(pct)}
        </span>
      )}
    </span>
  );
}
