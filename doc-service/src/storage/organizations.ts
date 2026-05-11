import { db } from '../db.js';

/**
 * Organizations — корневая tenant-граница.
 *
 * Каждый рабочий артефакт (job, в будущем — webhook, custom тип
 * документа) принадлежит одной организации. Удаление org каскадно
 * сносит проекты и user_project_access, но НЕ jobs/audit_log (там
 * RESTRICT через REFERENCES без ON DELETE — данные сохраняются как
 * orphan'ы и подметаются вручную при decom клиента).
 */

export type OrganizationType = 'internal_division' | 'external_company' | 'test' | 'system';
export type OrganizationStatus = 'active' | 'archived';

export type OrganizationRow = {
  id: string;
  name: string;
  type: OrganizationType;
  status: OrganizationStatus;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

export type OrganizationInput = {
  name: string;
  type?: OrganizationType;
  status?: OrganizationStatus;
  metadata?: Record<string, unknown> | null;
};

class OrganizationsRepo {
  async list(): Promise<OrganizationRow[]> {
    const { rows } = await db.query<OrganizationRow>(
      `SELECT * FROM organizations ORDER BY name`,
    );
    return rows;
  }

  async findById(id: string): Promise<OrganizationRow | null> {
    const { rows } = await db.query<OrganizationRow>(
      `SELECT * FROM organizations WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(input: OrganizationInput): Promise<OrganizationRow> {
    const { rows } = await db.query<OrganizationRow>(
      `INSERT INTO organizations (name, type, status, metadata)
       VALUES ($1, COALESCE($2, 'external_company'), COALESCE($3, 'active'), $4)
       RETURNING *`,
      [
        input.name,
        input.type ?? null,
        input.status ?? null,
        input.metadata == null ? null : JSON.stringify(input.metadata),
      ],
    );
    return rows[0]!;
  }

  async update(id: string, patch: Partial<OrganizationInput>): Promise<OrganizationRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.type !== undefined) {
      sets.push(`type = $${i++}`);
      values.push(patch.type);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.metadata !== undefined) {
      sets.push(`metadata = $${i++}`);
      values.push(patch.metadata == null ? null : JSON.stringify(patch.metadata));
    }
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const { rows } = await db.query<OrganizationRow>(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  toApi(row: OrganizationRow) {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      metadata: row.metadata,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const organizationsRepo = new OrganizationsRepo();
