/**
 * Migration runner backed by node-pg-migrate.
 *
 * Replaces the earlier hand-rolled SQL loop that re-ran every file each
 * time. node-pg-migrate tracks applied migrations in a `pgmigrations`
 * table, so subsequent runs only apply new files.
 *
 * Commands (selected via first CLI argument):
 *   up     — apply all pending migrations (default; called from
 *            docker-compose `migrate` one-shot service).
 *   down   — roll back one migration. Used carefully; destructive.
 *   create — scaffold a new migration file in /migrations.
 *
 * Migration files live next to this script in `<project>/migrations/`
 * and follow the `<timestamp>_<slug>.sql` convention with explicit
 * `-- Up Migration` / `-- Down Migration` sections.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodePgMigrate from 'node-pg-migrate';
import { config } from '../config.js';

type Direction = 'up' | 'down';

const here = dirname(fileURLToPath(import.meta.url));
// dist/ → ../../migrations; src/ → ../../migrations — same relative shape.
const migrationsDir = join(here, '..', '..', 'migrations');

async function runDirection(direction: Direction, count: number | undefined): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applied = await (nodePgMigrate as any)({
    databaseUrl: config.databaseUrl,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction,
    count,
    verbose: true,
    log: (msg: string) => process.stdout.write(`${msg}\n`),
  });
  if (applied.length === 0) {
    process.stdout.write(direction === 'up' ? 'No pending migrations.\n' : 'Nothing to roll back.\n');
  } else {
    for (const m of applied) {
      process.stdout.write(`${direction === 'up' ? 'applied' : 'reverted'}: ${m.name}\n`);
    }
  }
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  npm run migrate            — apply all pending migrations',
      '  npm run migrate:down       — roll back the most recent migration',
      '  npm run migrate:create <name> — scaffold a new SQL migration file',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';

  if (cmd === 'up') {
    await runDirection('up', undefined);
    return;
  }

  if (cmd === 'down') {
    // Roll back exactly one. Need more? Specify count via env or extend the CLI.
    await runDirection('down', 1);
    return;
  }

  if (cmd === 'create') {
    const name = process.argv[3];
    if (!name) {
      process.stderr.write('migrate:create requires a name argument\n');
      process.exit(1);
    }
    // Build a YYYYMMDDHHmmss prefix; matches the existing convention and
    // sorts lexically alongside older files.
    const ts = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    const slug = name.replace(/[^A-Za-z0-9_]/g, '_');
    const filename = `${ts}_${slug}.sql`;
    const path = join(migrationsDir, filename);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      [
        `-- ${slug}`,
        '',
        '-- Up Migration',
        '',
        '',
        '-- Down Migration',
        '',
        '',
      ].join('\n'),
    );
    process.stdout.write(`Created ${path}\n`);
    return;
  }

  usage();
}

main().catch((err) => {
  process.stderr.write(`migrate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
