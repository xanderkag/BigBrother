import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { config } from './config.js';

/**
 * Fastify `onRequest` hook that enforces Bearer-token auth.
 *
 * Behaviour:
 *   - If the configured API key is empty, the hook is a no-op. This keeps
 *     local development frictionless. Production deployments MUST set
 *     `API_KEY` to a non-empty value.
 *   - Compares the supplied token against the configured key in constant
 *     time to avoid leaking valid prefixes via response timing.
 *   - On failure, replies 401 and stops further hooks/routes. We do NOT
 *     send a `WWW-Authenticate` challenge — this is a server-to-server API,
 *     not a browser endpoint.
 *
 * Mounted on the `/api/v1` route prefix only. `/health` and `/ready` stay
 * public for liveness/readiness probes.
 */
export const bearerAuthHook: onRequestHookHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const expected = config.apiKey;
  if (!expected) return; // dev mode — no auth required

  const provided = extractBearerToken(req.headers.authorization);
  if (provided === null) {
    reply.code(401).send({ error: 'Authorization: Bearer <token> required' });
    return;
  }
  if (!constantTimeEqual(provided, expected)) {
    reply.code(401).send({ error: 'invalid api key' });
    return;
  }
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
