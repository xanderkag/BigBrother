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
import AuditLogPage from '@/pages/AuditLog';
import SettingsPage from '@/pages/Settings';
import TenantsPage from '@/pages/Tenants';
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
 *   /providers              → CRUD LLM/OCR провайдеров
 *   /audit-log              → Audit log viewer
 *   /settings               → Settings (snapshot конфига + статус LLM)
 *   /tenants                → Organizations / projects / users (admin)
 *   /reference-lists        → Список типов справочников
 *   /reference-lists/:slug  → Записи конкретного справочника
 *   /test-lab               → Тестовая лаборатория (single doc + provider picker)
 *   /login                  → Login (если нет токена в localStorage)
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
                  path="providers"
                  element={
                    <RequireRole level="admin">
                      <ProvidersPage />
                    </RequireRole>
                  }
                />
                {/* Журнал аудита — виден всем авторизованным (решение владельца) */}
                <Route path="audit-log" element={<AuditLogPage />} />
                <Route
                  path="settings"
                  element={
                    <RequireRole level="admin">
                      <SettingsPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="tenants"
                  element={
                    <RequireRole level="admin">
                      <TenantsPage />
                    </RequireRole>
                  }
                />
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
                {/* Тест-лаборатория — видна всем; запуск прогона гейтит сама страница */}
                <Route path="test-lab" element={<TestLabPage />} />
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
