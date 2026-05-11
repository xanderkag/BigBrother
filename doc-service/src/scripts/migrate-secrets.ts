/**
 * Принудительная миграция legacy plaintext'ов в encrypted-envelope'ы.
 *
 * Зачем: даже после внедрения фичи lazy-миграция апдейтит строки только
 * на следующем write. Если админ не правил ни одного провайдера N месяцев,
 * его ключи продолжают лежать plaintext'ом. Этот скрипт прогоняет всё
 * принудительно, ОДНОЙ транзакцией.
 *
 * Запуск:
 *   npm run migrate:secrets        # dry-run: посчитает что бы обновил
 *   npm run migrate:secrets -- --apply   # реально обновит
 *
 * Поведение:
 *   - Читает все строки provider_settings.
 *   - Те, у которых api_key начинается с `v1:` — уже зашифрованы, пропуск.
 *   - Те, у которых plaintext или null — для null'ов ничего, для plaintext'а
 *     шифруем и UPDATE.
 *   - Всё в одной транзакции. При ошибке — rollback, лог.
 *
 * Безопасность:
 *   - Скрипт НЕ читает уже-зашифрованные значения (т.е. ему не нужно
 *     знать актуальный master-key для повторной обработки). Только для
 *     новых-к-шифрованию.
 *   - Если запускаете с ДРУГИМ ключом, чем тот, который зашифровал
 *     старые envelope'ы — старые останутся читаемыми только под старым
 *     ключом. Для ротации ключа нужен отдельный rotate-скрипт (см. TECH_DEBT).
 */

import { db, closeDb } from '../db.js';
import { encryptSecret, isEncrypted, getMasterKey } from '../storage/secrets.js';

type Row = { id: string; api_key: string | null };

async function main() {
  const apply = process.argv.includes('--apply');

  // Прогрев + sanity-check ключа: упадём ДО любого update, если env кривой.
  getMasterKey();

  const { rows } = await db.query<Row>(
    `SELECT id, api_key FROM provider_settings`,
  );

  const todo = rows.filter((r) => r.api_key !== null && !isEncrypted(r.api_key));
  const already = rows.filter((r) => r.api_key !== null && isEncrypted(r.api_key));
  const empty = rows.filter((r) => r.api_key === null);

  console.log(`provider_settings: всего ${rows.length}`);
  console.log(`  уже зашифровано: ${already.length}`);
  console.log(`  пустых (нет ключа): ${empty.length}`);
  console.log(`  требуют шифрования: ${todo.length}`);

  if (todo.length === 0) {
    console.log('Нечего мигрировать. Выходим.');
    await closeDb();
    return;
  }

  if (!apply) {
    console.log('\n(dry-run) Чтобы реально обновить — добавьте --apply');
    for (const r of todo) console.log(`  - ${r.id}`);
    await closeDb();
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const r of todo) {
      const enc = encryptSecret(r.api_key);
      await client.query(
        `UPDATE provider_settings SET api_key = $1 WHERE id = $2`,
        [enc, r.id],
      );
      console.log(`  ✓ ${r.id}`);
    }
    await client.query('COMMIT');
    console.log(`\nГотово. Обновлено: ${todo.length}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка миграции, rollback:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
