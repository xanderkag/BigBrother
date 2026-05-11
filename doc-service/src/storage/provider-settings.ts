import { db } from '../db.js';

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
 * Secrets policy: api_key is stored in plaintext on the MVP. Production
 * deployments must wrap the column with envelope encryption (KMS or
 * pgcrypto-extension) — tracked in TECH_DEBT. All API responses go
 * through `toApi()` which returns a masked stub (`••••1234`), never the
 * plaintext.
 */

export type ProviderKind = 'llm' | 'ocr';

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
  extra: Record<string, unknown> | null;
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
  is_active?: boolean;
  extra?: Record<string, unknown> | null;
};

/** Patch shape for partial updates. `api_key: null` clears the key, `undefined` leaves untouched. */
export type ProviderSettingPatch = Partial<Omit<ProviderSettingInput, 'id'>>;

function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

class ProviderSettingsRepo {
  async list(): Promise<ProviderSettingRow[]> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings ORDER BY kind, display_name`,
    );
    return rows;
  }

  async findById(id: string): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Returns the (at most one) default provider for the given kind. */
  async findDefault(kind: ProviderKind): Promise<ProviderSettingRow | null> {
    const { rows } = await db.query<ProviderSettingRow>(
      `SELECT * FROM provider_settings WHERE kind = $1 AND is_default = true AND is_active = true LIMIT 1`,
      [kind],
    );
    return rows[0] ?? null;
  }

  /** Create-or-replace by id. Default flag is never set via this method — use `setDefault`. */
  async upsert(input: ProviderSettingInput): Promise<ProviderSettingRow> {
    const { rows } = await db.query<ProviderSettingRow>(
      `INSERT INTO provider_settings
         (id, kind, display_name, description, base_url, api_key, model, is_active, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true), $9)
       ON CONFLICT (id) DO UPDATE SET
         kind         = EXCLUDED.kind,
         display_name = EXCLUDED.display_name,
         description  = EXCLUDED.description,
         base_url     = EXCLUDED.base_url,
         api_key      = EXCLUDED.api_key,
         model        = EXCLUDED.model,
         is_active    = EXCLUDED.is_active,
         extra        = EXCLUDED.extra
       RETURNING *`,
      [
        input.id,
        input.kind,
        input.display_name,
        input.description ?? null,
        input.base_url ?? null,
        input.api_key ?? null,
        input.model ?? null,
        input.is_active ?? true,
        input.extra ?? null,
      ],
    );
    return rows[0]!;
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
    if (patch.api_key !== undefined) push('api_key', patch.api_key);
    if (patch.model !== undefined) push('model', patch.model);
    if (patch.is_active !== undefined) push('is_active', patch.is_active);
    if (patch.extra !== undefined) push('extra', patch.extra);
    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await db.query<ProviderSettingRow>(
      `UPDATE provider_settings SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
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
      return rows[0] ?? null;
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
    return rows[0] ?? null;
  }

  /**
   * Public-API shape: never exposes the raw `api_key`. Returns a
   * mask + `has_api_key` flag so the UI can show "key configured" without
   * leaking the secret to any client (including XSS payloads on the page).
   */
  toApi(row: ProviderSettingRow) {
    return {
      id: row.id,
      kind: row.kind,
      display_name: row.display_name,
      description: row.description,
      base_url: row.base_url,
      api_key_masked: maskKey(row.api_key),
      has_api_key: !!row.api_key,
      model: row.model,
      is_active: row.is_active,
      is_default: row.is_default,
      extra: row.extra,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const providerSettingsRepo = new ProviderSettingsRepo();
