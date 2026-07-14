/**
 * audit #3: валидация клиентского organization_id при создании job'а.
 */
import { describe, expect, it } from 'vitest';
import { checkOrgOverride } from '../src/routes/tenant-scope.js';

describe('checkOrgOverride', () => {
  it('нет clientOrgId → ok (scope деривится дальше)', () => {
    expect(checkOrgOverride({ clientOrgId: undefined, isSuperAdmin: false, userOrgId: 'X' })).toEqual({ ok: true });
  });

  describe('ветка с project (орг определяется проектом)', () => {
    it('совпадает с орг проекта → ok', () => {
      expect(
        checkOrgOverride({ clientOrgId: 'X', isSuperAdmin: false, userOrgId: 'X', projectOrgId: 'X' }),
      ).toEqual({ ok: true });
    });
    it('противоречит орг проекта → 400', () => {
      expect(
        checkOrgOverride({ clientOrgId: 'Y', isSuperAdmin: false, userOrgId: 'Y', projectOrgId: 'X' }),
      ).toEqual({ ok: false, code: 400, error: 'organization_id does not match project' });
    });
    it('даже super_admin не может противоречить орг проекта → 400', () => {
      expect(
        checkOrgOverride({ clientOrgId: 'Y', isSuperAdmin: true, userOrgId: null, projectOrgId: 'X' }),
      ).toEqual({ ok: false, code: 400, error: 'organization_id does not match project' });
    });
  });

  describe('ветка без project (явный org)', () => {
    it('super_admin → любая орг ok', () => {
      expect(checkOrgOverride({ clientOrgId: 'Y', isSuperAdmin: true, userOrgId: null })).toEqual({ ok: true });
    });
    it('член орг (userOrgId === clientOrgId) → ok', () => {
      expect(checkOrgOverride({ clientOrgId: 'X', isSuperAdmin: false, userOrgId: 'X' })).toEqual({ ok: true });
    });
    it('НЕ член чужой орг → 403', () => {
      expect(checkOrgOverride({ clientOrgId: 'Y', isSuperAdmin: false, userOrgId: 'X' })).toEqual({
        ok: false,
        code: 403,
        error: 'not a member of the specified organization',
      });
    });
    it('tenant без своей орг подаёт чужую → 403', () => {
      expect(checkOrgOverride({ clientOrgId: 'Y', isSuperAdmin: false, userOrgId: null })).toEqual({
        ok: false,
        code: 403,
        error: 'not a member of the specified organization',
      });
    });
  });
});
