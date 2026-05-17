import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite config для doc-service UI v2 (React).
 *
 * Особенности:
 *   - `base: '/v2/'` — приложение сервится Fastify бэкендом на /v2/* через
 *     fastify-static (см. server.ts регистрацию). React Router тоже
 *     использует basename='/v2' для согласованности.
 *
 *   - dev-сервер проксирует /api/v1/* и /healthz на backend (default :8085)
 *     чтобы можно было разрабатывать UI без сборки в backend dist.
 *
 *   - `pdfjs-dist` worker'ы копируем как public asset — react-pdf требует
 *     указать `workerSrc` URL'ом. Решение: import.meta.url-based worker.
 */
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:8085',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:8085',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // pdfjs worker может быть большой → отдельный chunk
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'pdf-vendor': ['react-pdf'],
          'query-vendor': ['@tanstack/react-query'],
        },
      },
    },
  },
});
