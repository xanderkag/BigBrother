/**
 * Seed 3 UI users для UX-AUTH: admin / operator / viewer.
 *
 *   admin@vanga.local    — super_admin (видит всё, любая org)
 *   operator@vanga.local — org_admin в SYSTEM_ORG (default)
 *   viewer@vanga.local   — viewer в SYSTEM_ORG (только чтение)
 *
 * Запуск:
 *   npm run seed:users -- [--apply]
 *
 * Dry-run по умолчанию — печатает что будет создано. С `--apply`:
 *   - создаёт users (если email уже есть — не перезаписывает, сообщает)
 *   - генерирует случайный пароль (16 hex), хэширует scrypt, пишет в password_hash
 *   - выдаёт user_project_access на default project (для не-super_admin)
 *   - печатает email + plaintext-пароль в stdout (один раз, не хранится)
 *
 * Изменить пароль позже: тот же скрипт с --reset <email> (не реализовано,
 * добавим если понадобится). Пока — `UPDATE users SET password_hash = NULL`
 * и запустить seed повторно для нужного юзера.
 */

import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { hashPassword } from '../storage/password.js';
import { SYSTEM_ORG_ID, DEFAULT_PROJECT_ID } from '../storage/tenant-constants.js';
import type { UserRole, ProjectAccessRole } from '../storage/users.js';

type SeedUser = {
  email: string;
  display_name: string;
  role: UserRole;
  organization_id: string | null;
  project_role: ProjectAccessRole | null; // null для super_admin (видит всё без grant'ов)
};

const SEED: SeedUser[] = [
  {
    email: 'admin@vanga.local',
    display_name: 'Admin (super)',
    role: 'super_admin',
    organization_id: null,
    project_role: null,
  },
  {
    email: 'operator@vanga.local',
    display_name: 'Operator',
    role: 'org_admin',
    organization_id: SYSTEM_ORG_ID,
    project_role: 'admin',
  },
  {
    email: 'viewer@vanga.local',
    display_name: 'Viewer',
    role: 'viewer',
    organization_id: SYSTEM_ORG_ID,
    project_role: 'viewer',
  },
];

function genPassword(): string {
  // 12 байт base64url ≈ 16 символов, легче ввести руками чем 32-байтный hex.
  return randomBytes(12).toString('base64url');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'APPLY' : 'DRY-RUN';
  // eslint-disable-next-line no-console
  console.log(`[seed-users] mode=${mode}\n`);

  const credentials: Array<{ email: string; password: string; status: string }> = [];

  for (const u of SEED) {
    // eslint-disable-next-line no-console
    console.log(`→ ${u.email} (${u.role})`);

    const existing = await db.query<{ id: string; password_hash: string | null }>(
      `SELECT id, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [u.email],
    );

    if (existing.rows.length > 0 && existing.rows[0]!.password_hash) {
      // eslint-disable-next-line no-console
      console.log(`  already exists with password_hash — skipped (delete password_hash to re-seed)\n`);
      credentials.push({ email: u.email, password: '(unchanged)', status: 'skipped' });
      continue;
    }

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log(`  [dry-run] would ${existing.rows.length ? 'set password' : 'create user'} + grant\n`);
      credentials.push({ email: u.email, password: '(dry-run)', status: 'planned' });
      continue;
    }

    const password = genPassword();
    const passwordHash = await hashPassword(password);

    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0]!.id;
      await db.query(
        `UPDATE users SET password_hash = $1, status = 'active', updated_at = now() WHERE id = $2`,
        [passwordHash, userId],
      );
    } else {
      const res = await db.query<{ id: string }>(
        `INSERT INTO users (email, display_name, organization_id, role, status, password_hash)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id`,
        [u.email, u.display_name, u.organization_id, u.role, passwordHash],
      );
      userId = res.rows[0]!.id;
    }

    // Project access grant — только для не-super_admin (super видит всё без grant'ов).
    if (u.project_role && u.organization_id) {
      await db.query(
        `INSERT INTO user_project_access (user_id, organization_id, project_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role`,
        [userId, u.organization_id, DEFAULT_PROJECT_ID, u.project_role],
      );
    }

    credentials.push({ email: u.email, password, status: 'created' });
    // eslint-disable-next-line no-console
    console.log(`  ✅ user_id=${userId}\n`);
  }

  // eslint-disable-next-line no-console
  console.log('\n======================================================================');
  // eslint-disable-next-line no-console
  console.log('  CREDENTIALS (save NOW — passwords are never stored in plaintext)');
  // eslint-disable-next-line no-console
  console.log('======================================================================');
  for (const c of credentials) {
    // eslint-disable-next-line no-console
    console.log(`  ${c.email.padEnd(28)}  ${c.password.padEnd(20)}  [${c.status}]`);
  }
  // eslint-disable-next-line no-console
  console.log('======================================================================\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error('[seed-users] FAILED:', err);
    process.exit(1);
  },
);
