import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Кнопка-дропдаун для строки фильтров журнала. Управляется снаружи
 * (open/onToggle/onClose): страница держит «какое меню открыто» одним
 * стейтом, чтобы одновременно был открыт максимум один поповер.
 * Закрытие — клик вне поповера или Esc.
 */
export default function FilterDropdown({
  label,
  badge = 0,
  active = false,
  open,
  onToggle,
  onClose,
  children,
  align = 'left',
  widthClass = 'w-72',
}: {
  label: string;
  badge?: number;
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  widthClass?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="true"
        className={`inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-sm transition ${
          active
            ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-600'
        }`}
      >
        {label}
        {badge > 0 && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-sm bg-indigo-600 px-1 font-mono text-[10px] font-semibold text-white dark:bg-indigo-500">
            {badge}
          </span>
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3.5 w-3.5 text-slate-400 transition-transform dark:text-slate-500 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.22 7.22a.75.75 0 0 1 1.06 0L10 10.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute top-full z-30 mt-1 ${align === 'right' ? 'right-0' : 'left-0'} ${widthClass} max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
