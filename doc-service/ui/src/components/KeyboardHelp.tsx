import { useEffect } from 'react';

/**
 * F5 — шпаргалка по горячим клавишам (вызывается по `?`). Набор клавиш
 * зависит от страницы, поэтому строки передаются пропсом `items`.
 */
export interface KeyHelpItem {
  /** Подписи клавиш (несколько = синонимы, напр. ['j', '↓']). */
  keys: string[];
  label: string;
}

interface Props {
  open: boolean;
  items: KeyHelpItem[];
  onClose: () => void;
}

export default function KeyboardHelp({ open, items, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card flex w-full max-w-md flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">Горячие клавиши</h3>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>
        <ul className="space-y-2 p-5">
          {items.map((it) => (
            <li key={it.label} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-slate-700 dark:text-slate-300">{it.label}</span>
              <span className="flex shrink-0 items-center gap-1">
                {it.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="min-w-[1.5rem] rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-center font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
