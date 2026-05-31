/**
 * Provision a sandbox tenant for an external consumer микросервиса
 * (например, SLAI contract-test'ы против ParsdocsAdapter).
 *
 * Создаёт целиком:
 *   - organizations (type='test', наш sandbox-флаг)
 *   - projects (default project в этой org — без него jobs не привяжутся)
 *   - users (один operator-bot с role='org_admin')
 *   - personal_access_tokens (плейнтекст возвращается ровно один раз)
 *   - organization_settings (output='webhook' если задан --webhook-url, иначе 'pull')
 *
 * НЕ устанавливает per-tenant rate-limit или retention — на текущей схеме это
 * глобальные env: `RATE_LIMIT_PER_MINUTE` и `FILE_RETENTION_DAYS`. На
 * dedicated sandbox-хосте (где этот скрипт обычно и запускается) глобальные
 * значения = sandbox-значения, дополнительных полей не нужно. Per-tenant —
 * отдельная миграция, когда появится второй sandbox-арендатор на одном хосте.
 *
 * Запуск:
 *   npm run provision:sandbox -- --name slai-sandbox \
 *       [--webhook-url https://api.demo.sls24.ru/api/v1/parsdocs/webhook] \
 *       [--token-name slai-bot] \
 *       [--expires-in-days 90] \
 *       [--apply]              # default dry-run
 *
 * Dry-run печатает SQL что СОБИРАЛСЯ выполнить, без изменений в БД. С --apply
 * фактически создаёт + печатает **plaintext token один раз** (нужно сразу
 * захватить и положить в SLAI_SECRETS_INBOX.md S2 envelope-encrypted).
 *
 * Идемпотентность: при повторном запуске с тем же --name пишет «organization
 * already exists, skipping» и НЕ создаёт второй раз. Чтобы пересоздать —
 * сначала вручную DELETE (см. `--rotate` для будущего расширения).
 */

import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';

type Args = {
  name: string;
  webhookUrl: string | null;
  tokenName: string;
  expiresInDays: number | null;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const name = get('name');
  if (!name) throw new Error('--name required (e.g. --name slai-sandbox)');
  const expires = get('expires-in-days');
  return {
    name,
    webhookUrl: get('webhook-url') ?? null,
    tokenName: get('token-name') ?? `${name}-bot`,
    expiresInDays: expires ? Number.parseInt(expires, 10) : null,
    apply: argv.includes('--apply'),
  };
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';

  // eslint-disable-next-line no-console
  console.log(`[provision-sandbox] mode=${mode} name=${args.name}`);

  // 1. Check if org already exists (idempotency).
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM organizations WHERE name = $1`,
    [args.name],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    // eslint-disable-next-line no-console
    console.log(
      `[provision-sandbox] org "${args.name}" already exists (id=${row.id}, status=${row.status}).\n` +
        `  To rotate token only — extend this script with --rotate flag. Aborting to stay idempotent.`,
    );
    process.exit(1);
  }

  // 2. Plan — show what would be done.
  const plan = [
    `INSERT organizations (name='${args.name}', type='test') → orgId`,
    `INSERT projects (organization_id=orgId, name='default')`,
    `INSERT users (display_name='${args.tokenName}', role='org_admin', organization_id=orgId)`,
    `INSERT personal_access_tokens (user_id=userId, name='${args.tokenName}', ` +
      `expires_at=${args.expiresInDays ? `now() + ${args.expiresInDays}d` : 'NULL'})`,
    args.webhookUrl
      ? `INSERT organization_settings (output='webhook', webhook_url='${args.webhookUrl}')`
      : `INSERT organization_settings (output='pull')`,
  ];
  // eslint-disable-next-line no-console
  console.log('\n[plan]\n  ' + plan.join('\n  ') + '\n');

  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('[provision-sandbox] dry-run only. Re-run with --apply.');
    process.exit(0);
  }

  // 3. Apply, all in one TX.
  await db.query('BEGIN');
  try {
    const orgRes = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, type, status)
       VALUES ($1, 'test', 'active')
       RETURNING id`,
      [args.name],
    );
    const orgId = orgRes.rows[0]!.id;

    await db.query(
      `INSERT INTO projects (organization_id, name, status, description)
       VALUES ($1, 'default', 'active', $2)`,
      [orgId, `Default project for ${args.name} sandbox tenant.`],
    );

    const userRes = await db.query<{ id: string }>(
      `INSERT INTO users (display_name, role, organization_id, status)
       VALUES ($1, 'org_admin', $2, 'active')
       RETURNING id`,
      [args.tokenName, orgId],
    );
    const userId = userRes.rows[0]!.id;

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

    if (args.webhookUrl) {
      await db.query(
        `INSERT INTO organization_settings (organization_id, mode, output, webhook_url)
         VALUES ($1, 'extract', 'webhook', $2)`,
        [orgId, args.webhookUrl],
      );
    } else {
      await db.query(
        `INSERT INTO organization_settings (organization_id, mode, output)
         VALUES ($1, 'extract', 'pull')`,
        [orgId],
      );
    }

    await db.query('COMMIT');

    // eslint-disable-next-line no-console
    console.log(
      '\n[provision-sandbox] ✅ applied.\n\n' +
        `  organization_id: ${orgId}\n` +
        `  user_id:         ${userId}\n` +
        `  token:           ${plaintext}\n\n` +
        '  ↑ This token will NEVER be shown again. Save it now.\n' +
        '  Next step: envelope-encrypt and put in SLAI_SECRETS_INBOX.md block S2.\n',
    );

    // eslint-disable-next-line no-console
    console.log(`[host] master-key (SECRETS_ENCRYPTION_KEY) set: ${
      config.secretsEncryptionKey ? 'yes' : 'NO — bad, encryption disabled'
    }`);
  } catch (err) {
    await db.query('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error('[provision-sandbox] FAILED, rolled back:', err);
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
