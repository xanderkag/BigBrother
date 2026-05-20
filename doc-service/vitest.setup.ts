/**
 * Vitest per-file setup: populate the env vars `loadConfig()` (src/config.ts)
 * marks required BEFORE any test-file module graph is evaluated.
 *
 * Why this file (not inline `process.env.X = ...` at the top of each spec):
 * ESM `import` statements are hoisted above any top-level statements in the
 * same module, so `import { foo } from '../src/...'` — which transitively
 * pulls in `config.ts` and runs `loadConfig()` at module-eval time — executes
 * BEFORE the inline `process.env` assignments. That made the inline guards
 * dead code w.r.t. ordering; specs only "passed" when a sibling file in the
 * same worker happened to set env and prime the module cache first.
 *
 * `setupFiles` runs once per test file, before that file's import graph is
 * evaluated, which is exactly the window we need to satisfy the Zod schema.
 *
 * `??=` everywhere: a real CI environment with live Postgres/Redis/secrets
 * still overrides these dummies. These values are intentionally non-functional
 * (no real services) — suites that need a live DB are skipped, not faked.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STORAGE_DIR = join(tmpdir(), 'parsdocs-test');

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.STORAGE_DIR ??= STORAGE_DIR;
process.env.WEBHOOK_HMAC_SECRET ??= 'test-secret-do-not-use';

// secrets.ts getMasterKey() falls back to a deterministic dev-default when
// empty, so we leave SECRETS_ENCRYPTION_KEY unset by default. secrets.spec.ts
// sets its own deterministic 64-hex key for roundtrip determinism.

// Some load-time code paths stat STORAGE_DIR; make sure it exists.
try {
  mkdirSync(process.env.STORAGE_DIR, { recursive: true });
} catch {
  // best-effort; a missing dir surfaces in the specs that actually touch disk
}
