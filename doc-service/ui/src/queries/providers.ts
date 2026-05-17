/**
 * Provider settings — конфиги LLM/OCR провайдеров (Anthropic, Yandex
 * Vision, локальные модели через Ollama/LiteLLM).
 *
 * Backend endpoints — см. routes/provider-settings.ts:
 *   GET    /provider-settings              — list (api_key masked)
 *   GET    /provider-settings/:id          — read one
 *   POST   /provider-settings              — upsert by id
 *   PATCH  /provider-settings/:id          — partial update
 *   DELETE /provider-settings/:id          — delete
 *   POST   /provider-settings/:id/set-default — атомарно delete default у других
 *   POST   /provider-settings/:id/test     — connection check
 *
 * SECURITY: api_key никогда не возвращается с backend'а — только
 * `api_key_masked` (••••1234) + `has_api_key: boolean`. Поле api_key
 * только в request bodies, никогда не сохраняем его в React state
 * после создания/обновления.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ProviderKind = 'llm' | 'ocr';

export interface ProviderEntry {
  id: string;
  kind: ProviderKind;
  display_name: string;
  description?: string | null;
  base_url?: string | null;
  api_key_masked?: string | null; // ••••1234, никогда не plaintext
  has_api_key?: boolean;
  model?: string | null;
  is_active: boolean;
  is_default?: boolean;
  extra?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

interface ListResponse {
  items: ProviderEntry[];
}

export interface TestResult {
  ok: boolean;
  status?: number;
  latency_ms?: number;
  message?: string;
}

export const providersKeys = {
  all: ['provider-settings'] as const,
  list: () => ['provider-settings', 'list'] as const,
  detail: (id: string) => ['provider-settings', id] as const,
};

export function useProviders() {
  return useQuery({
    queryKey: providersKeys.list(),
    queryFn: () => api.get<ListResponse>('/api/v1/provider-settings'),
    staleTime: 60 * 1000,
  });
}

export interface CreateProviderInput {
  id: string;
  kind: ProviderKind;
  display_name: string;
  description?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  is_active?: boolean;
  extra?: Record<string, unknown> | null;
}

export function useCreateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProviderInput) =>
      api.post<ProviderEntry>('/api/v1/provider-settings', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providersKeys.all });
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<CreateProviderInput>;
    }) => api.patch<ProviderEntry>(`/api/v1/provider-settings/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: providersKeys.all });
      qc.setQueryData(providersKeys.detail(data.id), data);
    },
  });
}

export function useDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/provider-settings/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providersKeys.all });
    },
  });
}

export function useSetDefaultProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<ProviderEntry>(`/api/v1/provider-settings/${id}/set-default`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providersKeys.all });
    },
  });
}

/**
 * Test connection — кратко проверяет что provider'у можно подключиться.
 * Для LLM: GET base_url/v1/models с api_key в Authorization. Для OCR:
 * GET base_url/. Timeout 5s. Возвращает {ok, status, latency_ms, message}.
 */
export function useTestProvider() {
  return useMutation({
    mutationFn: (id: string) =>
      api.post<TestResult>(`/api/v1/provider-settings/${id}/test`),
  });
}
