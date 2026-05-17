import { Link, NavLink, useLocation } from 'react-router-dom';
import { clearToken } from '@/lib/auth';
import { useJobsList } from '@/queries/jobs';

/**
 * Top-level layout v2: sticky header с навигацией между основными
 * экранами (Dashboard / Jobs / Upload). Sidebar отсутствует —
 * экономим горизонтальное пространство, остальные экраны (admin,
 * audit log) уйдут в выпадающее меню когда мигрируем их.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-2.5 shadow-sm">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-6 w-6 text-brand-600"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            </svg>
            parsedocs
            <span className="ml-1 rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700">
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
          </nav>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a
            href="/ui/"
            className="rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"
            title="Старый UI (полный набор экранов)"
          >
            Старый UI →
          </a>
          <span className="hidden font-mono text-xs text-slate-400 lg:inline">
            {location.pathname}
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              clearToken();
              window.location.href = '/v2/login';
            }}
          >
            Выйти
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-auto bg-slate-50">{children}</main>
    </div>
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
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
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
            ? 'bg-brand-50 text-brand-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`
      }
    >
      {children}
    </NavLink>
  );
}
