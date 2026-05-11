/**
 * Ротация SECRETS_ENCRYPTION_KEY: дешифрует все api_key envelope'ы под
 * СТАРЫМ master-ключом и перешифровывает под НОВЫМ. После успешного
 * прогона нужно прописать новый ключ в env и перезапустить сервис.
 *
 * Зачем нужно:
 *   - Если текущий master-ключ скомпрометирован (утечка env-файла, leaked
 *     CI-секрет, ушёл сотрудник который видел ключ) — без этого скрипта
 *     админу пришлось бы вручную перевводить все api_key провайдеров
 *     заново. Скрипт делает то же атомарно за миллисекунды.
 *   - Регулярная плановая ротация (раз в N месяцев) — security hygiene
 *     даже без incident'а.
 *
 * Запуск:
 *   npm run rotate:secrets -- --from <OLD-64hex> --to <NEW-64hex>
 *     (dry-run по умолчанию)
 *
 *   npm run rotate:secrets -- --from <OLD> --to <NEW> --apply
 *     (реально пишет в БД)
 *
 * Поведение:
 *   1. Парсит оба ключа из argv, валидирует формат (64 hex).
 *   2. Берёт все строки provider_settings с непустым api_key.
 *   3. Делит их на три группы:
 *      - encrypted-под-OLD (префикс v1:): подлежат re-encryption;
 *      - legacy plaintext (без префикса): первый раз шифруются под NEW;
 *      - что не дешифровалось под OLD: ошибка, abort (вероятно эти
 *        строки уже шифрованы под ДРУГИМ ключом — не пересмотреть без
 *        потери данных).
 *   4. В одной транзакции UPDATE'ит каждую строку. Rollback при ошибке.
 *
 * После применения:
 *   - Прописать новый ключ в env (SECRETS_ENCRYPTION_KEY=<NEW>).
 *   - Перезапустить doc-service (worker и api) — кэш ключа в памяти
 *     обновится только на старте процесса.
 *   - Старый ключ безопасно стереть из всех мест где он был.
 */

import { db, closeDb } from '../db.js';
import { decryptWithKey, encryptWithKey, isEncrypted, parseHexKey } from '../storage/secrets.js';

type Row = { id: string; api_key: string | null };

function parseArgs(argv: string[]): { from: Buffer; to: Buffer; apply: boolean } {
  let from: string | undefined;
  let to: string | undefined;
  let apply = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--apply') apply = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  if (!from || !to) {
    printHelp();
    throw new Error('--from и --to обязательны');
  }
  return {
    from: parseHexKey(from, '--from key'),
    to: parseHexKey(to, '--to key'),
    apply,
  };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage:\n` +
      `  rotate:secrets --from <OLD-64hex> --to <NEW-64hex> [--apply]\n\n` +
      `  Без --apply — dry-run: только покажет статистику.\n` +
      `  Сгенерировать новый ключ: openssl rand -hex 32\n`,
  );
}

async function main(): Promise<void> {
  const { from, to, apply } = parseArgs(process.argv);

  const { rows } = await db.query<Row>(
    `SELECT id, api_key FROM provider_settings WHERE api_key IS NOT NULL`,
  );

  const toReencrypt: Row[] = [];
  const legacyPlain: Row[] = [];
  const failedDecrypt: Array<{ row: Row; err: string }> = [];

  for (const row of rows) {
    if (row.api_key === null) continue;
    if (!isEncrypted(row.api_key)) {
      legacyPlain.push(row);
      continue;
    }
    try {
      decryptWithKey(row.api_key, from); // проверка что OLD-ключ подходит
      toReencrypt.push(row);
    } catch (err) {
      failedDecrypt.push({ row, err: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`provider_settings с api_key: ${rows.length}`);
  console.log(`  encrypted под OLD ключом (re-encrypt):    ${toReencrypt.length}`);
  console.log(`  legacy plaintext (first-time encrypt):    ${legacyPlain.length}`);
  console.log(`  не расшифровалось под OLD (см. ниже):     ${failedDecrypt.length}`);

  if (failedDecrypt.length > 0) {
    console.error('\nОШИБКА: следующие строки не дешифрованы под указанным OLD ключом:');
    for (const f of failedDecrypt) {
      console.error(`  - ${f.row.id}: ${f.err}`);
    }
    console.error(
      '\nВероятные причины:\n' +
        '  1. Указан неверный OLD ключ — проверьте что это именно тот,\n' +
        '     которым шифровались эти строки.\n' +
        '  2. Часть строк зашифрована под промежуточным/другим ключом\n' +
        '     (несколько ротаций без обновлений). Их надо ротировать\n' +
        '     отдельным прогоном с правильным OLD.\n\n' +
        'Прерываюсь — никаких изменений не сделано.',
    );
    await closeDb();
    process.exit(2);
  }

  const total = toReencrypt.length + legacyPlain.length;
  if (total === 0) {
    console.log('\nНечего ротировать.');
    await closeDb();
    return;
  }

  if (!apply) {
    console.log('\n(dry-run) Чтобы реально применить — добавьте --apply');
    await closeDb();
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const row of toReencrypt) {
      const plaintext = decryptWithKey(row.api_key, from)!;
      const newEnv = encryptWithKey(plaintext, to);
      await client.query(`UPDATE provider_settings SET api_key = $1 WHERE id = $2`, [
        newEnv,
        row.id,
      ]);
      console.log(`  ✓ re-encrypted ${row.id}`);
    }
    for (const row of legacyPlain) {
      const newEnv = encryptWithKey(row.api_key, to);
      await client.query(`UPDATE provider_settings SET api_key = $1 WHERE id = $2`, [
        newEnv,
        row.id,
      ]);
      console.log(`  ✓ encrypted ${row.id} (was plaintext)`);
    }
    await client.query('COMMIT');
    console.log(`\nГотово. Обновлено: ${total}.`);
    console.log(
      '\nДальше:\n' +
        '  1. Пропишите новый ключ в env: SECRETS_ENCRYPTION_KEY=<NEW>\n' +
        '  2. Перезапустите api и worker (контейнеры): docker compose restart api worker\n' +
        '  3. Старый ключ безопасно сотрите.',
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Ошибка ротации, rollback:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
