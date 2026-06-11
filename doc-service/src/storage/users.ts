import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db.js';

/**
 * Users + user_project_access — модель пользователей и их доступов.
 *
 * Что есть сейчас:
 *   - users.role (super_admin / org_admin / manager / viewer) — глобальная
 *     роль пользователя, влияет на стартовый scope в API.
 *   - user_project_access — N:M с конкретной ролью в КАЖДОМ проекте.
 *     Менеджер может быть `admin` в одном проекте и `viewer` в другом.
 *
 * Что НЕ реализовано в этой фазе (заложено в БД):
 *   - api_token_hash — пока auth идёт через единственный API_KEY,
 *     поле NULL у всех. Под personal access tokens добавим SHA-256
 *     хэш + endpoint POST /users/:id/tokens.
 *   - OAuth / SSO — отдельная волна.
 *
 * Текущая auth-логика: единый Bearer-токен из ENV маппится в SYSTEM_USER_ID
 * (super_admin). См. auth.ts.
 */

export type UserRole = 'super_admin' | 'org_admin' | 'manager' | 'viewer';
export type UserStatus = 'active' | 'blocked';
export type UserKind = 'human' | 'service';
export type ProjectAccessRole = 'admin' | 'manager' | 'viewer';

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  organization_id: string | null;
  role: UserRole;
  status: UserStatus;
  kind: UserKind;
  api_token_hash: string | null;
  password_hash: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type UserAccessRow = {
  id: string;
  user_id: string;
  organization_id: string;
  project_id: string;
  role: ProjectAccessRole;
  created_at: Date;
};

export type UserInput = {
  email?: string | null;
  display_name: string;
  organization_id?: string | null;
  role?: UserRole;
  status?: UserStatus;
  kind?: UserKind;
};

class UsersRepo {
  async list(organizationId?: string, kind?: UserKind): Promise<UserRow[]> {
    // org_admin / manager / viewer привязаны к organization_id.
    // super_admin'ы (organization_id IS NULL) тоже видны в списке
    // организации, если запросил super_admin'ом — но фильтруем строго
    // по членству. UI решает что показывать.
    // kind (human/service) — опциональный доп-фильтр, композится с org.
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (organizationId) {
      values.push(organizationId);
      conditions.push(`organization_id = $${values.length}`);
    }
    if (kind) {
      values.push(kind);
      conditions.push(`kind = $${values.length}`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query<UserRow>(
      `SELECT * FROM users${where} ORDER BY display_name`,
      values,
    );
    return rows;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async create(input: UserInput): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (email, display_name, organization_id, role, status, kind)
       VALUES ($1, $2, $3, COALESCE($4, 'manager'), COALESCE($5, 'active'), COALESCE($6, 'human'))
       RETURNING *`,
      [
        input.email ?? null,
        input.display_name,
        input.organization_id ?? null,
        input.role ?? null,
        input.status ?? null,
        input.kind ?? null,
      ],
    );
    return rows[0]!;
  }

  async update(id: string, patch: Partial<UserInput>): Promise<UserRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.email !== undefined) {
      sets.push(`email = $${i++}`);
      values.push(patch.email);
    }
    if (patch.display_name !== undefined) {
      sets.push(`display_name = $${i++}`);
      values.push(patch.display_name);
    }
    if (patch.organization_id !== undefined) {
      sets.push(`organization_id = $${i++}`);
      values.push(patch.organization_id);
    }
    if (patch.role !== undefined) {
      sets.push(`role = $${i++}`);
      values.push(patch.role);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const { rows } = await db.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  // --- Access methods ---

  async listAccess(opts: { userId?: string; projectId?: string } = {}): Promise<UserAccessRow[]> {
    if (opts.userId) {
      const { rows } = await db.query<UserAccessRow>(
        `SELECT * FROM user_project_access WHERE user_id = $1 ORDER BY created_at DESC`,
        [opts.userId],
      );
      return rows;
    }
    if (opts.projectId) {
      const { rows } = await db.query<UserAccessRow>(
        `SELECT * FROM user_project_access WHERE project_id = $1 ORDER BY created_at DESC`,
        [opts.projectId],
      );
      return rows;
    }
    const { rows } = await db.query<UserAccessRow>(
      `SELECT * FROM user_project_access ORDER BY created_at DESC`,
    );
    return rows;
  }

  /**
   * Grant — upsert по UNIQUE (user_id, project_id). Меняет роль на новую,
   * если уже был грант.
   */
  async grantAccess(input: {
    user_id: string;
    organization_id: string;
    project_id: string;
    role: ProjectAccessRole;
  }): Promise<UserAccessRow> {
    const { rows } = await db.query<UserAccessRow>(
      `INSERT INTO user_project_access (user_id, organization_id, project_id, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [input.user_id, input.organization_id, input.project_id, input.role],
    );
    return rows[0]!;
  }

  async revokeAccess(userId: string, projectId: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `DELETE FROM user_project_access WHERE user_id = $1 AND project_id = $2`,
      [userId, projectId],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Personal access tokens ---
  //
  // Однотокенная модель: у каждого пользователя ровно один personal access
  // token (сохраняется хэш в users.api_token_hash, plaintext возвращается
  // вызывающему ровно один раз). Если нужно ротировать — генерируется
  // новый и старый автоматически перестаёт работать.
  //
  // Формат plaintext: `pdpat_<base64url-32-bytes>`. Префикс `pdpat_`
  // (parsdocs personal access token) даёт визуальный маркер «это наш
  // токен», помогает в логах и не конфликтует с глобальным API_KEY.

  /**
   * Сгенерировать новый токен для пользователя. Возвращает plaintext —
   * это единственный момент, когда он виден; следующий запрос увидит
   * только хэш.
   */
  async regenerateToken(userId: string): Promise<{ plaintext: string; user: UserRow } | null> {
    const plaintext = `pdpat_${randomBytes(32).toString('base64url')}`;
    const hash = hashToken(plaintext);
    const { rows } = await db.query<UserRow>(
      `UPDATE users SET api_token_hash = $1 WHERE id = $2 RETURNING *`,
      [hash, userId],
    );
    if (rows.length === 0) return null;
    return { plaintext, user: rows[0]! };
  }

  /** Полностью очистить токен (revoke). */
  async clearToken(userId: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(
      `UPDATE users SET api_token_hash = NULL WHERE id = $1 RETURNING *`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** Найти юзера по plaintext-токену (через хэш). null если токен невалиден. */
  async findByToken(plaintext: string): Promise<UserRow | null> {
    const hash = hashToken(plaintext);
    const { rows } = await db.query<UserRow>(
      `SELECT * FROM users WHERE api_token_hash = $1 AND status = 'active'`,
      [hash],
    );
    return rows[0] ?? null;
  }

  /**
   * Default project пользователя: детерминированно-первый активный проект
   * из user_project_access. `null`, если у пользователя нет ни одного гранта
   * (тогда auth-хук падает на системный DEFAULT_PROJECT_ID).
   *
   * Делается отдельным запросом, а не JOIN'ом в user-load: пользователь
   * грузится в auth-хуке тремя разными путями (multi-token, legacy hash,
   * findById), и сворачивать subquery в каждый из них дороже по
   * поддержке, чем один scoped lookup. Запрос лёгкий — bounded LIMIT 1
   * по индексу (user_id).
   *
   * ORDER BY created_at, project_id — стабильный детерминированный выбор:
   * created_at — порядок выдачи доступов, project_id — tie-break.
   */
  async getDefaultProjectId(userId: string): Promise<string | null> {
    const { rows } = await db.query<{ project_id: string }>(
      `SELECT project_id FROM user_project_access
        WHERE user_id = $1
        ORDER BY created_at, project_id
        LIMIT 1`,
      [userId],
    );
    return rows[0]?.project_id ?? null;
  }

  /** Bump last_seen_at — называется из auth-хука после успешной аутентификации. */
  async touchLastSeen(userId: string): Promise<void> {
    await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);
  }

  // --- Access scope резолверы (для guards в routes) ---

  /**
   * Полный набор project_id, к которым у пользователя есть доступ.
   * Для super_admin возвращает `null` (sentinel = «все проекты»).
   * Для org_admin — все проекты его организации.
   * Для manager/viewer — то что лежит в user_project_access.
   */
  async getAccessibleProjectIds(user: UserRow): Promise<Set<string> | null> {
    if (user.role === 'super_admin') return null;
    if (user.role === 'org_admin' && user.organization_id) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM projects WHERE organization_id = $1`,
        [user.organization_id],
      );
      return new Set(rows.map((r) => r.id));
    }
    const { rows } = await db.query<{ project_id: string }>(
      `SELECT project_id FROM user_project_access WHERE user_id = $1`,
      [user.id],
    );
    return new Set(rows.map((r) => r.project_id));
  }

  /**
   * Доступные организации. super_admin → null (все); org_admin → его одна;
   * остальные — собирается из их project-доступов через JOIN.
   */
  async getAccessibleOrgIds(user: UserRow): Promise<Set<string> | null> {
    if (user.role === 'super_admin') return null;
    if (user.organization_id) return new Set([user.organization_id]);
    const { rows } = await db.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id FROM user_project_access WHERE user_id = $1`,
      [user.id],
    );
    return new Set(rows.map((r) => r.organization_id));
  }

  /**
   * Проектная роль (admin/manager/viewer) текущего пользователя в
   * конкретном проекте. Возвращает null если доступа нет.
   * super_admin/org_admin (на своём org'е) считаются 'admin'.
   */
  async getProjectRole(
    user: UserRow,
    projectId: string,
  ): Promise<ProjectAccessRole | null> {
    if (user.role === 'super_admin') return 'admin';
    if (user.role === 'org_admin' && user.organization_id) {
      const { rows } = await db.query<{ organization_id: string }>(
        `SELECT organization_id FROM projects WHERE id = $1`,
        [projectId],
      );
      if (rows[0]?.organization_id === user.organization_id) return 'admin';
      return null;
    }
    const { rows } = await db.query<{ role: ProjectAccessRole }>(
      `SELECT role FROM user_project_access WHERE user_id = $1 AND project_id = $2`,
      [user.id, projectId],
    );
    return rows[0]?.role ?? null;
  }

  toApi(row: UserRow) {
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      organization_id: row.organization_id,
      role: row.role,
      status: row.status,
      kind: row.kind,
      has_api_token: !!row.api_token_hash,
      last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  toAccessApi(row: UserAccessRow) {
    return {
      id: row.id,
      user_id: row.user_id,
      organization_id: row.organization_id,
      project_id: row.project_id,
      role: row.role,
      created_at: row.created_at.toISOString(),
    };
  }
}

/** sha-256 over plaintext token. Хэш — то что лежит в БД. */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export const usersRepo = new UsersRepo();
