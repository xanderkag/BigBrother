/**
 * TanStack Query hooks для работы с jobs. Кэширование +
 * автоматический refetch для pending/processing статусов.
 *
 * Job detail: pollIntervalMs = 2000 пока статус pending/processing,
 * после финального статуса — статичный snapshot (refetch только при
 * mount / window focus).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { Job } from '@/lib/types';

export const jobsKeys = {
  all: ['jobs'] as const,
  list: (filters: ListJobsFilters) => ['jobs', 'list', filters] as const,
  detail: (id: string) => ['jobs', id] as const,
  file: (id: string) => ['jobs', id, 'file'] as const,
  rawText: (id: string) => ['jobs', id, 'raw-text'] as const,
  sheets: (id: string) => ['jobs', id, 'sheets'] as const,
  previewPdf: (id: string) => ['jobs', id, 'preview-pdf'] as const,
};

export interface ListJobsFilters {
  status?: string;
  document_type?: string;
  /** Несколько типов через запятую (OR): `invoice,factInvoice,UPD`. */
  document_types?: string;
  /** Формат(ы) файла через запятую (OR): pdf|excel|word|image|xml|other. */
  format?: string;
  organization_id?: string;
  project_id?: string;
  from?: string;
  to?: string;
  /** Free-text quick-search по file_name / id / INN. */
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * API job — оригинальная форма ответа /jobs.
 * Поле idентификатора у бэка называется `job_id` (UUID); UI везде
 * использует `id` — мапим в normalize().
 */
interface ApiJob extends Omit<Job, 'id'> {
  job_id: string;
}

interface ApiListJobsResponse {
  items: ApiJob[];
  limit: number;
  offset: number;
  total?: number;
}

interface ListJobsResponse {
  items: Job[];
  limit: number;
  offset: number;
  /** Полное число подходящих записей. Optional для backward-compat. */
  total?: number;
}

/**
 * Backend отдаёт `job_id` (см. types/api-schemas.ts), но в JSX мы давно
 * ходим к нему как `job.id`. Раньше это было latent-bug'ом: ссылки
 * `/jobs/${job.id}` уходили в `/jobs/undefined`, JobDetailPage делал
 * запрос на `/api/v1/jobs/undefined` и backend возвращал 400 «invalid uuid».
 * Никто не замечал пока юзер не кликнул по строке.
 *
 * Решение — единая трансформация на границе query-hook'а: { job_id, ... }
 * → { id, ... }. Это не ломает TS-типы (UI Job уже имеет id) и не трогает
 * UI-логику. Альтернатива — переименовать field'ы по всему UI; дороже
 * и менее обратимо.
 */
function normalizeJob(api: ApiJob): Job {
  const { job_id, ...rest } = api;
  return { ...rest, id: job_id };
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
    queryFn: async (): Promise<ListJobsResponse> => {
      const raw = await api.get<ApiListJobsResponse>(
        `/api/v1/jobs${qs ? '?' + qs : ''}`,
      );
      return { ...raw, items: raw.items.map(normalizeJob) };
    },
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
    queryFn: async (): Promise<Job> => {
      const raw = await api.get<ApiJob>(`/api/v1/jobs/${jobId}`);
      return normalizeJob(raw);
    },
    // Не делаем запрос на буквальную строку «undefined» / «null» — если
    // юзер открыл /jobs/undefined по стейл-ссылке, не дёргаем API ради
    // 400'й. JobDetailPage отрисует свой own error state.
    enabled: !!jobId && jobId !== 'undefined' && jobId !== 'null',
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

/**
 * Фототочное превью office-файла (Excel/Word) через сконвертированный
 * backend'ом PDF: GET /jobs/:id/preview-pdf → стрим application/pdf.
 * Конвертация (LibreOffice) может занять несколько секунд — вызывающий
 * показывает спиннер «Готовим превью…».
 *
 * Терминальные ошибки (не ретраим): 400 — не office-файл, 410 — файл
 * удалён по retention, 422 — конвертация не удалась. Статус кладём в
 * ApiError.status, чтобы JobDetail развёл fallback (Excel → грид,
 * Word → сообщение).
 *
 * Blob-URL освобождается на стороне вызывающего useEffect cleanup'е
 * (как useJobFile). gcTime:0 — не переживает unmount компонента.
 */
export function useJobPreviewPdf(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: jobsKeys.previewPdf(jobId),
    queryFn: async (): Promise<string> => {
      const res = await api.getResponse(`/api/v1/jobs/${jobId}/preview-pdf`);
      if (!res.ok) {
        throw new ApiError(res.status, null, `preview-pdf HTTP ${res.status}`);
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
    enabled: enabled && !!jobId,
    gcTime: 0,
    staleTime: Infinity,
    retry: false, // 400/410/422 терминальны
  });
}

export function useApproveJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string): Promise<Job> => {
      const raw = await api.post<ApiJob>(`/api/v1/jobs/${jobId}/approve`);
      return normalizeJob(raw);
    },
    onSuccess: (data, jobId) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
    },
  });
}

/**
 * Перепрогон документа (POST /jobs/:id/reprocess). OCR не повторяется —
 * используется сохранённый текст.
 *
 * reclassify=false (по умолчанию) → тип/хинт сохраняются, классификатор
 *   не перезапускается (обычный «Перепрогнать»).
 * reclassify=true (`?reclassify=true`) → тип/хинт игнорируются,
 *   классификатор отрабатывает с нуля («Определить тип заново» —
 *   чинит мисклассификацию без перезаливки файла).
 */
export function useReprocessJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      arg: string | { jobId: string; reclassify?: boolean },
    ): Promise<Job> => {
      const jobId = typeof arg === 'string' ? arg : arg.jobId;
      const reclassify = typeof arg === 'string' ? false : !!arg.reclassify;
      const raw = await api.post<ApiJob>(
        `/api/v1/jobs/${jobId}/reprocess${reclassify ? '?reclassify=true' : ''}`,
      );
      return normalizeJob(raw);
    },
    onSuccess: (_, arg) => {
      const jobId = typeof arg === 'string' ? arg : arg.jobId;
      // Forced refetch — статус сейчас pending/processing
      qc.invalidateQueries({ queryKey: jobsKeys.detail(jobId) });
    },
  });
}

/**
 * Повторная доставка вебхука (F10/F11) — внешний эффект: данные уйдут
 * в систему-потребитель (SLAI). Всегда шлём `?force=true`, т.к. кнопка в
 * UI — осознанное действие оператора (бэк иначе блокирует повтор уже
 * доставленного вебхука 409-ой).
 */
export function useRedeliverWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string): Promise<Job> => {
      const raw = await api.post<ApiJob>(
        `/api/v1/jobs/${jobId}/redeliver-webhook?force=true`,
      );
      return normalizeJob(raw);
    },
    onSuccess: (data, jobId) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
    },
  });
}

/**
 * Сырой OCR-текст (F11/F21) — то, что распознал OCR ДО LLM-структурирования.
 * Загружается по требованию (enabled), не кэшируется агрессивно: текст
 * статичен после терминального статуса. text/plain → api.getText.
 */
export function useJobRawText(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: jobsKeys.rawText(jobId),
    queryFn: () => api.getText(`/api/v1/jobs/${jobId}/raw-text`),
    enabled: enabled && !!jobId,
    staleTime: 5 * 60 * 1000,
    retry: false, // 404 «нет raw_text» — не ретраим
  });
}

/**
 * Excel-превью (GET /jobs/:id/sheets) — грид листов книги, распарсенный на
 * backend'е (SheetJS в UI не тащим). Возвращается только для табличных
 * форматов; на не-таблицу бэк отдаёт 400, на retention-чистку — 410, на
 * битый файл — 422 (см. SheetViewer для человеческих сообщений).
 */
export interface JobSheet {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
  truncated: boolean;
}

export interface JobSheetsResponse {
  file_name: string;
  sheets: JobSheet[];
}

export function useJobSheets(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: jobsKeys.sheets(jobId),
    queryFn: () => api.get<JobSheetsResponse>(`/api/v1/jobs/${jobId}/sheets`),
    enabled: enabled && !!jobId,
    staleTime: 5 * 60 * 1000,
    retry: false, // 400/410/422 — терминальны, не ретраим
  });
}

/**
 * Перезаписывает extracted целиком (PATCH /jobs/:id/extracted).
 *
 * Тело запроса — сам extracted объект (не { extracted: ... }), как
 * указано в `ExtractedPatchBody = z.record(z.unknown())` на backend'е.
 * Сервер пере-валидирует payload через document_type правила и
 * вернёт обновлённый Job.
 *
 * F2 — два режима сохранения (см. §8.1):
 *   keepStatus=false (по умолчанию) → «Одобрить»: статус → 'done';
 *   keepStatus=true (`?keep_status=true`) → «Сохранить»: правки пишутся,
 *     но статус остаётся needs_review (правка ≠ одобрение).
 */
export function useUpdateExtracted() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      jobId,
      extracted,
      keepStatus = false,
    }: {
      jobId: string;
      extracted: Record<string, unknown>;
      keepStatus?: boolean;
    }): Promise<Job> => {
      const raw = await api.patch<ApiJob>(
        `/api/v1/jobs/${jobId}/extracted${keepStatus ? '?keep_status=true' : ''}`,
        extracted,
      );
      return normalizeJob(raw);
    },
    onSuccess: (data, { jobId }) => {
      qc.setQueryData(jobsKeys.detail(jobId), data);
      // Invalidate список — там status мог поменяться
      qc.invalidateQueries({ queryKey: jobsKeys.all });
    },
  });
}
