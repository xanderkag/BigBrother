/**
 * organization_settings repo + per-org consumer profile (CP7 фаза 2).
 *
 * db.query замокан стейтфул-стабом, который эмулирует таблицу с одной
 * строкой на orgId и ON CONFLICT-семантику upsert'а (COALESCE/CASE).
 * Так round-trip (upsert → get) и поведение секрета (encrypt/clear/keep)
 * проверяются end-to-end через реальный repo + реальный encryptSecret.
 *
 * Гвард output='webhook' без webhook_url проверяется на уровне той же
 * логики, что в route-handler'е (effectiveOutput/effectiveUrl).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY ?? 'a'.repeat(64);

type Row = {
  organization_id: string;
  mode: string;
  output: string;
  webhook_url: string | null;
  webhook_hmac_secret: string | null;
  auto_approve_threshold: string | null;
  enrich_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

// Стейтфул-стаб БД: Map<orgId, Row>. Распознаёт SELECT vs INSERT...ON CONFLICT
// по тексту запроса и применяет COALESCE/CASE-семантику параметров.
const table = new Map<string, Row>();

const queryMock = vi.fn(async (sql: string, params: unknown[] = []) => {
  if (/^\s*SELECT/i.test(sql)) {
    const orgId = params[0] as string;
    const row = table.get(orgId);
    return { rows: row ? [row] : [] };
  }
  if (/INSERT INTO organization_settings/i.test(sql)) {
    // Параметры: $1 orgId, $2 mode, $3 output, $4 webhook_url, $5 secret(enc),
    // $6 threshold, $7 url-present, $8 secret-present, $9 threshold-present.
    const [orgId, mode, output, url, secret, threshold, urlSet, secretSet, thrSet, enrich] =
      params as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        boolean,
        boolean,
        boolean,
        boolean | null,
      ];
    const existing = table.get(orgId);
    const now = new Date();
    let next: Row;
    if (!existing) {
      next = {
        organization_id: orgId,
        mode: mode ?? 'extract',
        output: output ?? 'pull',
        webhook_url: url,
        webhook_hmac_secret: secret,
        auto_approve_threshold: threshold,
        enrich_enabled: enrich ?? false,
        created_at: now,
        updated_at: now,
      };
    } else {
      next = {
        ...existing,
        mode: mode ?? existing.mode,
        output: output ?? existing.output,
        webhook_url: urlSet ? url : existing.webhook_url,
        webhook_hmac_secret: secretSet ? secret : existing.webhook_hmac_secret,
        auto_approve_threshold: thrSet ? threshold : existing.auto_approve_threshold,
        enrich_enabled: enrich ?? existing.enrich_enabled,
        updated_at: now,
      };
    }
    table.set(orgId, next);
    return { rows: [next] };
  }
  throw new Error(`unexpected query: ${sql}`);
});

vi.mock('../src/db.js', () => ({
  db: { query: (...args: unknown[]) => queryMock(...(args as [string, unknown[]])) },
}));

let repo: typeof import('../src/storage/organization-settings.js').organizationSettingsRepo;
let isEncrypted: typeof import('../src/storage/secrets.js').isEncrypted;

beforeEach(async () => {
  table.clear();
  queryMock.mockClear();
  const mod = await import('../src/storage/organization-settings.js');
  repo = mod.organizationSettingsRepo;
  isEncrypted = (await import('../src/storage/secrets.js')).isEncrypted;
});

const ORG = '11111111-1111-1111-1111-111111111111';

describe('get — default profile when no row', () => {
  it('returns extract/pull defaults with has_webhook_secret=false', async () => {
    const profile = await repo.get(ORG);
    expect(profile).toMatchObject({
      organization_id: ORG,
      mode: 'extract',
      output: 'pull',
      webhook_url: null,
      has_webhook_secret: false,
      auto_approve_threshold: null,
      created_at: null,
      updated_at: null,
    });
  });
});

describe('upsert → get round-trip', () => {
  it('persists values; secret stored encrypted and round-trips via getDecryptedWebhookSecret', async () => {
    await repo.upsert(ORG, {
      mode: 'classify_only',
      output: 'webhook',
      webhook_url: 'https://hook.example/ingest',
      webhook_hmac_secret: 'super-secret-hmac',
      auto_approve_threshold: 0.85,
    });

    const profile = await repo.get(ORG);
    expect(profile.mode).toBe('classify_only');
    expect(profile.output).toBe('webhook');
    expect(profile.webhook_url).toBe('https://hook.example/ingest');
    expect(profile.has_webhook_secret).toBe(true);
    expect(profile.auto_approve_threshold).toBe(0.85);

    // Хранимое значение — зашифрованный envelope, НЕ plaintext.
    const stored = table.get(ORG)!.webhook_hmac_secret!;
    expect(stored).not.toBe('super-secret-hmac');
    expect(isEncrypted(stored)).toBe(true);

    // Декрипт-хелпер восстанавливает оригинал.
    const decrypted = await repo.getDecryptedWebhookSecret(ORG);
    expect(decrypted).toBe('super-secret-hmac');
  });
});

describe('secret patch semantics', () => {
  it('webhook_hmac_secret: undefined leaves existing secret', async () => {
    await repo.upsert(ORG, { webhook_hmac_secret: 'keep-me' });
    const before = table.get(ORG)!.webhook_hmac_secret;

    await repo.upsert(ORG, { mode: 'extract' }); // секрет не упомянут
    expect(table.get(ORG)!.webhook_hmac_secret).toBe(before);
    expect(await repo.getDecryptedWebhookSecret(ORG)).toBe('keep-me');
  });

  it('webhook_hmac_secret: null clears the secret', async () => {
    await repo.upsert(ORG, { webhook_hmac_secret: 'temp' });
    expect((await repo.get(ORG)).has_webhook_secret).toBe(true);

    await repo.upsert(ORG, { webhook_hmac_secret: null });
    expect((await repo.get(ORG)).has_webhook_secret).toBe(false);
    expect(await repo.getDecryptedWebhookSecret(ORG)).toBeNull();
  });

  it('webhook_hmac_secret: string replaces the secret', async () => {
    await repo.upsert(ORG, { webhook_hmac_secret: 'first' });
    await repo.upsert(ORG, { webhook_hmac_secret: 'second' });
    expect(await repo.getDecryptedWebhookSecret(ORG)).toBe('second');
  });
});

describe('toApi masking', () => {
  it('never leaks the raw secret', async () => {
    await repo.upsert(ORG, { webhook_hmac_secret: 'top-secret' });
    const row = table.get(ORG)!;
    const api = repo.toApi(row);
    expect(api).not.toHaveProperty('webhook_hmac_secret');
    expect(JSON.stringify(api)).not.toContain('top-secret');
    expect(api.has_webhook_secret).toBe(true);
  });
});

describe("output='webhook' without webhook_url guard", () => {
  // Воспроизводим route-guard: effectiveOutput/effectiveUrl на основе
  // текущего профиля + патча.
  function passesGuard(
    current: { output: string; webhook_url: string | null },
    patch: { output?: string; webhook_url?: string | null },
  ): boolean {
    const effectiveOutput = patch.output ?? current.output;
    if (effectiveOutput !== 'webhook') return true;
    const effectiveUrl =
      patch.webhook_url !== undefined ? patch.webhook_url : current.webhook_url;
    return Boolean(effectiveUrl);
  }

  it('rejects output=webhook when no url anywhere', () => {
    expect(passesGuard({ output: 'pull', webhook_url: null }, { output: 'webhook' })).toBe(false);
  });

  it('accepts output=webhook when url in patch', () => {
    expect(
      passesGuard(
        { output: 'pull', webhook_url: null },
        { output: 'webhook', webhook_url: 'https://x/y' },
      ),
    ).toBe(true);
  });

  it('accepts output=webhook when url already stored', () => {
    expect(
      passesGuard({ output: 'pull', webhook_url: 'https://stored/url' }, { output: 'webhook' }),
    ).toBe(true);
  });

  it('rejects when stored url is cleared in same patch', () => {
    expect(
      passesGuard(
        { output: 'webhook', webhook_url: 'https://stored/url' },
        { webhook_url: null },
      ),
    ).toBe(false);
  });
});
