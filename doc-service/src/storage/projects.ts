import { db } from '../db.js';

/**
 * Projects — рабочее пространство внутри организации. Один и тот же
 * клиент может иметь несколько проектов под разные сценарии (отделы,
 * виды документооборота). Все jobs/документы привязаны к (org, project).
 *
 * `settings` JSONB резерв под будущие project-level настройки:
 * default_webhook_url, дефолтный document_type, retention policies, и т.п.
 */

export type ProjectStatus = 'active' | 'archived';

export type ProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type ProjectInput = {
  organization_id: string;
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  settings?: Record<string, unknown>;
};

class ProjectsRepo {
  async list(organizationId?: string): Promise<ProjectRow[]> {
    if (organizationId) {
      const { rows } = await db.query<ProjectRow>(
        `SELECT * FROM projects WHERE organization_id = $1 ORDER BY name`,
        [organizationId],
      );
      return rows;
    }
    const { rows } = await db.query<ProjectRow>(
      `SELECT * FROM projects ORDER BY organization_id, name`,
    );
    return rows;
  }

  async findById(id: string): Promise<ProjectRow | null> {
    const { rows } = await db.query<ProjectRow>(
      `SELECT * FROM projects WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async create(input: ProjectInput): Promise<ProjectRow> {
    const { rows } = await db.query<ProjectRow>(
      `INSERT INTO projects (organization_id, name, description, status, settings)
       VALUES ($1, $2, $3, COALESCE($4, 'active'), COALESCE($5::jsonb, '{}'::jsonb))
       RETURNING *`,
      [
        input.organization_id,
        input.name,
        input.description ?? null,
        input.status ?? null,
        input.settings ? JSON.stringify(input.settings) : null,
      ],
    );
    return rows[0]!;
  }

  async update(id: string, patch: Partial<ProjectInput>): Promise<ProjectRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push(`description = $${i++}`);
      values.push(patch.description);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.settings !== undefined) {
      sets.push(`settings = $${i++}::jsonb`);
      values.push(JSON.stringify(patch.settings));
    }
    if (sets.length === 0) return this.findById(id);
    values.push(id);
    const { rows } = await db.query<ProjectRow>(
      `UPDATE projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  toApi(row: ProjectRow) {
    return {
      id: row.id,
      organization_id: row.organization_id,
      name: row.name,
      description: row.description,
      status: row.status,
      settings: row.settings,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const projectsRepo = new ProjectsRepo();
