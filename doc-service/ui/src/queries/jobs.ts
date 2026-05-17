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
  detail: (id: string) => ['jobs', id] as const,
  file: (id: string) => ['jobs', id, 'file'] as const,
};

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

export function useUpdateExtracted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, extracted }: { jobId: string; extracted: Record<string, unknown> }) =>
      api.patch<Job>(`/api/v1/jobs/${jobId}/extracted`, { extracted }),
    onSuccess: (data, { jobId }) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
    },
  });
}
