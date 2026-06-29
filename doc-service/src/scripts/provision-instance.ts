/**
 * provision-instance — полный wizard подключения нового consumer-инстанса.
 *
 * Один запуск создаёт всё необходимое:
 *   - organizations (type configurable, default='production')
 *   - projects (default project)
 *   - users (service-bot, role='org_admin', kind='service')
 *   - user_project_access (admin на default project)
 *   - personal_access_tokens (plaintext показывается один раз)
 *   - organization_settings (webhook + HMAC если задан --webhook-url)
 *
 * Дополнительно: если задан --dadata-budget или --llm-budget — создаёт
 * строки в gateway_consumer_budgets для ограничения суточных вызовов.
 *
 * Запуск:
 *   npm run provision:instance -- \
 *     --name "SLAI Клиент X" \
 *     --slug slai-clientx \
 *     --webhook-url https://clientx.sls24.ru/api/v1/parsdocs/webhook \
 *     [--type production]         # default: production
 *     [--token-name slai-clientx-bot]
 *     [--expires-in-days 365]
 *     [--llm-budget 50000]        # суточный budget токенов LLM
 *     [--dadata-budget 1000]      # суточный budget вызовов DaData
 *     [--apply]                   # без флага — dry-run
 *
 * Вывод при --apply содержит готовую .env-врезку для SLAI:
 *   PARSDOCS_BASE_URL=...
 *   PARSDOCS_API_KEY=pdpat_...
 *   PARSDOCS_WEBHOOK_SECRET=...
 *
 * Идемпотентность: slug уже существует → скрипт падает с описанием (не
 * создаёт дубль). Для ротации токена — добавить --rotate (TODO).
 */

import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { encryptSecret } from '../storage/secrets.js';

type Args = {
  name: string;
  slug: string;
  type: string;
  webhookUrl: string | null;
  tokenName: string;
  expiresInDays: number | null;
  llmBudget: number | null;
  dadataBudget: number | null;
  baseUrl: string;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const name = get('name');
  if (!name) throw new Error('--name required (e.g. --name "SLAI Клиент X")');

  const slug = (get('slug') ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const tokenName = get('token-name') ?? `${slug}-bot`;
  const expires = get('expires-in-days');
  const llmBudget = get('llm-budget');
  const dadataBudget = get('dadata-budget');
  const defaultBaseUrl =
    process.env.PUBLIC_URL ?? 'https://vanga.sls24.ru';

  return {
    name,
    slug,
    type: get('type') ?? 'production',
    webhookUrl: get('webhook-url') ?? null,
    tokenName,
    expiresInDays: expires ? Number.parseInt(expires, 10) : null,
    llmBudget: llmBudget ? Number.parseInt(llmBudget, 10) : null,
    dadataBudget: dadataBudget ? Number.parseInt(dadataBudget, 10) : null,
    baseUrl: get('base-url') ?? defaultBaseUrl,
    apply: argv.includes('--apply'),
  };
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function generateHmacSecret(): string {
  return randomBytes(32).toString('hex');
}

function printBox(lines: string[]): void {
  const maxLen = Math.max(...lines.map((l) => l.length));
  const border = '─'.repeat(maxLen + 4);
  // eslint-disable-next-line no-console
  console.log(`┌${border}┐`);
  for (const line of lines) {
    // eslint-disable-next-line no-console
    console.log(`│  ${line.padEnd(maxLen)}  │`);
  }
  // eslint-disable-next-line no-console
  console.log(`└${border}┘`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';

  // eslint-disable-next-line no-console
  console.log(
    `\n[provision-instance] mode=${mode} name="${args.name}" slug=${args.slug} type=${args.type}`,
  );

  // 1. Idempotency check — slug is derived from name and stored as name.
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM organizations WHERE name = $1`,
    [args.name],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    // eslint-disable-next-line no-console
    console.log(
      `[provision-instance] ⚠️  org "${args.name}" already exists (id=${row.id}, status=${row.status}).\n` +
        `  To rotate the token — use --rotate flag (not yet implemented).\n` +
        `  Aborting to stay idempotent.`,
    );
    process.exit(1);
  }

  // 2. Plan output.
  const hmacPreview = args.webhookUrl ? '(auto-generated, 32 random bytes)' : 'N/A';
  const plan = [
    `INSERT organizations (name="${args.name}", type="${args.type}")`,
    `INSERT projects (name="default")`,
    `INSERT users (display_name="${args.tokenName}", role="org_admin", kind="service")`,
    `INSERT user_project_access (role="admin")`,
    `INSERT personal_access_tokens (name="${args.tokenName}", ` +
      `expires=${args.expiresInDays ? `${args.expiresInDays}d` : 'never'})`,
    args.webhookUrl
      ? `INSERT organization_settings (output="webhook", webhook_url="${args.webhookUrl}", hmac_secret=${hmacPreview})`
      : `INSERT organization_settings (output="pull")`,
    ...(args.llmBudget !== null
      ? [`INSERT gateway_consumer_budgets (connector="llm", daily_budget=${args.llmBudget})`]
      : []),
    ...(args.dadataBudget !== null
      ? [`INSERT gateway_consumer_budgets (connector="dadata", daily_budget=${args.dadataBudget})`]
      : []),
  ];
  // eslint-disable-next-line no-console
  console.log('\n[plan]\n  ' + plan.join('\n  ') + '\n');

  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('[provision-instance] dry-run only. Re-run with --apply to create.');
    process.exit(0);
  }

  // 3. Apply in one transaction.
  await db.query('BEGIN');
  try {
    // -- Organization
    const orgRes = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, type, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [args.name, args.type],
    );
    const orgId = orgRes.rows[0]!.id;

    // -- Default project
    await db.query(
      `INSERT INTO projects (organization_id, name, status, description)
       VALUES ($1, 'default', 'active', $2)`,
      [orgId, `Default project for ${args.name}.`],
    );

    // -- Service bot user
    const userRes = await db.query<{ id: string }>(
      `INSERT INTO users (display_name, role, organization_id, status)
       VALUES ($1, 'org_admin', $2, 'active')
       RETURNING id`,
      [args.tokenName, orgId],
    );
    const userId = userRes.rows[0]!.id;

    // -- Project access grant (needed for job creation/read)
    const projRes = await db.query<{ id: string }>(
      `SELECT id FROM projects WHERE organization_id = $1 AND name = 'default' LIMIT 1`,
      [orgId],
    );
    const projectId = projRes.rows[0]!.id;
    await db.query(
      `INSERT INTO user_project_access (user_id, organization_id, project_id, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (user_id, project_id) DO NOTHING`,
      [userId, orgId, projectId],
    );

    // -- PAT
    const plaintext = `pdpat_${randomBytes(32).toString('base64url')}`;
    const hash = hashToken(plaintext);
    const expiresAt =
      args.expiresInDays !== null
        ? new Date(Date.now() + args.expiresInDays * 86_400_000)
        : null;
    await db.query(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, args.tokenName, hash, expiresAt],
    );

    // -- Organization settings
    let hmacPlaintext: string | null = null;
    if (args.webhookUrl) {
      hmacPlaintext = generateHmacSecret();
      const hmacEncrypted = encryptSecret(hmacPlaintext);
      await db.query(
        `INSERT INTO organization_settings
           (organization_id, mode, output, webhook_url, webhook_hmac_secret)
         VALUES ($1, 'extract', 'webhook', $2, $3)`,
        [orgId, args.webhookUrl, hmacEncrypted],
      );
    } else {
      await db.query(
        `INSERT INTO organization_settings (organization_id, mode, output)
         VALUES ($1, 'extract', 'pull')`,
        [orgId],
      );
    }

    // -- Gateway consumer budgets (optional)
    if (args.llmBudget !== null) {
      await db.query(
        `INSERT INTO gateway_consumer_budgets (consumer, connector, daily_budget, enabled)
         VALUES ($1, 'llm', $2, true)
         ON CONFLICT (consumer, connector) DO UPDATE SET daily_budget = $2`,
        [args.tokenName, args.llmBudget],
      );
    }
    if (args.dadataBudget !== null) {
      await db.query(
        `INSERT INTO gateway_consumer_budgets (consumer, connector, daily_budget, enabled)
         VALUES ($1, 'dadata', $2, true)
         ON CONFLICT (consumer, connector) DO UPDATE SET daily_budget = $2`,
        [args.tokenName, args.dadataBudget],
      );
    }

    await db.query('COMMIT');

    // -- Success output
    // eslint-disable-next-line no-console
    console.log('\n[provision-instance] ✅ created successfully.\n');
    // eslint-disable-next-line no-console
    console.log(`  organization_id: ${orgId}`);
    // eslint-disable-next-line no-console
    console.log(`  user_id:         ${userId}`);
    // eslint-disable-next-line no-console
    console.log(`  project_id:      ${projectId}`);
    // eslint-disable-next-line no-console
    console.log(`  expires_at:      ${expiresAt?.toISOString() ?? 'never'}\n`);

    // Ready-to-paste .env block for the consumer
    const envLines = [
      '# ── parsdocs credentials — paste into SLAI .env ──',
      `PARSDOCS_BASE_URL=${args.baseUrl}`,
      `PARSDOCS_API_KEY=${plaintext}`,
      ...(hmacPlaintext ? [`PARSDOCS_WEBHOOK_SECRET=${hmacPlaintext}`] : []),
    ];
    printBox(envLines);

    // eslint-disable-next-line no-console
    console.log('\n  ↑ These secrets will NEVER be shown again.');
    // eslint-disable-next-line no-console
    console.log('  Copy now and transmit via secure channel (not Slack/Telegram plaintext).\n');

    // eslint-disable-next-line no-console
    console.log(
      `[host] encryption key set: ${
        config.secretsEncryptionKey ? 'yes ✓' : 'NO — hmac stored unencrypted (dev mode)'
      }`,
    );
  } catch (err) {
    await db.query('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error('[provision-instance] FAILED, rolled back:', err);
    process.exit(2);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
