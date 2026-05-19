import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';

/**
 * Global quick-search в TopBar. Behaviour:
 *   - Debounced 250ms — после паузы в наборе обновляет URL ?q=...
 *   - Если страница не /jobs — navigate('/jobs?q=...') с replace:false
 *     (push в history — пользователь может вернуться назад)
 *   - Если уже /jobs — обновляем существующие searchParams (не теряем
 *     активный status/document_type фильтр)
 *   - ESC очищает + расфокусирует
 *   - Cmd/Ctrl-K — глобальный shortcut фокусит инпут
 *
 * NOTE: q стейт держим локально + sync с URL. Когда юзер открывает
 * /jobs?q=invoice по прямой ссылке, инициализируемся из URL.
 */
export default function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get('q') ?? '';
  const [value, setValue] = useState(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);

  // Если URL changed extern'ом (browser back/forward) — синкаемся
  useEffect(() => {
    setValue(urlQ);
  }, [urlQ]);

  // Debounce: 250ms после последнего нажатия → push в URL.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === urlQ) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(
        location.pathname === '/jobs' ? searchParams : {},
      );
      if (trimmed) next.set('q', trimmed);
      else next.delete('q');
      next.delete('offset'); // сброс пагинации при изменении поиска
      const search = next.toString();
      const targetPath = location.pathname === '/jobs' ? '/jobs' : '/jobs';
      navigate(`${targetPath}${search ? '?' + search : ''}`, {
        replace: location.pathname === '/jobs',
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Global ⌘K / Ctrl-K — фокус
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative flex items-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400 dark:text-slate-500"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
          clipRule="evenodd"
        />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue('');
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="filename, id, ИНН…"
        aria-label="Quick search"
        className="w-56 rounded-sm border border-slate-200 bg-white py-1 pl-7 pr-12 font-mono text-xs text-slate-800 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-400 dark:focus:ring-indigo-400"
      />
      <kbd className="pointer-events-none absolute right-1.5 hidden rounded-sm border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 sm:inline">
        ⌘K
      </kbd>
    </div>
  );
}
