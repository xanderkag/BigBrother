import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';
import { useCurrentUser } from '@/queries/me';
import { usePermissions, type AccessLevel } from '@/lib/permissions';
import LoginPage from '@/pages/Login';
import DashboardPage from '@/pages/Dashboard';
import JobsListPage from '@/pages/JobsList';
import JobDetailPage from '@/pages/JobDetail';
import UploadPage from '@/pages/Upload';
import ReviewQueuePage from '@/pages/ReviewQueue';
import DocumentTypesPage from '@/pages/DocumentTypes';
import ProvidersPage from '@/pages/Providers';
import IntegrationsPage from '@/pages/Integrations';
import AuditLogPage from '@/pages/AuditLog';
import SettingsPage from '@/pages/Settings';
import SettingsHub from '@/pages/SettingsHub';
import OrganizationsPage from '@/pages/Organizations';
import AccessPage from '@/pages/Access';
import ReferenceListsPage, { ReferenceListEntriesPage } from '@/pages/ReferenceLists';
import TestLabPage from '@/pages/TestLab';
import Layout from '@/components/Layout';

/**
 * App routes — UI v2 (feature-parity со старым vanilla UI, legacy теперь
 * только страховка на случай rollback'а — будет удалён после стабильной
 * работы 1-2 месяца).
 *
 *   /                       → ролезависимый лендинг: оператор (manager/viewer)
 *                             → /review, админ → Dashboard (операционные метрики)
 *   /jobs                   → JobsList (таблица всех документов)
 *   /jobs/:id               → JobDetail (PDF + extracted data + edit)
 *   /upload                 → Upload (bulk drag-drop)
 *   /review                 → ReviewQueue (needs_review с bulk approve)
 *   /document-types         → CRUD типов документов
 *   /organizations          → Компании + проекты (admin)
 *   /access                 → Пользователи + системы (admin)
 *   /settings               → Настройки-хаб с вкладками (admin):
 *     /settings             → Общие (snapshot конфига + статус LLM)
 *     /settings/providers   → CRUD LLM/OCR провайдеров
 *     /settings/audit       → Audit log viewer
 *     /settings/lab         → Тест-лаборатория (single doc + provider picker)
 *   /reference-lists        → Список типов справочников
 *   /reference-lists/:slug  → Записи конкретного справочника
 *   /login                  → Login (если нет токена в localStorage)
 *
 *   Legacy-редиректы (старые закладки): /tenants → /organizations,
 *   /providers → /settings/providers, /audit-log → /settings/audit,
 *   /test-lab → /settings/lab.
 *
 * Всё внутри Layout проверяется через RequireAuth — нет токена →
 * редирект на /login.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route index element={<LandingRoute />} />
                <Route path="jobs" element={<JobsListPage />} />
                <Route path="jobs/:jobId" element={<JobDetailPage />} />
                <Route
                  path="upload"
                  element={
                    <RequireRole level="writer">
                      <UploadPage />
                    </RequireRole>
                  }
                />
                <Route path="review" element={<ReviewQueuePage />} />
                <Route
                  path="document-types"
                  element={
                    <RequireRole level="admin">
                      <DocumentTypesPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="organizations"
                  element={
                    <RequireRole level="admin">
                      <OrganizationsPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="access"
                  element={
                    <RequireRole level="admin">
                      <AccessPage />
                    </RequireRole>
                  }
                />
                {/* Настройки-хаб: вкладки = вложенные роуты для deep-link'а.
                    Каждая панель — существующая страница без изменений. */}
                <Route
                  path="settings"
                  element={
                    <RequireRole level="admin">
                      <SettingsHub />
                    </RequireRole>
                  }
                >
                  <Route index element={<SettingsPage />} />
                  <Route path="providers" element={<ProvidersPage />} />
                  <Route path="integrations" element={<IntegrationsPage />} />
                  <Route path="audit" element={<AuditLogPage />} />
                  <Route path="lab" element={<TestLabPage />} />
                </Route>
                <Route
                  path="reference-lists"
                  element={
                    <RequireRole level="admin">
                      <ReferenceListsPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="reference-lists/:slug"
                  element={
                    <RequireRole level="admin">
                      <ReferenceListEntriesPage />
                    </RequireRole>
                  }
                />
                {/* Legacy-редиректы — старые закладки не должны 404'ить. */}
                <Route path="tenants" element={<Navigate to="/organizations" replace />} />
                <Route path="providers" element={<Navigate to="/settings/providers" replace />} />
                <Route path="audit-log" element={<Navigate to="/settings/audit" replace />} />
                <Route path="test-lab" element={<Navigate to="/settings/lab" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/**
 * F9 — ролевой гейт маршрута. Пока грузим /users/me — лёгкий лоадер,
 * чтобы не выкинуть админа при перезагрузке страницы по прямому URL.
 * Не хватает прав → редирект на безопасный лендинг (оператор попадёт в
 * /review), а НЕ 403-экран: пользователь просто не видит того, что ему
 * не положено.
 */
function RequireRole({
  level,
  children,
}: {
  level: AccessLevel;
  children: React.ReactNode;
}) {
  const perms = usePermissions();
  if (!perms.ready) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Загрузка…
      </div>
    );
  }
  if (!perms.can(level)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * F4 — ролезависимый лендинг. Работа оператора (manager/viewer) — очередь
 * ревью, поэтому ведём его сразу в /review, без лишнего захода на Dashboard.
 * Админам (super_admin/admin) полезнее операционный Dashboard. Пока грузим
 * /users/me — показываем лёгкий лоадер, чтобы не мигнуть «не тем» экраном.
 * Неизвестная роль / ошибка → безопасный дефолт Dashboard.
 */
function LandingRoute() {
  const me = useCurrentUser();
  if (me.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Загрузка…
      </div>
    );
  }
  const role = me.data?.role;
  const isOperator = role === 'manager' || role === 'viewer';
  if (isOperator) {
    return <Navigate to="/review" replace />;
  }
  return <DashboardPage />;
}
