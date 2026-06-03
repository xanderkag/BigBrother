/**
 * UX-AUTH: POST /api/v1/auth/login — email + password → PAT plaintext.
 *
 * Зачем: чтобы оператор UI не вводил длинный pdpat_-токен из админ-консоли.
 * Юзер вводит email/password, бекенд проверяет scrypt-хеш (см.
 * storage/password.ts) и выдаёт долгоживущий PAT через существующий
 * tokensRepo (формат не меняется, auth-цепочка тоже).
 *
 * Эти роуты — публичные (без bearerAuthHook). Защита от brute-force —
 * глобальный rate-limit Fastify (см. server.ts) + 60-100ms scrypt на
 * каждый запрос. Этого достаточно на пилот; для прод добавим IP-based
 * lockout после N неудач.
 *
 * NB: возвращаем generic «invalid email or password» одинаково и при
 * неизвестном email, и при неверном пароле — не утекаем существование
 * учётки.
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../db.js';
import { verifyPassword } from '../storage/password.js';
import { tokensRepo } from '../storage/tokens.js';
import type { UserRow } from '../storage/users.js';

const TOKEN_TTL_DAYS = 90;
const TOKEN_NAME_PREFIX = 'ui-login';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const LoginOk = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().nullable(),
    display_name: z.string(),
    role: z.string(),
    organization_id: z.string().nullable(),
  }),
  expires_at: z.string().nullable(),
});

const ErrorResponse = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Login by email + password → personal access token',
        body: LoginBody,
        response: { 200: LoginOk, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;

      // Normalize email (lower + trim) — DB не enforce'ит lowercase, но мы храним
      // и ищем единообразно. Без отдельного индекса по lower(email) — у нас на
      // данном этапе единицы пользователей, full scan допустим.
      const normalized = email.trim().toLowerCase();

      const { rows } = await db.query<UserRow>(
        `SELECT * FROM users
          WHERE lower(email) = $1 AND status = 'active'
          LIMIT 1`,
        [normalized],
      );
      const user = rows[0];

      // Run verifyPassword даже если user не найден — постоянное время
      // против user-enumeration. verifyPassword(null) → false без раскрытия.
      const storedHash = user?.password_hash ?? null;
      const ok = await verifyPassword(password, storedHash);

      if (!user || !ok) {
        return reply.code(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'invalid email or password',
        });
      }

      // Выпускаем фрешный PAT — старые при этом остаются жить
      // (revoke не делаем; user сам может через UI почистить позже).
      const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000);
      const tokenName = `${TOKEN_NAME_PREFIX} ${new Date().toISOString().slice(0, 10)}`;
      const { plaintext } = await tokensRepo.create({
        user_id: user.id,
        name: tokenName,
        expires_at: expiresAt,
      });

      // last_seen_at для аналитики «кто заходил» в админке.
      await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [user.id]);

      return reply.send({
        token: plaintext,
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          role: user.role,
          organization_id: user.organization_id,
        },
        expires_at: expiresAt.toISOString(),
      });
    },
  );
}
