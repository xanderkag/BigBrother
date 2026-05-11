import type { FastifyReply, FastifyRequest } from 'fastify';
import { usersRepo } from './storage/users.js';
import type { ProjectAccessRole } from './storage/users.js';

/**
 * Authorization guards для route handlers.
 *
 * Все функции возвращают `true` если доступ есть, и `false` если уже
 * отправлен 401/403 (reply.code(...).send(...) вызван). Caller прерывает
 * выполнение по false.
 *
 * Соглашение по ролям:
 *   - super_admin     — всё, везде.
 *   - org_admin       — всё в своей organization_id.
 *   - manager         — write/read в проектах из user_project_access (role=admin|manager).
 *   - viewer          — только read в проектах из user_project_access.
 *
 * Project-level роль: super_admin/org_admin = «admin» в любом проекте
 * своей орг. Обычные юзеры — по записям в user_project_access.
 */

/** Считается ли роль писательской (manager/admin), а не только viewer'ом? */
function isWriterRole(role: ProjectAccessRole): boolean {
  return role === 'admin' || role === 'manager';
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'authentication required' });
    return false;
  }
  return true;
}

export function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!requireAuth(req, reply)) return false;
  if (!req.user!.isSuperAdmin) {
    reply.code(403).send({ error: 'super_admin role required' });
    return false;
  }
  return true;
}

/** Доступ к организации (read). super_admin → всё. */
export async function requireOrgAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
): Promise<boolean> {
  if (!requireAuth(req, reply)) return false;
  const user = req.user!;
  if (user.isSuperAdmin) return true;
  if (!user.row) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  const accessibleOrgs = await usersRepo.getAccessibleOrgIds(user.row);
  if (accessibleOrgs === null) return true; // sentinel super_admin
  if (accessibleOrgs.has(organizationId)) return true;
  reply.code(403).send({ error: 'no access to this organization' });
  return false;
}

/** Write-доступ к организации — только super_admin или org_admin этой орг. */
export function requireOrgAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
): boolean {
  if (!requireAuth(req, reply)) return false;
  const user = req.user!;
  if (user.isSuperAdmin) return true;
  if (user.role === 'org_admin' && user.organization_id === organizationId) return true;
  reply.code(403).send({ error: 'org_admin of this organization required' });
  return false;
}

/** Read-доступ к проекту. */
export async function requireProjectAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): Promise<boolean> {
  if (!requireAuth(req, reply)) return false;
  const user = req.user!;
  if (user.isSuperAdmin) return true;
  if (!user.row) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  const role = await usersRepo.getProjectRole(user.row, projectId);
  if (role === null) {
    reply.code(403).send({ error: 'no access to this project' });
    return false;
  }
  return true;
}

/** Write-доступ к проекту (manager/admin, не viewer). */
export async function requireProjectWrite(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
): Promise<boolean> {
  if (!requireAuth(req, reply)) return false;
  const user = req.user!;
  if (user.isSuperAdmin) return true;
  if (!user.row) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  const role = await usersRepo.getProjectRole(user.row, projectId);
  if (role === null) {
    reply.code(403).send({ error: 'no access to this project' });
    return false;
  }
  if (!isWriterRole(role)) {
    reply.code(403).send({ error: 'write permission required (you are a viewer)' });
    return false;
  }
  return true;
}

/**
 * Утилита для GET /jobs и /audit-log — возвращает scope, по которому
 * нужно автоматически отфильтровать список (даже если клиент не дал
 * query-параметра).
 *
 * Возвращает:
 *   null — super_admin или org_admin без ограничения (см. `forceOrgFilter`);
 *   { projectIds } — белый список конкретных проектов;
 *   { orgId } — фильтровать по организации (для org_admin).
 *
 * Caller сам решает как применить — в SQL добавить IN (...) или
 * `organization_id = $X`. Для пустого набора возвращает
 * { projectIds: new Set() } — UI получит пустой список (не 403).
 */
export async function getEffectiveScope(
  req: FastifyRequest,
): Promise<
  | { kind: 'all' }
  | { kind: 'org'; orgId: string }
  | { kind: 'projects'; projectIds: Set<string> }
> {
  const user = req.user;
  if (!user || user.isSuperAdmin) return { kind: 'all' };
  if (user.role === 'org_admin' && user.organization_id) {
    return { kind: 'org', orgId: user.organization_id };
  }
  if (!user.row) return { kind: 'projects', projectIds: new Set() };
  const projectIds = await usersRepo.getAccessibleProjectIds(user.row);
  if (projectIds === null) return { kind: 'all' };
  return { kind: 'projects', projectIds };
}
