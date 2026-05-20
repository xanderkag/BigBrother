/**
 * Readiness probe — `GET /ready` (public, no auth; см. server.ts allowList).
 *
 * Backend проверяет Postgres / Redis / writability STORAGE_DIR и возвращает
 * 200 при полном здоровье или 503 со списком упавших зависимостей в `error`.
 *
 * 503 — это ожидаемый сигнал деградации, а не исключение: используем plain
 * fetch (а не api-клиент, который кидает ApiError на non-ok) и сами читаем
 * статус, чтобы не засорять консоль ошибками.
 */
import { useQuery } from '@tanstack/react-query';

export type HealthState = 'healthy' | 'degraded' | 'loading';

export interface ReadyStatus {
  state: HealthState;
  /** Список упавших зависимостей из 503-payload (`error`), если есть. */
  failures: string | null;
}

async function fetchReady(): Promise<ReadyStatus> {
  try {
    const res = await fetch('/ready', { headers: { Accept: 'application/json' } });
    if (res.ok) return { state: 'healthy', failures: null };
    let failures: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string') failures = body.error;
    } catch {
      /* 503 без JSON-тела — оставляем failures = null */
    }
    return { state: 'degraded', failures };
  } catch {
    // network error / сервис недоступен — тоже деградация
    return { state: 'degraded', failures: null };
  }
}

export function useReady() {
  return useQuery({
    queryKey: ['health', 'ready'],
    queryFn: fetchReady,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
