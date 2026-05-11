/**
 * Sanitizer для клиентского `metadata` поля при создании job'а.
 *
 * Проблема: клиент через API передаёт произвольный JSON в `metadata`,
 * мы кладём его как есть в `jobs.metadata` JSONB и эхо-возвращаем в
 * webhook. Если клиент по ошибке (или специально) положит туда свой
 * API-токен — он окажется:
 *   - в нашем дампе БД,
 *   - в логах (некоторые операции логируют metadata),
 *   - в webhook'е третьему лицу.
 *
 * Решение: рекурсивно проходим metadata и:
 *   1. Если **имя ключа** похоже на «носитель секрета» (password,
 *      token, api_key, и т.п.) — значение редактируется независимо
 *      от его формата.
 *   2. Если **значение** начинается с известного префикса секрета
 *      (sk-ant-, sk-, AKIA, ya29., и т.п.) — редактируется тоже.
 *
 * Редакция = замена на маркер `[REDACTED: <reason>]`. Это даёт оператору
 * понять что что-то было закрашено, без раскрытия значения. Возвращаем
 * также `redactionsCount` — caller (POST /jobs) логирует warn если >0,
 * чтобы видеть «вот тут клиент пытался передать секрет».
 *
 * Консервативная стратегия по value-паттернам — лучше пропустить
 * редкий секрет, чем закрасить нормальное значение и сломать клиента.
 * Покрываем только хорошо известные префиксы.
 */

/** Имена ключей, чьё значение всегда редактируется. */
const SECRET_KEY_PATTERN = /^(password|passwd|pwd|secret|token|api[_-]?key|apikey|auth(orization)?|credentials?|private[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret)$/i;

/** Префиксы хорошо известных секрет-значений. Должны быть достаточно длинными, чтобы не пересечься со случайными строками. */
const SECRET_VALUE_PREFIXES: ReadonlyArray<{ rx: RegExp; reason: string }> = [
  { rx: /^sk-ant-[A-Za-z0-9_-]{20,}/, reason: 'Anthropic API key' },
  { rx: /^sk-proj-[A-Za-z0-9_-]{20,}/, reason: 'OpenAI project key' },
  { rx: /^sk-[A-Za-z0-9]{20,}/, reason: 'OpenAI / Stripe key' },
  { rx: /^pk_(live|test)_[A-Za-z0-9]{20,}/, reason: 'Stripe public key' },
  { rx: /^rk_(live|test)_[A-Za-z0-9]{20,}/, reason: 'Stripe restricted key' },
  { rx: /^AKIA[0-9A-Z]{16}$/, reason: 'AWS access key ID' },
  { rx: /^ya29\.[A-Za-z0-9_-]{20,}/, reason: 'Google OAuth token' },
  { rx: /^ghp_[A-Za-z0-9]{36}/, reason: 'GitHub personal token' },
  { rx: /^gho_[A-Za-z0-9]{36}/, reason: 'GitHub OAuth token' },
  { rx: /^github_pat_[A-Za-z0-9_]{20,}/, reason: 'GitHub fine-grained PAT' },
  { rx: /^pdpat_[A-Za-z0-9_-]{30,}/, reason: 'parsdocs personal access token' },
  { rx: /^xox[abp]-[A-Za-z0-9-]{20,}/, reason: 'Slack token' },
];

const MAX_DEPTH = 8; // защита от циклических ссылок / атак-на-глубину

export type SanitizeResult = {
  sanitized: unknown;
  redactionsCount: number;
};

/**
 * Главная точка входа: рекурсивно обрабатывает значение и возвращает
 * очищенный JSON + счётчик редакций.
 */
export function sanitizeMetadata(value: unknown): SanitizeResult {
  let count = 0;
  const walk = (v: unknown, parentKey: string | null, depth: number): unknown => {
    if (depth > MAX_DEPTH) return v;
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      // Редакция по имени ключа: parent key — это имя поля, в котором лежит
      // данная строка. password → редактируем всегда.
      if (parentKey && SECRET_KEY_PATTERN.test(parentKey)) {
        count += 1;
        return `[REDACTED: key=${parentKey}]`;
      }
      // Редакция по значению: префиксы известных секретов.
      for (const { rx, reason } of SECRET_VALUE_PREFIXES) {
        if (rx.test(v)) {
          count += 1;
          return `[REDACTED: ${reason}]`;
        }
      }
      return v;
    }
    if (Array.isArray(v)) {
      return v.map((it) => walk(it, parentKey, depth + 1));
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(v)) {
        out[k] = walk(sub, k, depth + 1);
      }
      return out;
    }
    // numbers, booleans — оставляем как есть.
    return v;
  };
  const sanitized = walk(value, null, 0);
  return { sanitized, redactionsCount: count };
}
