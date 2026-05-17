/**
 * TanStack Query hooks для работы с jobs. Кэширование +
 * автоматический refetch для pending/processing статусов.
 *
 * Job detail: pollIntervalMs = 2000 пока статус pending/processing,
 * после финального статуса — статичный snapshot (refetch только при
 * mount / window focus).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Job } from '@/lib/types';

export const jobsKeys = {
  all: ['jobs'] as const,
  list: (filters: ListJobsFilters) => ['jobs', 'list', filters] as const,
  detail: (id: string) => ['jobs', id] as const,
  file: (id: string) => ['jobs', id, 'file'] as const,
};

export interface ListJobsFilters {
  status?: string;
  document_type?: string;
  organization_id?: string;
  project_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface ListJobsResponse {
  items: Job[];
  limit: number;
  offset: number;
}

/**
 * Список job'ов с фильтрами и пагинацией. Сервер возвращает один
 * page; для total count'а сейчас нет endpoint'а — используем
 * "есть/нет ещё одна страница" эвристику (items.length === limit).
 */
export function useJobsList(filters: ListJobsFilters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return useQuery({
    queryKey: jobsKeys.list(filters),
    queryFn: () =>
      api.get<ListJobsResponse>(`/api/v1/jobs${qs ? '?' + qs : ''}`),
    // Авто-refresh каждые 10s — даёт live-updates для pending/processing
    // job'ов без ручного refresh кнопки. Stale 5s — мгновенный показ
    // кэша при возврате на страницу, фоновый refetch.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

/**
 * Multipart upload через POST /api/v1/jobs. Возвращает { job_id, status }.
 * Прогресс upload'а не репортится — используем стандартный fetch без
 * XMLHttpRequest. Если потребуется progress bar — заменим на XHR.
 */
interface UploadInput {
  file: File;
  documentHint?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
}

interface UploadResponse {
  job_id: string;
  status: string;
}

export function useUploadJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadInput): Promise<UploadResponse> => {
      const fd = new FormData();
      fd.append('file', input.file);
      if (input.documentHint) fd.append('document_hint', input.documentHint);
      if (input.webhookUrl) fd.append('webhook_url', input.webhookUrl);
      if (input.metadata) fd.append('metadata', JSON.stringify(input.metadata));
      return api.post<UploadResponse>('/api/v1/jobs', undefined, {
        body: fd,
        // не ставим Content-Type — fetch сам выставит multipart boundary
      });
    },
    onSuccess: () => {
      // Инвалидируем список — новый job там скоро появится
      qc.invalidateQueries({ queryKey: jobsKeys.all });
    },
  });
}

export function useJob(jobId: string) {
  return useQuery({
    queryKey: jobsKeys.detail(jobId),
    queryFn: () => api.get<Job>(`/api/v1/jobs/${jobId}`),
    refetchInterval: (query) => {
      const data = query.state.data as Job | undefined;
      if (!data) return false;
      if (data.status === 'pending' || data.status === 'processing') return 2000;
      return false;
    },
  });
}

/**
 * Получает blob оригинального файла как Object URL. Освобождение URL —
 * на стороне вызывающего useEffect cleanup (см. PdfViewer).
 *
 * NOTE: cacheTime: 0 — не кэшируем blob URLs в React Query (они
 * привязаны к window и не должны переживать unmount компонента).
 */
export function useJobFile(jobId: string) {
  return useQuery({
    queryKey: jobsKeys.file(jobId),
    queryFn: async () => {
      const blob = await api.getBlob(`/api/v1/jobs/${jobId}/file`);
      return URL.createObjectURL(blob);
    },
    gcTime: 0,
    staleTime: Infinity,
  });
}

export function useApproveJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post<Job>(`/api/v1/jobs/${jobId}/approve`),
    onSuccess: (data, jobId) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
    },
  });
}

export function useReprocessJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.post<Job>(`/api/v1/jobs/${jobId}/reprocess`),
    onSuccess: (_, jobId) => {
      // Forced refetch — статус сейчас pending/processing
      qc.invalidateQueries({ queryKey: jobsKeys.detail(jobId) });
    },
  });
}

/**
 * Перезаписывает extracted целиком (PATCH /jobs/:id/extracted).
 *
 * Тело запроса — сам extracted объект (не { extracted: ... }), как
 * указано в `ExtractedPatchBody = z.record(z.unknown())` на backend'е.
 * Сервер пере-валидирует payload через document_type правила и
 * вернёт обновлённый Job (статус становится 'done' если был
 * 'needs_review').
 */
export function useUpdateExtracted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      extracted,
    }: {
      jobId: string;
      extracted: Record<string, unknown>;
    }) => api.patch<Job>(`/api/v1/jobs/${jobId}/extracted`, extracted),
    onSuccess: (data, { jobId }) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
      // Invalidate список — там status мог поменяться
      qc.invalidateQueries({ queryKey: jobsKeys.all });
    },
  });
}
