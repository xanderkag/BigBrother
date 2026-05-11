import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { config } from './config.js';
import { SYSTEM_ORG_ID, SYSTEM_USER_ID, DEFAULT_PROJECT_ID } from './storage/tenant-constants.js';
import { usersRepo, type UserRole, type UserRow } from './storage/users.js';

/**
 * Auth + req.user. Multi-tenant фаза 2:
 *
 *   1. Глобальный `API_KEY` из env (если задан) маппится в системного
 *      super_admin'а (SYSTEM_USER_ID). Это «root key» оператора платформы.
 *      Полезен при разворачивании, миграциях, recovery — не зависит от БД
 *      и работает даже если все personal tokens случайно удалили.
 *
 *   2. Personal access tokens пользователей. Plaintext начинается с
 *      `pdpat_`; хэш sha-256 лежит в `users.api_token_hash`. Auth-хук
 *      ищет user'а по хэшу.
 *
 *   3. Если `API_KEY` пустой и токена нет — dev-mode: req.user = system
 *      super_admin (auth выключен).
 *
 * Что в req.user:
 *   - id, role, organization_id, default_project_id, isSuperAdmin —
 *     базовый контекст для downstream.
 *   - row — полная пользовательская запись (если из БД); полезна для
 *     authz-проверок дальше (getAccessibleProjectIds и т.п.).
 */

export type AuthUser = {
  id: string;
  role: UserRole;
  organization_id: string | null;
  default_project_id: string;
  isSuperAdmin: boolean;
  /** Полная row из БД (null для системного fallback'а). */
  row: UserRow | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** Виртуальный системный super_admin для fallback'ов и API_KEY-аутентификации. */
function systemSuperAdmin(row: UserRow | null = null): AuthUser {
  return {
    id: SYSTEM_USER_ID,
    role: 'super_admin',
    organization_id: null,
    default_project_id: DEFAULT_PROJECT_ID,
    isSuperAdmin: true,
    row,
  };
}

function userToAuth(row: UserRow): AuthUser {
  return {
    id: row.id,
    role: row.role,
    organization_id: row.organization_id,
    default_project_id: DEFAULT_PROJECT_ID, // TODO: вывести из user_project_access или сохранить как preference
    isSuperAdmin: row.role === 'super_admin',
    row,
  };
}

/** Default project для job'ов без явного scope. */
export const SYSTEM_DEFAULT_PROJECT_ID = DEFAULT_PROJECT_ID;
export const SYSTEM_DEFAULT_ORG_ID = SYSTEM_ORG_ID;

export const bearerAuthHook: onRequestHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const provided = extractBearerToken(req.headers.authorization);
  const expected = config.apiKey;

  // dev-mode без auth — req.user = system super_admin
  if (!expected) {
    req.user = systemSuperAdmin();
    return;
  }

  if (provided === null) {
    reply.code(401).send({ error: 'Authorization: Bearer <token> required' });
    return;
  }

  // Path 1: глобальный API_KEY → super_admin
  if (constantTimeEqual(provided, expected)) {
    req.user = systemSuperAdmin();
    return;
  }

  // Path 2: personal access token. Префикс pdpat_ обязателен — это
  // защита от case'а когда у админа просто опечатка в API_KEY и мы
  // случайно начали бы хэшировать и искать в users каждый чужой запрос.
  if (provided.startsWith('pdpat_')) {
    try {
      const user = await usersRepo.findByToken(provided);
      if (user) {
        req.user = userToAuth(user);
        // Touch last_seen асинхронно — не ждём, незачем блокировать запрос.
        void usersRepo.touchLastSeen(user.id).catch(() => undefined);
        return;
      }
    } catch (err) {
      req.log.warn({ err }, 'personal token lookup failed');
      // fallthrough → 401
    }
  }

  reply.code(401).send({ error: 'invalid api key' });
};

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
