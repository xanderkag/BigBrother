import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';
import LoginPage from '@/pages/Login';
import DashboardPage from '@/pages/Dashboard';
import JobsListPage from '@/pages/JobsList';
import JobDetailPage from '@/pages/JobDetail';
import UploadPage from '@/pages/Upload';
import ReviewQueuePage from '@/pages/ReviewQueue';
import Layout from '@/components/Layout';

/**
 * App routes — UI v2.
 *
 * Phase 1 + 2 экраны:
 *   /            → Dashboard (операционные метрики)
 *   /jobs        → JobsList (таблица всех документов)
 *   /jobs/:id    → JobDetail (PDF + extracted data)
 *   /upload      → Upload (drag-drop)
 *   /login       → Login (если нет токена в localStorage)
 *
 * Всё внутри Layout проверяется через RequireAuth — нет токена →
 * редирект на /login. Layout рендерит общий header с навигацией.
 *
 * Остальные экраны (admin, audit log, providers и т.д.) остались в
 * старом /ui/ — Layout содержит deep-link «Старый UI →».
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
                <Route index element={<DashboardPage />} />
                <Route path="jobs" element={<JobsListPage />} />
                <Route path="jobs/:jobId" element={<JobDetailPage />} />
                <Route path="upload" element={<UploadPage />} />
                <Route path="review" element={<ReviewQueuePage />} />
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
