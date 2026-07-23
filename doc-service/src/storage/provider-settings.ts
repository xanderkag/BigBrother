import { db } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';

/**
 * Provider Settings repository.
 *
 * Stores external service credentials (Anthropic / OpenAI / Yandex / local
 * Qwen) so the admin can rotate keys and switch the active provider through
 * the UI without redeploying. On the read path:
 *
 *   - `findDefault(kind)` returns the row marked `is_default=true` for the
 *     given category. There's a partial UNIQUE index enforcing one default
 *     per kind, so callers can rely on at most one row.
 *   - `setDefault(id)` flips the default flag in a single transaction
 *     (clear other defaults of the same kind, then set this one). This
 *     avoids a brief inconsistent window where two rows are default.
 *
 * Secrets policy: `api_key` шифруется envelope-схемой (AES-256-GCM)
 * до записи в БД и расшифровывается на чтении. Дамп БД, репликация,
 * SQL-injection — всё видит непрозрачный `v1:...` envelope, без
 * мастер-ключа из env он бесполезен. Подробнее в `./secrets.ts`.
 *
 * Lazy-миграция: если в БД лежит старый plaintext (до развёртывания
 * фичи), `decryptSecret` возвращает его как есть. После следующего
 * write строка автоматически становится encrypted-envelope'ом. Можно
 * принудительно прогнать всё через `npm run migrate:secrets`.
 *
 * API-responses ВСЕГДА маскированы (`••••1234`), plaintext-ключ не
 * утекает через `toApi()`. Внутри hot-path'а (DynamicLlmClient) ключ
 * сначала расшифровывается через `findById/findDefault` и передаётся
 * в HTTP-Authorization уже в открытом виде.
 */

export type ProviderKind = 'llm' | 'ocr' | 'dadata' | 'yandex_maps';

/**
 * MTI-2 (§2.1): одна модель внутри pack'а провайдера.
 *   - `name`  — то, что реально уходит в inference `body.model` (ollama-tag,
 *               anthropic model-id). Обязателен.
 *   - `alias` — короткое имя для per-job выбора (`metadata._llm_model: "opus"`);
 *               резолвер найдёт по нему `name`. Опционален.
 *   - `vision`/`cost_tier` — метаданные для UI/роутинга (не влияют на вызов).
 */
export type ProviderModel = {
  name: string;
  alias?: string | null;
  vision?: boolean;
  cost_tier?: 'low' | 'mid' | 'high' | null;
};

/**
 * Нормализует сырой JSONB `models` из БД в массив валидных ProviderModel.
 * Терпим к мусору (не-массив, элементы без name) — отбрасываем такие,
 * чтобы кривая строка в БД не роняла hot-path резолва.
 */
export function parseProviderModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderModel[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object') continue;
    const e = el as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.length === 0) continue;
    out.push({
      name: e.name,
      alias: typeof e.alias === 'string' && e.alias.length > 0 ? e.alias : null,
      vision: e.vision === true,
      cost_tier:
        e.cost_tier === 'low' || e.cost_tier === 'mid' || e.cost_tier === 'high'
          ? e.cost_tier
          : null,
    });
  }
  return out;
}

/**
 * Дополнительный секрет в `extra`. Для kind='dadata' это `secret_key`
 * (DaData cleaning API). Маскируется/опускается в `toApi()` — никогда не
 * уходит клиенту в plaintext.
 */
const SECRET_EXTRA_KEYS = ['secret_key'] as const;

export type ProviderSettingRow = {
  id: string;
  kind: ProviderKind;
  display_name: string;
  description: string | null;
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  is_active: boolean;
  is_default: boolean;
  /**
   * Vision-capability flag (item A). Когда true и провайдер резолвится в
   * hot-path, doc-service шлёт первую страницу документа в /v1/extract как
   * image_base64 — модель извлекает поля напрямую из картинки. См.
   * миграцию 20260528000001.
   */
  vision: boolean;
  /**
   * MTI-2 (§2.1): pack моделей провайдера. Один провайдер (один ключ, один
   * endpoint) несёт несколько моделей — резолвер выбирает нужную per-job без
   * дублирования строк. Пусто → берём legacy-колонку `model`.
   */
  models: ProviderModel[];
  /**
   * MTI-2 (§2.1): модель по умолчанию. Приоритет: job `_llm_model` →
   * type `preferred_model` → `default_model` → legacy `model`. NULL → откат
   * на `model` (backward-compat, миграция 20260723000002 бэкфиллит из model).
   */
  default_model: string | null;
  extra: Record<string, unknown> | null;
  /**
   * BILL-1: прайс-лист провайдера — {currency, cost_basis, llm_input_per_1k,
   * llm_output_per_1k, ocr_page, ocr_page_table}. NULL → ставка неизвестна,
   * расход помечается estimate (молча считать нулём запрещено).
   * Своё железо идёт с cost_basis='amortized' (коммерческий эквивалент).
   */
  rates: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

export type ProviderSettingInput = {
  id: string;
  kind: ProviderKind;
  display_name: string;
  description?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  /** MTI-2: pack моделей провайдера. Undefined → не трогаем (upsert ставит []). */
  models?: ProviderModel[] | null;
  /** MTI-2: модель по умолчанию. */
  default_model?: string | null;
  is_active?: boolean;
  vision?: boolean;
  extra?: Record<string, unknown> | null;
};

/** Patch shape for partial updates. `api_key: null` clears the key, `undefined` leaves untouched. */
export type ProviderSettingPatch = Partial<Omit<ProviderSettingInput, 'id'>>;

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

/** Шифрует известные secret-поля внутри `extra` (для записи). Возвращает НОВЫЙ объект. */
function encryptExtraSecrets(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (extra === null || extra === undefined) return extra ?? null;
  const out: Record<string, unknown> = { ...extra };
  for (const k of SECRET_EXTRA_KEYS) {
    const v = out[k];
    if (typeof v === 'string') out[k] = encryptSecret(v);
    else if (v === null) delete out[k];
  }
  return out;
}

/** Расшифровывает secret-поля внутри `extra` (для чтения). Возвращает НОВЫЙ объект. */
function decryptExtraSecrets(
  extra: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (extra === null) return null;
  const out: Record<string, unknown> = { ...extra };
  for (const k of SECRET_EXTRA_KEYS) {
    const v = out[k];
    if (typeof v === 'string') out[k] = decryptSecret(v);
  }
  return out;
}

class ProviderSettingsRepo {
  /**
   * Hot-path row → расшифровка api_key. Все методы чтения проходят
   * через этот хелпер, чтобы downstream (DynamicLlmClient, audit,
   * toApi) видел уже plaintext или legacy-значение.
   */
  private decryptRow(row: ProviderSettingRow): ProviderSettingRow {
    return {
      ...row,
      api_key: row.api_key === null ? null : decryptSecret(row.api_key),
      extra: decryptExtraSecrets(row.extra),
      // MTI-2: нормализуем pack (JSONB → чистый ProviderModel[]), терпимо к
      // мусору/легаси — кривая строка в БД не должна ронять резолв.
      models: parseProviderModels(row.models),
    };
  }

  async list(): Promise<ProviderSettingRow[]> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings ORDER BY kind, display_name`,
    );
    return rows.map((r) => this.decryptRow(r));
  }

  async findById(id: string): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  /**
   * Hybrid-routing (SLAI #3): подобрать активного vision-capable LLM-провайдера.
   * Используется роутером когда нужен vision-путь, но `HYBRID_VISION_PROVIDER_ID`
   * не задан явно. Предпочитаем is_default (если он сам vision), иначе любую
   * активную vision-строку (детерминированный порядок по display_name).
   * Возвращает null если ни одной активной vision-строки нет → caller fail-soft
   * откатывается на text-путь.
   */
  async findActiveVision(): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings
        WHERE kind = 'llm' AND is_active = true AND vision = true
        ORDER BY is_default DESC, display_name
        LIMIT 1`,
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  /** Returns the (at most one) default provider for the given kind. */
  async findDefault(kind: ProviderKind): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings WHERE kind = $1 AND is_default = true AND is_active = true LIMIT 1`,
      [kind],
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  /** Create-or-replace by id. Default flag is never set via this method — use `setDefault`. */
  async upsert(input: ProviderSettingInput): Promise<ProviderSettingRow> {
    const { rows } = await db.query<ProviderSettingRow>(
      `INSERT INTO provider_settings
         (id, kind, display_name, description, base_url, api_key, model, is_active, vision, extra, models, default_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true), COALESCE($9, false), $10, COALESCE($11::jsonb, '[]'::jsonb), $12)
       ON CONFLICT (id) DO UPDATE SET
         kind          = EXCLUDED.kind,
         display_name  = EXCLUDED.display_name,
         description   = EXCLUDED.description,
         base_url      = EXCLUDED.base_url,
         api_key       = EXCLUDED.api_key,
         model         = EXCLUDED.model,
         is_active     = EXCLUDED.is_active,
         vision        = EXCLUDED.vision,
         extra         = EXCLUDED.extra,
         models        = EXCLUDED.models,
         default_model = EXCLUDED.default_model
       RETURNING *`,
      [
        input.id,
        input.kind,
        input.display_name,
        input.description ?? null,
        input.base_url ?? null,
        // api_key шифруется ДО записи. null/'' проходят как есть.
        encryptSecret(input.api_key ?? null),
        input.model ?? null,
        input.is_active ?? true,
        input.vision ?? false,
        // extra.secret_key шифруется ДО записи, как и api_key.
        encryptExtraSecrets(input.extra),
        // MTI-2: pack — JS-массив стрингуем явно (node-pg иначе сделает
        // postgres array-литерал, а не jsonb). undefined → NULL → COALESCE '[]'.
        input.models === undefined || input.models === null
          ? null
          : JSON.stringify(input.models),
        input.default_model ?? null,
      ],
    );
    // Возвращаем уже расшифрованную row, чтобы вызывающий код не натолкнулся
    // на envelope при логировании / маскировке.
    return this.decryptRow(rows[0]!);
  }

  /**
   * Partial update. Only fields present in `patch` (including explicit
   * `null`) are written; `undefined` leaves the column untouched. Returns
   * `null` if no row with the id exists.
   */
  async patch(id: string, patch: ProviderSettingPatch): Promise<ProviderSettingRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const push = (col: string, value: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(value);
    };
    if (patch.kind !== undefined) push('kind', patch.kind);
    if (patch.display_name !== undefined) push('display_name', patch.display_name);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.base_url !== undefined) push('base_url', patch.base_url);
    // api_key шифруется на write. `null` (явная очистка) проходит как есть.
    if (patch.api_key !== undefined) push('api_key', encryptSecret(patch.api_key));
    if (patch.model !== undefined) push('model', patch.model);
    if (patch.is_active !== undefined) push('is_active', patch.is_active);
    if (patch.vision !== undefined) push('vision', patch.vision);
    if (patch.extra !== undefined) push('extra', encryptExtraSecrets(patch.extra));
    // MTI-2: pack — явный ::jsonb cast + stringify (см. upsert). null → '[]'
    // (колонка NOT NULL DEFAULT '[]', очистка pack'а = пустой массив).
    if (patch.models !== undefined) {
      sets.push(`models = $${i++}::jsonb`);
      values.push(patch.models === null ? '[]' : JSON.stringify(patch.models));
    }
    if (patch.default_model !== undefined) push('default_model', patch.default_model);
    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await db.query<ProviderSettingRow>(
      `UPDATE provider_settings SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  /**
   * Atomically promote a row to default for its kind. Clears the previous
   * default of the same kind in the same transaction so the UNIQUE index
   * never sees two defaults at once.
   */
  async setDefault(id: string): Promise<ProviderSettingRow | null> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<ProviderSettingRow>(
        `SELECT * FROM provider_settings WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const target = found.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE provider_settings SET is_default = false WHERE kind = $1 AND id <> $2`,
        [target.kind, id],
      );
      const { rows } = await client.query<ProviderSettingRow>(
        `UPDATE provider_settings SET is_default = true, is_active = true WHERE id = $1 RETURNING *`,
        [id],
      );
      await client.query('COMMIT');
      return rows[0] ? this.decryptRow(rows[0]) : null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `DELETE FROM provider_settings WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0] ? this.decryptRow(rows[0]) : null;
  }

  /**
   * Public-API shape: never exposes the raw `api_key`. Returns a
   * mask + `has_api_key` flag so the UI can show "key configured" without
   * leaking the secret to any client (including XSS payloads on the page).
   */
  toApi(row: ProviderSettingRow) {
    // Маскируем secret-поля внутри extra (не возвращаем plaintext клиенту).
    let extra = row.extra;
    let hasSecretKey = false;
    if (extra) {
      const masked: Record<string, unknown> = { ...extra };
      for (const k of SECRET_EXTRA_KEYS) {
        const v = masked[k];
        if (typeof v === 'string' && v.length > 0) {
          if (k === 'secret_key') hasSecretKey = true;
          masked[k] = maskKey(v);
        }
      }
      extra = masked;
    }
    return {
      id: row.id,
      kind: row.kind,
      display_name: row.display_name,
      description: row.description,
      base_url: row.base_url,
      api_key_masked: maskKey(row.api_key),
      has_api_key: !!row.api_key,
      has_secret_key: hasSecretKey,
      model: row.model,
      // MTI-2: pack моделей + дефолт — не секрет, отдаём как есть для UI-редактора.
      models: row.models,
      default_model: row.default_model,
      is_active: row.is_active,
      is_default: row.is_default,
      vision: row.vision,
      extra,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const providerSettingsRepo = new ProviderSettingsRepo();

/**
 * Test-only: доступ к extra-encryption round-trip без БД. Позволяет
 * доказать, что non-secret ключи (напр. `reasoning_effort`) переживают
 * write/read нетронутыми и НЕ шифруются (не попадают в SECRET_EXTRA_KEYS).
 */
export const _extraSecretsForTesting = {
  encrypt: encryptExtraSecrets,
  decrypt: decryptExtraSecrets,
  secretKeys: SECRET_EXTRA_KEYS,
};
