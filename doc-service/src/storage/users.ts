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
export type ProjectAccessRole = 'admin' | 'manager' | 'viewer';

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  organization_id: string | null;
  role: UserRole;
  status: UserStatus;
  api_token_hash: string | null;
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
};

class UsersRepo {
  async list(organizationId?: string): Promise<UserRow[]> {
    if (organizationId) {
      const { rows } = await db.query<UserRow>(
        // org_admin / manager / viewer привязаны к organization_id.
        // super_admin'ы (organization_id IS NULL) тоже видны в списке
        // организации, если запросил super_admin'ом — но фильтруем строго
        // по членству. UI решает что показывать.
        `SELECT * FROM users WHERE organization_id = $1 ORDER BY display_name`,
        [organizationId],
      );
      return rows;
    }
    const { rows } = await db.query<UserRow>(`SELECT * FROM users ORDER BY display_name`);
    return rows;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async create(input: UserInput): Promise<UserRow> {
    const { rows } = await db.query<UserRow>(
      `INSERT INTO users (email, display_name, organization_id, role, status)
       VALUES ($1, $2, $3, COALESCE($4, 'manager'), COALESCE($5, 'active'))
       RETURNING *`,
      [
        input.email ?? null,
        input.display_name,
        input.organization_id ?? null,
        input.role ?? null,
        input.status ?? null,
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

  toApi(row: UserRow) {
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      organization_id: row.organization_id,
      role: row.role,
      status: row.status,
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

export const usersRepo = new UsersRepo();
