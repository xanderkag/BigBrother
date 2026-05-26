/**
 * EXT-B (Q11): per-request BYO (bring-your-own) LLM credentials.
 *
 * Consumer (SLAI) может передать на POST /jobs свой LLM-провайдер/ключ/модель
 * через заголовки `X-LLM-*`. THIS job пойдёт через эти creds вместо default
 * provider_settings. Включается флагом `BYO_LLM_ENABLED` (config.byoLlmEnabled).
 *
 * SECURITY (главное требование Q11): api_key НИКОГДА не должен оказаться в
 * plaintext в БД, Redis, логах, audit, last_llm_call-трассе или error-сообщениях.
 *
 * Как творится магия безопасно через границу очереди:
 *   1. Route (POST /jobs, sync HTTP-контекст) читает заголовки, собирает
 *      InlineLlmCredentials.
 *   2. Route шифрует ВЕСЬ объект secrets-envelope'ом (AES-256-GCM) и кладёт
 *      зашифрованную строку в `metadata._inline_llm_creds`. В БД/Redis ложится
 *      только непрозрачный envelope — расшифровать без SECRETS_ENCRYPTION_KEY
 *      нельзя.
 *   3. Worker (orchestrator.processJob) достаёт envelope из metadata,
 *      расшифровывает в локальную переменную (никуда не пишет) и оборачивает
 *      обработку в `dynamicLlm.withInlineCredentials(...)`. AsyncLocalStorage
 *      не пересекает границу очереди — поэтому передаём ЗАШИФРОВАННО через
 *      job-payload (metadata), а ALS поднимаем уже внутри воркера.
 *   4. Reserved-ключ `_inline_llm_creds` вычищается из всех outbound-поверхностей
 *      (GET /jobs response, webhook metadata) даже будучи envelope'ом — см.
 *      stripInlineCredentials.
 */

import { encryptSecret, decryptSecret } from '../../storage/secrets.js';

/** Reserved metadata-ключ, в котором живёт зашифрованный envelope BYO-creds. */
export const INLINE_CREDS_METADATA_KEY = '_inline_llm_creds';

/** Маркер, которым подменяется api_key при любой сериализации для логов. */
export const REDACTED_MARKER = '[REDACTED]';

/**
 * Расшифрованная форма BYO-creds. `provider` обязателен (нужен для метрик-
 * лейбла и для выбора backend'а в inference-service). `apiKey` обязателен —
 * без него BYO бессмысленен (fallback на default). `model`/`baseUrl` опц.
 */
export type InlineLlmCredentials = {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

/** Подмножество HTTP-заголовков (lowercase), которые мы читаем. */
export type InlineCredHeaders = {
  'x-llm-provider'?: unknown;
  'x-llm-api-key'?: unknown;
  'x-llm-model'?: unknown;
  'x-llm-base-url'?: unknown;
};

function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Прочитать `X-LLM-*` заголовки. Возвращает:
 *   - `null` если ни одного X-LLM-заголовка нет (BYO не запрошен).
 *   - `{ creds: null, present: true }` если заголовки есть, но без api_key —
 *     это ошибка клиента (нечего использовать), caller отдаёт 400.
 *   - `{ creds, present: true }` при валидном наборе.
 *
 * Не бросает: caller сам решает что делать (400 / ignore).
 */
export function readInlineCredHeaders(headers: InlineCredHeaders): {
  present: boolean;
  creds: InlineLlmCredentials | null;
} {
  const provider = asTrimmedString(headers['x-llm-provider']);
  const apiKey = asTrimmedString(headers['x-llm-api-key']);
  const model = asTrimmedString(headers['x-llm-model']);
  const baseUrl = asTrimmedString(headers['x-llm-base-url']);

  const anyPresent =
    provider !== undefined ||
    apiKey !== undefined ||
    model !== undefined ||
    baseUrl !== undefined;

  if (!anyPresent) return { present: false, creds: null };
  if (!apiKey || !provider) return { present: true, creds: null };

  return {
    present: true,
    creds: { provider, apiKey, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) },
  };
}

/**
 * Зашифровать creds в непрозрачный envelope для безопасного провоза через
 * job-payload (metadata → Postgres/Redis). Возвращает строку с префиксом `v1:`.
 */
export function encryptInlineCredentials(creds: InlineLlmCredentials): string {
  const json = JSON.stringify(creds);
  const envelope = encryptSecret(json);
  // encryptSecret возвращает null только для пустой строки — JSON непустой.
  if (!envelope) throw new Error('inline-credentials: encryption produced empty envelope');
  return envelope;
}

/**
 * Расшифровать envelope из metadata. Fail-soft: при любой ошибке (повреждён,
 * key mismatch, не envelope) возвращаем null — caller тогда идёт по
 * default-провайдеру, не падая и не раскрывая ничего.
 */
export function decryptInlineCredentials(value: unknown): InlineLlmCredentials | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let json: string | null;
  try {
    json = decryptSecret(value);
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).provider !== 'string' ||
    typeof (parsed as Record<string, unknown>).apiKey !== 'string'
  ) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  return {
    provider: p.provider as string,
    apiKey: p.apiKey as string,
    ...(typeof p.model === 'string' ? { model: p.model } : {}),
    ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl } : {}),
  };
}

/**
 * Вычистить reserved-ключ `_inline_llm_creds` из metadata перед любой
 * отправкой наружу (webhook, GET /jobs response). Возвращает копию без ключа;
 * `null`/не-object возвращаются как есть. Опускаемся только на верхний уровень —
 * envelope лежит именно там (route его туда кладёт).
 */
export function stripInlineCredentials<T>(metadata: T): T {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }
  const obj = metadata as Record<string, unknown>;
  if (!(INLINE_CREDS_METADATA_KEY in obj)) return metadata;
  const { [INLINE_CREDS_METADATA_KEY]: _omit, ...rest } = obj;
  return rest as unknown as T;
}

/**
 * Грубая, безопасная классификация ошибки LLM-вызова для метрики-лейбла
 * `code`. НИКОГДА не возвращает текст ошибки целиком (он мог бы заэхоить
 * api_key из upstream-сообщения). Допустимые значения низко-кардинальны:
 *   http_4xx | http_5xx | timeout | network | unknown
 */
export function classifyLlmError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // HttpLlmClient бросает 'LLM <path> <status>: <body>' — вытащим только статус.
  const httpMatch = /^LLM\s+\S+\s+(\d{3})\b/.exec(msg);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status >= 500) return 'http_5xx';
    if (status >= 400) return 'http_4xx';
  }
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('socket') ||
    lower.includes('fetch failed')
  ) {
    return 'network';
  }
  return 'unknown';
}
