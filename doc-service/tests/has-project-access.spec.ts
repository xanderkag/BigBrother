/**
 * audit #1: hasProjectAccess — не-бросающая проверка доступа к проекту.
 * Покрываем ветки, не требующие БД (super_admin bypass + deny без auth).
 * Ветка getProjectRole (обычный пользователь) — интеграционно.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { hasProjectAccess } from '../src/authz.js';

const asReq = (user: unknown) => ({ user }) as unknown as FastifyRequest;

describe('hasProjectAccess', () => {
  it('нет user → false (deny)', async () => {
    expect(await hasProjectAccess(asReq(undefined), 'p1')).toBe(false);
  });
  it('super_admin → true (доступ ко всему)', async () => {
    expect(await hasProjectAccess(asReq({ isSuperAdmin: true }), 'p1')).toBe(true);
  });
  it('пользователь без row → false', async () => {
    expect(await hasProjectAccess(asReq({ isSuperAdmin: false, row: null }), 'p1')).toBe(false);
  });
});
