import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { clearToken } from '@/lib/auth';
import { useJobsList } from '@/queries/jobs';
import { cycleTheme, getTheme, type ThemeChoice } from '@/lib/theme';

/**
 * Top-level layout v2: sticky header с навигацией между основными
 * экранами + dropdown «Админ» для CRUD-страниц.
 *
 * Navigation:
 *   Главное (всегда видно): Dashboard / Документы / На проверке / Загрузить
 *   Админ ▾ (dropdown): Типы документов / Провайдеры / Справочники /
 *                       Организации / Тестовая лаборатория / Настройки / Audit log
 *
 * Sidebar отсутствует — экономим горизонтальное пространство, при
 * width < lg dropdown справляется лучше любого collapse'а.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-6 w-6 text-brand-600 dark:text-brand-400"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            </svg>
            parsedocs
            <span className="ml-1 rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
              v2
            </span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <NavItem to="/" end>
              Dashboard
            </NavItem>
            <NavItem to="/jobs">Документы</NavItem>
            <NavItem to="/review">
              <ReviewNavLabel />
            </NavItem>
            <NavItem to="/upload">Загрузить</NavItem>
            <AdminDropdown />
          </nav>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a
            href="/ui-legacy/"
            className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            title="Старая версия UI (страховка на случай rollback'а)"
          >
            Legacy →
          </a>
          <span className="hidden font-mono text-xs text-slate-400 dark:text-slate-500 lg:inline">
            {location.pathname}
          </span>
          <ThemeToggle />
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              clearToken();
              window.location.href = '/ui/login';
            }}
          >
            Выйти
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950">{children}</main>
    </div>
  );
}

/**
 * Theme toggle: один клик циклически переключает light → dark → system → light.
 * Иконка отображает текущий режим (солнце / луна / монитор).
 */
function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => getTheme());
  const title =
    choice === 'light'
      ? 'Тема: светлая. Клик → тёмная'
      : choice === 'dark'
      ? 'Тема: тёмная. Клик → системная'
      : 'Тема: по системе. Клик → светлая';
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => setChoice(cycleTheme())}
      title={title}
      aria-label={title}
    >
      {choice === 'light' && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 0 0-1.06-1.06l-1.062 1.06a.75.75 0 0 0 1.06 1.06l1.061-1.06ZM6.464 14.596a.75.75 0 0 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.062a.75.75 0 1 0-1.06 1.06l1.06 1.062ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 0 0-1.06 1.06l1.06 1.06Z" />
        </svg>
      )}
      {choice === 'dark' && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z" clipRule="evenodd" />
        </svg>
      )}
      {choice === 'system' && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v7.5A2.25 2.25 0 0 1 15.75 14H12v2h1.25a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5H8v-2H4.25A2.25 2.25 0 0 1 2 11.75v-7.5Zm1.5 0a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-.75.75H4.25a.75.75 0 0 1-.75-.75v-7.5Z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}

/**
 * Label для "На проверке" nav item с live-счётчиком количества
 * needs_review job'ов. Подтягивается через тот же useJobsList что
 * на самой странице — TanStack Query auto-dedupe + cache, поэтому
 * лишних запросов не делает.
 */
function ReviewNavLabel() {
  const { data } = useJobsList({ status: 'needs_review', limit: 100 });
  const count = data?.items.length ?? 0;
  return (
    <span className="flex items-center gap-1.5">
      На проверке
      {count > 0 && (
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {count}
        </span>
      )}
    </span>
  );
}

function NavItem({
  to,
  end,
  children,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `rounded-lg px-3 py-1.5 font-medium transition-colors ${
          isActive
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * Admin dropdown: типы документов, провайдеры, audit log + stub-страницы
 * (settings/tenants/reference-lists/test-lab — пока ведут в legacy).
 */
function AdminDropdown() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const isAdminActive =
    location.pathname.startsWith('/document-types') ||
    location.pathname.startsWith('/providers') ||
    location.pathname.startsWith('/reference-lists') ||
    location.pathname.startsWith('/tenants') ||
    location.pathname.startsWith('/test-lab') ||
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/audit-log');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`flex items-center gap-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${
          isAdminActive
            ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Админ
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            fillRule="evenodd"
            d="M12 15.75l-7-7 1.5-1.5L12 12.75l5.5-5.5 1.5 1.5z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <DropdownItem to="/document-types">Типы документов</DropdownItem>
          <DropdownItem to="/providers">Провайдеры (LLM/OCR)</DropdownItem>
          <DropdownItem to="/reference-lists">Справочники</DropdownItem>
          <DropdownItem to="/tenants">Организации</DropdownItem>
          <DropdownItem to="/test-lab">Тестовая лаборатория</DropdownItem>
          <DropdownItem to="/settings">Настройки</DropdownItem>
          <DropdownItem to="/audit-log">Audit log</DropdownItem>
        </div>
      )}
    </div>
  );
}

function DropdownItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `block px-4 py-2 text-sm transition-colors ${
          isActive
            ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
            : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
