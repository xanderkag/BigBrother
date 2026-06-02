import { useEffect, type ReactNode } from 'react';

/**
 * F10 — единый модал подтверждения вместо браузерных confirm()/alert().
 *
 * Контролируемый компонент: родитель держит `open` и закрывает по
 * `onCancel` / после успешной мутации. Закрытие — по Esc / клику вне /
 * «Отмена». Кнопка «Подтвердить» дизейблится на время запроса (`busy`).
 *
 * Зачем не window.confirm: некрасиво, легко прокликать, не несёт контекста
 * (имя объекта, последствие). Правило CLAUDE.md «действия с внешними
 * последствиями — через явное подтверждение» требует осознанности; для
 * redeliver-webhook (данные уходят во внешнюю систему) — отдельный warning.
 */
interface Props {
  open: boolean;
  title: string;
  /** Основной текст-описание последствия. */
  description?: ReactNode;
  /** Имя объекта действия (выделяется). */
  objectName?: string;
  /** Доп. предупреждение (амбер-баннер) — для внешних эффектов. */
  warning?: ReactNode;
  /** Ошибка последней попытки — показывается inline, модал не закрывается. */
  error?: string | null;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Необратимое/разрушительное действие → акцентная красная кнопка. */
  destructive?: boolean;
  /** Запрос в полёте — блокирует «Подтвердить» и закрытие. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  objectName,
  warning,
  error,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  // Esc закрывает (если не идёт запрос). Хук — до раннего return, чтобы
  // порядок хуков не менялся между рендерами.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card flex w-full max-w-md flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h3 className="card-title">{title}</h3>
        </div>
        <div className="space-y-3 p-5 text-sm text-slate-700 dark:text-slate-300">
          {description && <div>{description}</div>}
          {objectName && (
            <div className="rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
              {objectName}
            </div>
          )}
          {warning && (
            <div className="warning-banner">
              <span aria-hidden>⚠</span>
              <div>{warning}</div>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <span className="font-medium">Ошибка:</span> {error}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Выполняю…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
