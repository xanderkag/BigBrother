import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { hashToken } from './users.js';

/**
 * Personal access tokens — multi-token модель.
 *
 * Каждый user имеет N токенов, каждый с подписью (`name`, например
 * "ci", "macbook"), опциональным `expires_at` и треком `last_used_at`.
 * Plaintext возвращается ровно один раз — при создании.
 *
 * Формат plaintext: `pdpat_<base64url-32-bytes>` (тот же что был в
 * однотокенной модели). Совместимость auth-хука обеспечивается тем,
 * что при поиске по хэшу мы сначала пробуем эту таблицу, затем
 * legacy `users.api_token_hash`.
 *
 * Lookup hot-path должен быть быстрым: индекс по `token_hash` уже
 * UNIQUE, точечный SELECT даёт O(log n). `expires_at` проверяется
 * в коде, не SQL — единичный кейс, не нужна частичная индексация.
 */

export type TokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

class TokensRepo {
  /** Создать токен. Возвращает plaintext + строку. Plaintext виден один раз. */
  async create(input: {
    user_id: string;
    name: string;
    expires_at?: Date | null;
  }): Promise<{ plaintext: string; row: TokenRow }> {
    const plaintext = `pdpat_${randomBytes(32).toString('base64url')}`;
    const hash = hashToken(plaintext);
    const { rows } = await db.query<TokenRow>(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.user_id, input.name, hash, input.expires_at ?? null],
    );
    return { plaintext, row: rows[0]! };
  }

  async findById(id: string): Promise<TokenRow | null> {
    const { rows } = await db.query<TokenRow>(
      `SELECT * FROM personal_access_tokens WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listByUser(userId: string): Promise<TokenRow[]> {
    const { rows } = await db.query<TokenRow>(
      `SELECT * FROM personal_access_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  }

  async findByHash(hash: string): Promise<TokenRow | null> {
    const { rows } = await db.query<TokenRow>(
      `SELECT * FROM personal_access_tokens WHERE token_hash = $1`,
      [hash],
    );
    return rows[0] ?? null;
  }

  /** Дропает токен по id, проверяя что он принадлежит юзеру (защита от чужого revoke). */
  async revoke(id: string, requiredUserId?: string): Promise<boolean> {
    if (requiredUserId) {
      const { rowCount } = await db.query(
        `DELETE FROM personal_access_tokens WHERE id = $1 AND user_id = $2`,
        [id, requiredUserId],
      );
      return (rowCount ?? 0) > 0;
    }
    const { rowCount } = await db.query(`DELETE FROM personal_access_tokens WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Async fire-and-forget update last_used_at. Caller не должен ждать. */
  async touchLastUsed(id: string): Promise<void> {
    await db.query(`UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1`, [id]);
  }

  /** Дропает все токены юзера — used при блокировке аккаунта. */
  async revokeAllForUser(userId: string): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM personal_access_tokens WHERE user_id = $1`,
      [userId],
    );
    return rowCount ?? 0;
  }

  /** Считается ли токен expired по `now()`? */
  static isExpired(row: TokenRow): boolean {
    if (row.expires_at === null) return false;
    return row.expires_at.getTime() <= Date.now();
  }

  toApi(row: TokenRow) {
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
      is_expired: TokensRepo.isExpired(row),
      last_used_at: row.last_used_at ? row.last_used_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
    };
  }
}

export const tokensRepo = new TokensRepo();
export { TokensRepo };
