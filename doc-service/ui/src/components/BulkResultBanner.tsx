import type { BulkResult } from '@/lib/bulk';
import { shortId } from '@/lib/format';

/**
 * F6 — единообразная сводка массовой операции: «N успешно», список ошибок
 * с причиной, кнопка «Повторить неуспешные». Показывается одинаково во всех
 * bulk-точках (Review, Jobs).
 */
interface Props {
  result: BulkResult;
  /** Повторить только неуспешные (по result.failed). */
  onRetry?: () => void;
  onDismiss: () => void;
  /** Идёт повтор — блокируем кнопку. */
  busy?: boolean;
}

export default function BulkResultBanner({ result, onRetry, onDismiss, busy }: Props) {
  const hasFailures = result.failed.length > 0;

  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        hasFailures
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">
          {hasFailures ? '⚠ ' : '✓ '}
          Готово: {result.succeeded.length} из {result.total} успешно
          {hasFailures && `, ${result.failed.length} с ошибкой`}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {hasFailures && onRetry && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={onRetry}
            >
              {busy ? 'Повторяю…' : `Повторить неуспешные (${result.failed.length})`}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost"
            onClick={onDismiss}
            aria-label="Скрыть сводку"
          >
            ✕
          </button>
        </div>
      </div>

      {hasFailures && (
        <ul className="mt-2 space-y-1 border-t border-amber-200 pt-2 dark:border-amber-800/60">
          {result.failed.map((f) => (
            <li key={f.id} className="flex gap-2 font-mono text-xs">
              <span className="shrink-0 text-amber-700 dark:text-amber-400">
                {shortId(f.id)}
              </span>
              <span className="min-w-0 break-words">{f.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
