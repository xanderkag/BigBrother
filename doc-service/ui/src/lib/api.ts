/**
 * Тонкий API-клиент над fetch. Добавляет Bearer-токен из localStorage,
 * парсит JSON, на 401 — чистит токен и редиректит на /v2/login.
 *
 * Не используем axios — fetch более чем достаточно, экономим bundle size.
 *
 * TanStack Query инкапсулирует кэширование/ретраи поверх этих функций
 * (см. queries/*).
 */
import { getToken, clearToken } from './auth';

class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { rawResponse?: boolean } = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    // soft redirect — пользователь увидит login screen
    if (location.pathname !== '/v2/login') {
      location.href = '/v2/login';
    }
    throw new ApiError(401, null, 'unauthorized');
  }

  if (init.rawResponse) {
    return res as unknown as T;
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
    }
    const msg =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : undefined) ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }

  // Empty body (204 No Content)
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, { ...init, method: 'GET' }),
  post: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'DELETE' }),
  /** Получить файл как blob (для PDF preview). */
  getBlob: async (path: string): Promise<Blob> => {
    const res = await request<Response>(path, { method: 'GET', rawResponse: true });
    return res.blob();
  },
};

export { ApiError };
