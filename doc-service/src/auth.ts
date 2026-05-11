import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { config } from './config.js';
import { SYSTEM_ORG_ID, SYSTEM_USER_ID, DEFAULT_PROJECT_ID } from './storage/tenant-constants.js';
import type { UserRole } from './storage/users.js';

/**
 * Fastify `onRequest` hook что enforce'ит Bearer-token auth и заполняет
 * `req.user` — контекст текущего пользователя для downstream-кода.
 *
 * Сегодня (фаза 1 multi-tenant):
 *   - Один общий Bearer-токен (`API_KEY` из env) маппится в системного
 *     super_admin (`SYSTEM_USER_ID`). Этот пользователь видит всё.
 *   - В dev (`API_KEY` пустой) auth полностью выключен, но `req.user`
 *     всё равно проставляется в системный — чтобы downstream-логика
 *     scope'инга работала единообразно.
 *
 * Что планируется в следующих фазах:
 *   - Personal access tokens: каждый user имеет свой токен (sha256 хэш
 *     в `users.api_token_hash`). Текущий API_KEY останется как root-ключ
 *     для super_admin'а.
 *   - Session cookies + login form для UI.
 *   - OAuth для интеграций (Google Workspace, Azure AD).
 *
 * Mounted on `/api/v1/*`. `/health`, `/ready`, `/metrics` — публичные.
 */

export type AuthUser = {
  id: string;
  role: UserRole;
  /** Организация пользователя; для super_admin — null. */
  organization_id: string | null;
  /** Дефолтный проект — куда падают job'ы без явного указания project_id. */
  default_project_id: string;
  /** Шорткат для downstream-проверок: `if (req.user.isSuperAdmin) ...` */
  isSuperAdmin: boolean;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Системный пользователь — единственный известный «реальный» юзер сейчас.
 * Когда мы реализуем personal tokens, эта функция вернёт **резолверного**
 * юзера (по token hash или session cookie), а не константу.
 */
function getCurrentUser(_req: FastifyRequest): AuthUser {
  return {
    id: SYSTEM_USER_ID,
    role: 'super_admin',
    organization_id: null, // super_admin не привязан к одной org
    default_project_id: DEFAULT_PROJECT_ID,
    isSuperAdmin: true,
  };
}

/** Default project для job'ов / эндпоинтов без явного project_id. */
export const SYSTEM_DEFAULT_PROJECT_ID = DEFAULT_PROJECT_ID;
export const SYSTEM_DEFAULT_ORG_ID = SYSTEM_ORG_ID;

export const bearerAuthHook: onRequestHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const expected = config.apiKey;
  if (!expected) {
    // dev mode — auth выключен, но контекст пользователя проставляем
    // (чтобы scope-логика на downstream была однотипной).
    req.user = getCurrentUser(req);
    return;
  }

  const provided = extractBearerToken(req.headers.authorization);
  if (provided === null) {
    reply.code(401).send({ error: 'Authorization: Bearer <token> required' });
    return;
  }
  if (!constantTimeEqual(provided, expected)) {
    reply.code(401).send({ error: 'invalid api key' });
    return;
  }

  // Авторизация прошла — заполняем user context.
  req.user = getCurrentUser(req);
};

/** Returns the raw token after `Bearer `, or `null` if the header is absent/malformed. */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S.*)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
