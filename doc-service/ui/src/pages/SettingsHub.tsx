import { NavLink, Outlet } from 'react-router-dom';

/**
 * Настройки — таб-хаб админских конфиг-разделов. Сами панели —
 * существующие страницы (Settings / Providers / AuditLog / TestLab),
 * подключённые как вложенные роуты для deep-link'а:
 *   /settings           → Общие
 *   /settings/providers → Провайдеры/модели
 *   /settings/audit     → Журнал аудита
 *   /settings/lab       → Тест-лаборатория
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '/settings', label: 'Общие', end: true },
  { to: '/settings/providers', label: 'Провайдеры/модели' },
  { to: '/settings/audit', label: 'Журнал аудита' },
  { to: '/settings/lab', label: 'Тест-лаборатория' },
];

export default function SettingsHub() {
  return (
    <div className="flex flex-col">
      <nav className="sticky top-12 z-[5] flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `whitespace-nowrap border-b-2 px-3 py-2.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                isActive
                  ? 'border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
