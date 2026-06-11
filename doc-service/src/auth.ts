import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { config } from './config.js';
import { SYSTEM_ORG_ID, SYSTEM_USER_ID, DEFAULT_PROJECT_ID } from './storage/tenant-constants.js';
import { usersRepo, hashToken, type UserRole, type UserRow } from './storage/users.js';
import { tokensRepo, TokensRepo } from './storage/tokens.js';

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
  /**
   * A3: Human-readable caller name from API_KEYS_JSON map.
   * Set when auth succeeds via a named key (not root API_KEY or pdpat_).
   * Useful for per-client audit logs and rate-limit attribution.
   */
  caller?: string;
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

async function userToAuth(row: UserRow): Promise<AuthUser> {
  // super_admin живёт без проектных грантов (видит всё) — системный default.
  // Для остальных берём детерминированно-первый проект из user_project_access,
  // с fallback на системный DEFAULT_PROJECT_ID, если грантов нет.
  const defaultProjectId =
    row.role === 'super_admin'
      ? DEFAULT_PROJECT_ID
      : (await usersRepo.getDefaultProjectId(row.id)) ?? DEFAULT_PROJECT_ID;
  return {
    id: row.id,
    role: row.role,
    organization_id: row.organization_id,
    default_project_id: defaultProjectId,
    isSuperAdmin: row.role === 'super_admin',
    row,
    // service-аккаунт (интеграционная система) — тегируем caller для
    // gateway usage attribution и аудита. Человек остаётся без caller.
    ...(row.kind === 'service' ? { caller: row.display_name } : {}),
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
  const namedKeys = config.apiKeysJson;

  // dev-mode без auth — req.user = system super_admin. Достижимо ТОЛЬКО при
  // явном ALLOW_NO_AUTH=true; startup-guard (assertAuthConfigured) уже не даёт
  // стартовать иначе. Дублируем проверку здесь как defense in depth: если
  // root key и named keys пусты, но allowNoAuth не выставлен — fail-closed (500),
  // а не молча открываемся.
  if (!expected && Object.keys(namedKeys).length === 0) {
    if (!config.allowNoAuth) {
      req.log.error('auth bypass reached without ALLOW_NO_AUTH — refusing request');
      reply.code(500).send({ error: 'server auth misconfigured' });
      return;
    }
    req.user = systemSuperAdmin();
    return;
  }

  if (provided === null) {
    reply.code(401).send({ error: 'Authorization: Bearer <token> required' });
    return;
  }

  // Path 1: глобальный API_KEY → super_admin (root key, no caller tag)
  if (constantTimeEqual(provided, expected)) {
    req.user = systemSuperAdmin();
    return;
  }

  // Path 1.5: A3 named client keys from API_KEYS_JSON.
  // Each key maps to a caller name for audit/logging. Same privileges as
  // root API_KEY but tagged so logs show who made each request.
  for (const [key, callerName] of Object.entries(namedKeys)) {
    if (constantTimeEqual(provided, key)) {
      req.user = { ...systemSuperAdmin(), caller: callerName };
      req.log.debug({ caller: callerName }, 'auth via named api key');
      return;
    }
  }

  // Path 2: personal access token. Префикс pdpat_ обязателен — это
  // защита от case'а когда у админа просто опечатка в API_KEY и мы
  // случайно начали бы хэшировать и искать в users каждый чужой запрос.
  if (provided.startsWith('pdpat_')) {
    try {
      const hash = hashToken(provided);

      // 1. Сначала — multi-token таблица (новая модель).
      const tokenRow = await tokensRepo.findByHash(hash);
      if (tokenRow) {
        if (TokensRepo.isExpired(tokenRow)) {
          reply.code(401).send({ error: 'token expired' });
          return;
        }
        const user = await usersRepo.findById(tokenRow.user_id);
        if (user && user.status === 'active') {
          req.user = await userToAuth(user);
          void tokensRepo.touchLastUsed(tokenRow.id).catch(() => undefined);
          void usersRepo.touchLastSeen(user.id).catch(() => undefined);
          return;
        }
      }

      // 2. Fallback — legacy users.api_token_hash (однотокенная модель).
      // Для уже выданных до миграции токенов и для тех, что выдаются
      // через старый endpoint POST /users/:id/token.
      const legacyUser = await usersRepo.findByToken(provided);
      if (legacyUser) {
        req.user = await userToAuth(legacyUser);
        void usersRepo.touchLastSeen(legacyUser.id).catch(() => undefined);
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
