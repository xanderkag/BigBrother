/**
 * usersRepo.getDefaultProjectId — резолв default-проекта пользователя из
 * user_project_access. Мокаем `db` (без живой БД), проверяем:
 *   1. возвращает project_id первой строки (deterministic-first);
 *   2. SQL — scoped по user_id, ORDER BY created_at, project_id, LIMIT 1;
 *   3. null когда грантов нет.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const queryMock = vi.fn();

vi.mock('../src/db.js', () => ({
  db: { query: (...args: unknown[]) => queryMock(...args) },
}));

const { usersRepo } = await import('../src/storage/users.js');

describe('usersRepo.getDefaultProjectId', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('возвращает project_id первой строки', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ project_id: 'proj-A' }] });
    const result = await usersRepo.getDefaultProjectId('user-1');
    expect(result).toBe('proj-A');
  });

  it('scoped по user_id, ORDER BY created_at, project_id, LIMIT 1', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ project_id: 'proj-A' }] });
    await usersRepo.getDefaultProjectId('user-1');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('user_project_access');
    expect(sql).toContain('WHERE user_id = $1');
    expect(sql).toMatch(/ORDER BY\s+created_at,\s*project_id/);
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual(['user-1']);
  });

  it('null когда у пользователя нет грантов', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await usersRepo.getDefaultProjectId('user-no-access');
    expect(result).toBeNull();
  });
});
