import { Navigate, Route, Routes } from 'react-router-dom';
import { isAuthenticated } from '@/lib/auth';
import LoginPage from '@/pages/Login';
import DashboardPage from '@/pages/Dashboard';
import JobsListPage from '@/pages/JobsList';
import JobDetailPage from '@/pages/JobDetail';
import UploadPage from '@/pages/Upload';
import ReviewQueuePage from '@/pages/ReviewQueue';
import DocumentTypesPage from '@/pages/DocumentTypes';
import ProvidersPage from '@/pages/Providers';
import AuditLogPage from '@/pages/AuditLog';
import Layout from '@/components/Layout';

/**
 * App routes — UI v2.
 *
 * Phase 1-4 экраны (полная feature-parity со старым UI):
 *   /                  → Dashboard (операционные метрики)
 *   /jobs              → JobsList (таблица всех документов)
 *   /jobs/:id          → JobDetail (PDF + extracted data + edit)
 *   /upload            → Upload (drag-drop)
 *   /review            → ReviewQueue (needs_review с bulk approve)
 *   /document-types    → CRUD типов документов
 *   /providers         → CRUD LLM/OCR провайдеров
 *   /audit-log         → Audit log viewer
 *   /login             → Login (если нет токена в localStorage)
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
                <Route index element={<DashboardPage />} />
                <Route path="jobs" element={<JobsListPage />} />
                <Route path="jobs/:jobId" element={<JobDetailPage />} />
                <Route path="upload" element={<UploadPage />} />
                <Route path="review" element={<ReviewQueuePage />} />
                <Route path="document-types" element={<DocumentTypesPage />} />
                <Route path="providers" element={<ProvidersPage />} />
                <Route path="audit-log" element={<AuditLogPage />} />
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
