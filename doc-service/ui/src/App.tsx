import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';
import LoginPage from '@/pages/Login';
import JobDetailPage from '@/pages/JobDetail';
import Layout from '@/components/Layout';

/**
 * App routes — пока минимальные, по мере миграции добавляем jobs list,
 * upload, document-types и т.д. Для v2.0 — только Login + Job Detail
 * (главный фикс UI по жалобе на лишнее пустое пространство).
 *
 * Все маршруты внутри Layout проверяют isAuthenticated() через
 * RequireAuth wrapper — если нет токена, редирект на /login.
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
                <Route path="jobs/:jobId" element={<JobDetailPage />} />
                <Route path="*" element={<DefaultRedirect />} />
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
 * Старый UI пока живёт на /ui/, и базовая страница / у нас не
 * реализована — отправляем туда тех, кто ткнул куда-то не туда.
 * Когда мигрируем jobs list, заменим на <JobsListPage />.
 */
function DefaultRedirect() {
  if (typeof window !== 'undefined') {
    window.location.href = '/ui/';
  }
  return null;
}
