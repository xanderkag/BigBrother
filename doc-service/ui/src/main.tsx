import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { initTheme } from '@/lib/theme';

// Применяем сохранённую тему до первого render'а — иначе вспышка
// белого фона на dark-режиме при загрузке страницы.
initTheme();

// pdfjs worker — react-pdf использует pdfjs-dist под капотом. Указываем
// worker через import.meta.url чтобы Vite собрал его как отдельный chunk.
import { pdfjs } from 'react-pdf';
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Compat-редирект для старых hash-роутов vanilla UI (`/ui/#jobs/abc`
 * → `/ui/jobs/abc`). После switch'а /v2/ ↔ /ui/ старые ссылки команды
 * и закладки бы открыли React-Dashboard вместо нужного экрана — этот
 * shim сохраняет работу bookmarks.
 *
 * Запускается до createRoot чтобы React Router сразу видел правильный
 * pathname.
 */
function migrateLegacyHashRoute() {
  const hash = window.location.hash;
  if (!hash || hash === '#') return;
  // #jobs/abc, #review, #upload, #document-types, #providers, #audit-log, #dashboard
  const match = hash.match(/^#(jobs(?:\/[\w-]+)?|review|upload|document-types|providers|audit-log|dashboard)$/);
  if (!match) return;
  let path = match[1];
  if (path === 'dashboard') path = '';
  const target = '/ui/' + path;
  window.history.replaceState(null, '', target);
}

migrateLegacyHashRoute();

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/ui">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
