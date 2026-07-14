/**
 * audit #3: валидация клиентского organization_id при создании job'а.
 *
 * Раньше `scopeOrgId = clientOrgId ?? project.organization_id` брал клиентский
 * organization_id дословно — caller с доступом только к проекту P мог записать
 * job в выбранную им орг Y (→ чужой webhook-routing / отравление SHA-кэша).
 *
 * Правила:
 *   - клиент не передал organization_id → ok (scope деривится дальше);
 *   - передан project → орг ОБЯЗАНА совпасть с project.organization_id (иначе 400);
 *   - без project → явный organization_id принимаем ТОЛЬКО от super_admin или
 *     члена этой орг (иначе 403).
 */
export interface OrgOverrideInput {
  /** organization_id из multipart-поля (или undefined). */
  clientOrgId: string | undefined;
  isSuperAdmin: boolean;
  /** organization_id вызывающего (пусто у super_admin/root). */
  userOrgId: string | null | undefined;
  /** organization_id проекта — задан ТОЛЬКО в ветке с project_id. */
  projectOrgId?: string;
}

export type OrgOverrideResult = { ok: true } | { ok: false; code: number; error: string };

export function checkOrgOverride(input: OrgOverrideInput): OrgOverrideResult {
  const { clientOrgId, isSuperAdmin, userOrgId, projectOrgId } = input;
  if (!clientOrgId) return { ok: true };

  if (projectOrgId !== undefined) {
    return clientOrgId === projectOrgId
      ? { ok: true }
      : { ok: false, code: 400, error: 'organization_id does not match project' };
  }

  return isSuperAdmin || userOrgId === clientOrgId
    ? { ok: true }
    : { ok: false, code: 403, error: 'not a member of the specified organization' };
}
