import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { clearToken } from '@/lib/auth';
import { useJobsList } from '@/queries/jobs';
import { useCurrentUser } from '@/queries/me';
import { useOrganizations } from '@/queries/tenants';
import { useDocumentTypes } from '@/queries/documentTypes';
import { useReferenceListTypes } from '@/queries/referenceLists';
import { useReady } from '@/queries/health';
import { usePermissions, type AccessLevel } from '@/lib/permissions';
import { useWorkspaceOrgId } from '@/lib/workspace';
import { cycleTheme, getTheme, type ThemeChoice } from '@/lib/theme';
import { useSidebarCollapsed } from '@/lib/sidebar';
import SearchBox from './SearchBox';

/**
 * Top-level layout v2 (2026-05-19 brutalist redesign):
 *   - Левый sidebar 240px (workspace + nav со счётчиками + user)
 *   - Главная зона: breadcrumb-header (тонкая) + content
 *
 * Sidebar — основной навигационный путь. Active item подсвечивается
 * толстой левой полосой акцентного цвета (как в Document AI/Acrobat).
 * Counts по разделам подтягиваются live: JOBS / REVIEW / DOCUMENT TYPES /
 * PROVIDERS / TENANTS / REFERENCE LISTS. Все запросы кэшируются TanStack
 * Query — если та же страница уже их сделала, hit cache.
 *
 * Mobile (< lg): sidebar сворачивается в overlay drawer по клику на
 * burger в шапке. Десктоп-first — конкурсу хватает.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const location = useLocation();

  // Закрываем drawer при переходе на новый route
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // Keyboard shortcut: Ctrl/Cmd + B — toggle desktop sidebar (как в VS Code).
  // Не трогаем mobile-drawer: на маленьких экранах клавиатуры обычно нет,
  // а если есть, поведение «toggle sidebar» там не применимо (drawer).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        // Не перехватываем, если фокус в input/textarea/contenteditable — там Ctrl+B = bold
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          t?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, setCollapsed]);

  // На mobile (drawer) всегда показываем full-width, иначе collapsed-режим
  // выглядит сломанным в overlay'е. Mobile-drawer и так sliding panel.
  const effectiveCollapsed = mobileOpen ? false : collapsed;

  return (
    <div className="flex h-full bg-slate-50 dark:bg-slate-950">
      {/* Sidebar */}
      <aside
        className={`group/sidebar fixed inset-y-0 left-0 z-30 flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[transform,width] duration-200 dark:border-slate-800 dark:bg-slate-900 lg:static lg:translate-x-0 ${
          effectiveCollapsed ? 'w-14' : 'w-60'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <SidebarHeader
          collapsed={effectiveCollapsed}
          onToggle={() => setCollapsed(!collapsed)}
        />
        <WorkspaceBlock collapsed={effectiveCollapsed} />
        <SidebarNav collapsed={effectiveCollapsed} />
        <SidebarFooter collapsed={effectiveCollapsed} />

        {/* Thin clickable edge strip — десктоп-only, дублирует toggle.
            Висит на правом краю sidebar'а, расширяется при hover. Даёт
            пользователю «двери» — самый ожидаемый паттерн (VS Code,
            JetBrains). aria-hidden — основной toggle уже доступен с
            клавиатуры/screen reader из SidebarHeader. */}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-hidden="true"
          tabIndex={-1}
          title={`${collapsed ? 'Развернуть' : 'Свернуть'} панель (Ctrl+B)`}
          className="absolute inset-y-0 right-0 hidden w-1 cursor-pointer bg-transparent transition-colors hover:bg-indigo-500/30 dark:hover:bg-indigo-400/30 lg:block"
        />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onBurgerClick={() => setMobileOpen((v) => !v)} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

/* ─── Sidebar pieces ─────────────────────────────────────────────── */

function SidebarHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-center border-b border-slate-200 py-3.5 dark:border-slate-800 ${
        collapsed ? 'flex-col gap-2 px-2' : 'gap-2.5 px-4'
      }`}
      title={collapsed ? 'parsedocs · doc intelligence' : undefined}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-indigo-600 text-white dark:bg-indigo-500">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        </svg>
      </div>
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight text-slate-900 dark:text-slate-100">
            parsedocs
          </div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
            doc intelligence
          </div>
        </div>
      )}
      {/* Prominent toggle — десктоп-only. Раньше был узкой полоской внизу
          (commit 9a65635) и пользователь его не находил. Теперь сидит
          справа от лого, всегда видимый, с Ctrl+B-подсказкой. */}
      <button
        type="button"
        onClick={onToggle}
        className="hidden shrink-0 items-center justify-center rounded-sm p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 lg:inline-flex"
        title={`${collapsed ? 'Развернуть' : 'Свернуть'} панель (Ctrl+B)`}
        aria-label={`${collapsed ? 'Развернуть' : 'Свернуть'} панель (Ctrl+B)`}
        aria-keyshortcuts="Control+B"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-180'}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

function WorkspaceBlock({ collapsed }: { collapsed: boolean }) {
  const me = useCurrentUser();
  const orgs = useOrganizations();
  const [orgId, setOrgId] = useWorkspaceOrgId();
  const isSuperAdmin = me.data?.is_super_admin ?? false;
  const orgList = orgs.data?.items ?? [];

  useEffect(() => {
    if (orgId || !me.data) return;
    if (isSuperAdmin) {
      const def = orgList.find((o) => o.type !== 'system') ?? orgList[0];
      if (def) setOrgId(def.id);
    } else if (me.data.organization_id) {
      setOrgId(me.data.organization_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data, orgList.length]);

  const currentOrg = orgList.find((o) => o.id === orgId);

  if (collapsed) {
    // В свёрнутом виде — просто индикатор в центре с tooltip'ом
    return (
      <div
        className="flex justify-center border-b border-slate-200 px-2 py-3 dark:border-slate-800"
        title={currentOrg ? `Workspace: ${currentOrg.name}` : 'Workspace'}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            currentOrg ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'
          }`}
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        workspace
      </div>
      {isSuperAdmin && orgList.length > 0 ? (
        <select
          className="w-full rounded-sm border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 hover:border-slate-300 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-slate-600"
          value={orgId ?? ''}
          onChange={(e) => setOrgId(e.target.value || null)}
          title="Выбрать организацию"
        >
          {orgList.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : currentOrg ? (
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
            {currentOrg.name}
          </span>
        </div>
      ) : (
        <div className="h-7 w-full animate-pulse rounded-sm bg-slate-100 dark:bg-slate-800" />
      )}
    </div>
  );
}

interface NavEntry {
  to: string;
  label: string;
  icon: React.ReactNode;
  count?: number;
  /** end=true для точного матча роута (/, иначе любой подпуть подсветится). */
  end?: boolean;
  /** F9 — минимальный уровень доступа для показа пункта (нет → виден всем). */
  min?: AccessLevel;
}

interface NavGroup {
  /** Заголовок секции (uppercase). null → без заголовка (РАБОТА вверху). */
  title: string | null;
  entries: NavEntry[];
}

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  // Counts. Все эти запросы — обычные ReactQuery hits, кэшируются.
  // Limit=1 для jobs/review чтобы не качать полный список (нужен только total).
  const jobsCnt = useJobsList({ limit: 1 });
  const reviewCnt = useJobsList({ status: 'needs_review', limit: 1 });
  const docTypes = useDocumentTypes();
  const [orgId] = useWorkspaceOrgId();
  const refLists = useReferenceListTypes(orgId);
  const perms = usePermissions();

  // Навигация — 4 логических группы. РАБОТА видна всем (Загрузка — writer+),
  // ДАННЫЕ / ДОСТУП / НАСТРОЙКИ — только админам. Тест-лаборатория и
  // Журнал аудита переехали внутрь хаба «Настройки» и теперь тоже под admin.
  const groups: NavGroup[] = useMemo(
    () => [
      {
        title: null,
        entries: [
          { to: '/', end: true, label: 'Сводка', icon: <IconDashboard /> },
          { to: '/review', label: 'Очередь ревью', icon: <IconCircle />, count: reviewCnt.data?.total },
          { to: '/jobs', label: 'Журнал работ', icon: <IconFile />, count: jobsCnt.data?.total },
          { to: '/upload', label: 'Загрузка', icon: <IconUpload />, min: 'writer' },
        ],
      },
      {
        title: 'Данные',
        entries: [
          { to: '/document-types', label: 'Типы документов', icon: <IconGrid />, count: docTypes.data?.items.length, min: 'admin' },
          { to: '/reference-lists', label: 'Справочники', icon: <IconList />, count: refLists.data?.length, min: 'admin' },
        ],
      },
      {
        title: 'Доступ',
        entries: [
          { to: '/organizations', label: 'Организации', icon: <IconList />, min: 'admin' },
          { to: '/access', label: 'Доступ', icon: <IconList />, min: 'admin' },
        ],
      },
      {
        title: 'Настройки',
        entries: [
          { to: '/settings', end: true, label: 'Настройки', icon: <IconGear />, min: 'admin' },
        ],
      },
    ],
    [jobsCnt.data?.total, reviewCnt.data?.total, docTypes.data?.items.length, refLists.data?.length],
  );

  // F9 — фильтр по роли. Пока /users/me не загружен (perms.ready=false) —
  // показываем только пункты без ограничения, чтобы не мигнуть админ-меню.
  const canSee = (e: NavEntry) => !e.min || (perms.ready && perms.can(e.min));
  const visibleGroups = groups
    .map((g) => ({ ...g, entries: g.entries.filter(canSee) }))
    .filter((g) => g.entries.length > 0);

  return (
    <nav className={`flex-1 overflow-y-auto py-3 ${collapsed ? 'px-1.5' : 'px-2'}`}>
      {visibleGroups.map((g, i) => (
        <div
          key={g.title ?? '_main'}
          className={i > 0 ? 'mt-4 border-t border-slate-200 pt-3 dark:border-slate-800' : ''}
        >
          {g.title && !collapsed && (
            <div className="px-2.5 pb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {g.title}
            </div>
          )}
          <div className="space-y-0.5">
            {g.entries.map((e) => (
              <NavItem key={e.to} entry={e} collapsed={collapsed} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavItem({ entry, collapsed }: { entry: NavEntry; collapsed: boolean }) {
  return (
    <NavLink
      to={entry.to}
      end={entry.end}
      title={collapsed ? `${entry.label}${entry.count !== undefined ? ` (${entry.count})` : ''}` : undefined}
      className={({ isActive }) =>
        `group relative flex items-center rounded-sm font-mono text-[11px] uppercase tracking-wider transition-colors ${
          collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-2.5 py-1.5'
        } ${
          isActive
            ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {/* Left accent border для активного item'а */}
          {isActive && (
            <span
              className="absolute inset-y-0 left-0 w-0.5 bg-indigo-600 dark:bg-indigo-400"
              aria-hidden="true"
            />
          )}
          <span className="relative shrink-0 text-slate-400 group-hover:text-current dark:text-slate-500">
            {entry.icon}
            {/* §9 polish — в свёрнутом виде раньше был безликий dot; теперь
                показываем само число (как notification-бейдж), >99 → «99+»,
                чтобы влезть в узкую рейку. Полное число и в title NavLink. */}
            {collapsed && entry.count !== undefined && entry.count > 0 && (
              <span
                className="absolute -right-2 -top-1.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-indigo-500 px-1 font-mono text-[9px] font-semibold leading-none text-white dark:bg-indigo-400 dark:text-slate-900"
                aria-hidden="true"
              >
                {entry.count > 99 ? '99+' : entry.count}
              </span>
            )}
          </span>
          {!collapsed && <span className="flex-1 truncate">{entry.label}</span>}
          {!collapsed && entry.count !== undefined && (
            <span
              className={`shrink-0 rounded-sm px-1 text-[10px] tabular-nums ${
                isActive
                  ? 'bg-indigo-200/60 text-indigo-800 dark:bg-indigo-800/40 dark:text-indigo-200'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
              }`}
            >
              {entry.count}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const me = useCurrentUser();
  const user = me.data;
  // id у нас UUID — берём первые 2 hex'а как инициалы. Не идеально, но
  // лучше, чем «??». Для system-токена id='system' → 'SY'.
  const initials = useMemo(() => {
    if (!user) return '··';
    if (user.id === 'system') return 'SY';
    return user.id.slice(0, 2).toUpperCase();
  }, [user]);
  if (!user) {
    return <div className="h-14 border-t border-slate-200 dark:border-slate-800" />;
  }
  if (collapsed) {
    // Свёрнут: только аватар-инициалы по центру, logout перемещается в tooltip
    // (через right-click меню это не сделать — а если очень надо logout, развернёт).
    return (
      <div
        className="flex justify-center border-t border-slate-200 px-2 py-2.5 dark:border-slate-800"
        title={`${user.is_super_admin ? 'super admin' : user.role ?? 'user'} · ${user.id}`}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-slate-200 font-mono text-[11px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
          {initials}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 border-t border-slate-200 px-3 py-2.5 dark:border-slate-800">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-slate-200 font-mono text-[11px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-slate-800 dark:text-slate-200" title={user.id}>
          {user.id === 'system' ? 'system' : user.id.slice(0, 8)}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {user.is_super_admin ? 'super admin' : user.role ?? 'user'}
        </div>
      </div>
      <button
        type="button"
        className="rounded-sm p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-rose-400"
        onClick={() => {
          clearToken();
          window.location.href = '/ui/login';
        }}
        title="Выйти"
        aria-label="Выйти"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path
            fillRule="evenodd"
            d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Zm10.47 4.28a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1 0 1.06l-2.5 2.5a.75.75 0 1 1-1.06-1.06l1.22-1.22H7.75a.75.75 0 0 1 0-1.5h6.94l-1.22-1.22a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

/* ─── Main column top bar ────────────────────────────────────────── */

function TopBar({ onBurgerClick }: { onBurgerClick: () => void }) {
  const location = useLocation();
  const me = useCurrentUser();
  const orgs = useOrganizations();
  const [orgId] = useWorkspaceOrgId();
  const currentOrg = orgs.data?.items.find((o) => o.id === orgId);

  // Breadcrumb из pathname.  /jobs/abc → "Jobs / abc…", /tenants → "Tenants"
  const crumbs = useMemo(() => buildCrumbs(location.pathname), [location.pathname]);

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3 min-w-0">
        {/* Burger — только на mobile */}
        <button
          type="button"
          className="-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 lg:hidden"
          onClick={onBurgerClick}
          aria-label="Меню"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 10a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 10Zm0 5.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
          </svg>
        </button>
        <nav className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-xs uppercase tracking-wider">
          {currentOrg && (
            <>
              <span className="truncate text-slate-500 dark:text-slate-400">{currentOrg.name}</span>
              <ChevronRight />
            </>
          )}
          {crumbs.map((c, i) => (
            <span key={c.to ?? i} className="flex shrink-0 items-center gap-2">
              {c.to ? (
                <Link
                  to={c.to}
                  className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                >
                  {c.label}
                </Link>
              ) : (
                <span className="text-slate-900 dark:text-slate-100">{c.label}</span>
              )}
              {i < crumbs.length - 1 && <ChevronRight />}
            </span>
          ))}
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <SearchBox />
        <SystemStatusBadge />
        <ThemeToggle />
        {me.data && (
          <span
            className="hidden font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 md:inline"
            title={me.data.id}
          >
            {me.data.is_super_admin ? 'super admin' : me.data.role}
          </span>
        )}
      </div>
    </header>
  );
}

interface Crumb {
  label: string;
  to: string | null;
}

function buildCrumbs(pathname: string): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return [{ label: 'Сводка', to: null }];
  const labels: Record<string, string> = {
    jobs: 'Журнал работ',
    review: 'Очередь ревью',
    upload: 'Загрузка',
    'document-types': 'Типы документов',
    organizations: 'Организации',
    access: 'Доступ',
    'reference-lists': 'Справочники',
    settings: 'Настройки',
    providers: 'Провайдеры/модели',
    audit: 'Журнал аудита',
    lab: 'Тест-лаборатория',
  };
  return parts.map((p, i) => {
    const isLast = i === parts.length - 1;
    const label = labels[p] ?? p;
    return { label, to: isLast ? null : '/' + parts.slice(0, i + 1).join('/') };
  });
}

function ChevronRight() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 text-slate-400 dark:text-slate-600">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
    </svg>
  );
}

function SystemStatusBadge() {
  const { data } = useReady();
  const state = data?.state ?? 'loading';
  const dot =
    state === 'healthy'
      ? 'bg-emerald-500'
      : state === 'degraded'
      ? 'bg-amber-500'
      : 'bg-slate-400 dark:bg-slate-600';
  const label =
    state === 'healthy' ? 'система в норме' : state === 'degraded' ? 'деградация' : 'проверка…';
  const title =
    state === 'degraded' && data?.failures
      ? `Недоступны зависимости: ${data.failures}`
      : undefined;
  return (
    <span
      className="hidden items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 sm:inline-flex"
      title={title}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

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
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 md:h-8 md:w-8"
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

/* ─── Icons ──────────────────────────────────────────────────────── */

function IconDashboard() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M3 4.75A1.75 1.75 0 0 1 4.75 3h2.5A1.75 1.75 0 0 1 9 4.75v2.5A1.75 1.75 0 0 1 7.25 9h-2.5A1.75 1.75 0 0 1 3 7.25v-2.5Zm8 0A1.75 1.75 0 0 1 12.75 3h2.5A1.75 1.75 0 0 1 17 4.75v2.5A1.75 1.75 0 0 1 15.25 9h-2.5A1.75 1.75 0 0 1 11 7.25v-2.5ZM3 12.75A1.75 1.75 0 0 1 4.75 11h2.5A1.75 1.75 0 0 1 9 12.75v2.5A1.75 1.75 0 0 1 7.25 17h-2.5A1.75 1.75 0 0 1 3 15.25v-2.5Zm8 0A1.75 1.75 0 0 1 12.75 11h2.5A1.75 1.75 0 0 1 17 12.75v2.5A1.75 1.75 0 0 1 15.25 17h-2.5A1.75 1.75 0 0 1 11 15.25v-2.5Z" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M4 4a2 2 0 0 1 2-2h6l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Z" />
    </svg>
  );
}

function IconCircle() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <circle cx="10" cy="10" r="6" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M10 2a.75.75 0 0 1 .75.75v9.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V2.75A.75.75 0 0 1 10 2ZM3.75 16a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H3.75Z" transform="rotate(180 10 10)" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <rect x="3" y="3" width="6" height="6" />
      <rect x="11" y="3" width="6" height="6" />
      <rect x="3" y="11" width="6" height="6" />
      <rect x="11" y="11" width="6" height="6" />
    </svg>
  );
}

function IconList() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="h-3.5 w-3.5">
      <line x1="4" y1="5" x2="16" y2="5" />
      <line x1="4" y1="10" x2="16" y2="10" />
      <line x1="4" y1="15" x2="16" y2="15" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
    </svg>
  );
}
