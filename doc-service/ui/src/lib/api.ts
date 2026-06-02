/**
 * Тонкий API-клиент над fetch. Добавляет Bearer-токен из localStorage,
 * парсит JSON, на 401 — чистит токен и редиректит на /ui/login.
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
    if (location.pathname !== '/ui/login') {
      location.href = '/ui/login';
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
    // Fastify zod-validation возвращает body вида
    //   {statusCode: 400, error: "Bad Request", message: "params/id must match …"}
    // где `error` — это просто статус-текст HTTP (бесполезный), а реальная
    // причина — в `message`. Стандартный наш ApiResponse имеет {error: "<text>"}.
    // Берём message > error > HTTP-fallback, чтобы пользователь видел причину,
    // а не «Bad Request».
    const errVal = (body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : undefined);
    const msgVal = (body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : undefined);
    let msg: string;
    if (msgVal && (errVal === 'Bad Request' || errVal === 'Internal Server Error' || !errVal)) {
      // Fastify-стиль: предпочитаем message
      msg = msgVal;
    } else if (errVal) {
      msg = errVal;
    } else {
      msg = `HTTP ${res.status}`;
    }
    // Приставляем код для контекста (без повторного HTTP-префикса).
    if (!msg.match(/^HTTP\s/)) msg = `${res.status}: ${msg}`;
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
  put: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string, init?: RequestInit) =>
    request<T>(path, { ...init, method: 'DELETE' }),
  /** Получить файл как blob (для PDF preview). */
  getBlob: async (path: string): Promise<Blob> => {
    const res = await request<Response>(path, { method: 'GET', rawResponse: true });
    return res.blob();
  },
  /**
   * GET → сырой Response (для проверки статуса/заголовков перед чтением
   * тела). На 401 редирект делает уже request(); тут только !ok-обработка
   * остаётся на вызывающем.
   */
  getResponse: (path: string, init?: RequestInit): Promise<Response> =>
    request<Response>(path, { ...init, method: 'GET', rawResponse: true }),
  /**
   * GET → текст (для text/plain эндпоинтов, напр. /jobs/:id/raw-text).
   * Бросает ApiError на не-2xx, чтобы 404 «нет raw_text» дошёл сообщением.
   */
  getText: async (path: string, init?: RequestInit): Promise<string> => {
    const res = await request<Response>(path, { ...init, method: 'GET', rawResponse: true });
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      // text/plain эндпоинты на ошибке отдают JSON {error}; вытащим его.
      let msg = body || `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(body) as { error?: string; message?: string };
        msg = parsed.error ?? parsed.message ?? msg;
      } catch {
        /* body не JSON — оставляем как есть */
      }
      throw new ApiError(res.status, body, msg);
    }
    return res.text();
  },
};

export { ApiError };
