import type { FastifyInstance } from 'fastify';
import { registry } from '../metrics.js';

/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Public by design (no Bearer): Prometheus scrapers don't carry the
 * API_KEY. If the deployment ever needs to gate metrics behind auth,
 * use the corp nginx layer (`location /metrics { allow 10.x.x.x; deny all; }`)
 * rather than baking auth into the route.
 *
 * Lives next to /health and /ready so the operational endpoints share a
 * single auth boundary (none).
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
