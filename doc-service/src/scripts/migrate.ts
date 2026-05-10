import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, closeDb } from '../db.js';

// Idempotent runner for migrations/*.sql. Files are loaded in lexical order;
// each file is executed inside a transaction. The schema bootstraps via
// CREATE TABLE/INDEX IF NOT EXISTS, so re-running is safe.
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, '..', '..', 'migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    process.stdout.write(`applying ${file}... `);
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('COMMIT');
      process.stdout.write('ok\n');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      process.stdout.write('FAILED\n');
      throw err;
    }
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
