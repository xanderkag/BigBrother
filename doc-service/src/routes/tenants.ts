import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { organizationsRepo } from '../storage/organizations.js';
import { projectsRepo } from '../storage/projects.js';
import { usersRepo } from '../storage/users.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';

/**
 * Multi-tenant API: organizations / projects / users / access.
 *
 * В этой фазе:
 *   - Все endpoint'ы открыты для аутентифицированного запроса (= super_admin).
 *   - Role-based фильтрация (org_admin видит только свою org, manager —
 *     только свои проекты) заложена в моделях, но enforce'ится отдельной
 *     волной — нужен реальный per-user auth сперва.
 *
 * Endpoints:
 *   GET    /organizations              — список всех орг
 *   POST   /organizations              — создать орг
 *   PUT    /organizations/:id          — изменить
 *
 *   GET    /projects?organization_id=  — список проектов (опц. фильтр)
 *   POST   /projects                   — создать
 *   PUT    /projects/:id               — изменить
 *
 *   GET    /users?organization_id=     — список пользователей
 *   POST   /users                      — создать
 *   PUT    /users/:id                  — изменить
 *
 *   GET    /users/access?user_id=&project_id=  — список доступов
 *   POST   /users/access               — выдать доступ (user×project, role)
 *   DELETE /users/access?user_id=&project_id=  — отозвать
 */

// --- Schemas ---

const OrgType = z.enum(['internal_division', 'external_company', 'test', 'system']);
const OrgStatus = z.enum(['active', 'archived']);
const ProjectStatus = z.enum(['active', 'archived']);
const UserRole = z.enum(['super_admin', 'org_admin', 'manager', 'viewer']);
const UserStatus = z.enum(['active', 'blocked']);
const ProjectAccessRole = z.enum(['admin', 'manager', 'viewer']);

const OrganizationApi = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: OrgType,
  status: OrgStatus,
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const OrganizationListResponse = z.object({ items: z.array(OrganizationApi) });
const OrganizationCreate = z.object({
  name: z.string().min(1).max(200),
  type: OrgType.optional(),
  status: OrgStatus.optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
const OrganizationPatch = OrganizationCreate.partial();
const OrgIdParam = z.object({ id: z.string().uuid() });

const ProjectApi = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatus,
  settings: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
const ProjectListResponse = z.object({ items: z.array(ProjectApi) });
const ProjectListQuery = z.object({
  organization_id: z.string().uuid().optional(),
});
const ProjectCreate = z.object({
  organization_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  status: ProjectStatus.optional(),
  settings: z.record(z.unknown()).optional(),
});
const ProjectPatch = ProjectCreate.omit({ organization_id: true }).partial();
const ProjectIdParam = z.object({ id: z.string().uuid() });

const UserApi = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  display_name: z.string(),
  organization_id: z.string().uuid().nullable(),
  role: UserRole,
  status: UserStatus,
  has_api_token: z.boolean(),
  last_seen_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const UserListResponse = z.object({ items: z.array(UserApi) });
const UserListQuery = z.object({
  organization_id: z.string().uuid().optional(),
});
const UserCreate = z.object({
  email: z.string().email().optional(),
  display_name: z.string().min(1).max(200),
  organization_id: z.string().uuid().nullable().optional(),
  role: UserRole.optional(),
  status: UserStatus.optional(),
});
const UserPatch = UserCreate.partial();
const UserIdParam = z.object({ id: z.string().uuid() });

const AccessApi = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  role: ProjectAccessRole,
  created_at: z.string(),
});
const AccessListResponse = z.object({ items: z.array(AccessApi) });
const AccessListQuery = z.object({
  user_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
});
const AccessGrant = z.object({
  user_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  role: ProjectAccessRole.default('manager'),
});
const AccessRevokeQuery = z.object({
  user_id: z.string().uuid(),
  project_id: z.string().uuid(),
});

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  // --- Organizations ---
  r.get(
    '/organizations',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Список организаций',
        description:
          'Для super_admin — все организации. Для org_admin — только своя (но enforce ролей пока не включен; см. TECH_DEBT).',
        security: [{ bearerAuth: [] }],
        response: { 200: OrganizationListResponse, 401: ErrorResponse },
      },
    },
    async () => {
      const rows = await organizationsRepo.list();
      return { items: rows.map((r) => organizationsRepo.toApi(r)) };
    },
  );

  r.post(
    '/organizations',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать организацию (только super_admin)',
        security: [{ bearerAuth: [] }],
        body: OrganizationCreate,
        response: { 201: OrganizationApi, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await organizationsRepo.create(req.body);
      reply.code(201);
      return organizationsRepo.toApi(row);
    },
  );

  r.put(
    '/organizations/:id',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Изменить организацию',
        security: [{ bearerAuth: [] }],
        params: OrgIdParam,
        body: OrganizationPatch,
        response: { 200: OrganizationApi, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await organizationsRepo.update(req.params.id, req.body);
      if (!row) {
        reply.code(404);
        return { error: 'organization not found' };
      }
      return organizationsRepo.toApi(row);
    },
  );

  // --- Projects ---
  r.get(
    '/projects',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Список проектов (фильтр по organization_id опционален)',
        security: [{ bearerAuth: [] }],
        querystring: ProjectListQuery,
        response: { 200: ProjectListResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      const rows = await projectsRepo.list(req.query.organization_id);
      return { items: rows.map((r) => projectsRepo.toApi(r)) };
    },
  );

  r.post(
    '/projects',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать проект',
        security: [{ bearerAuth: [] }],
        body: ProjectCreate,
        response: { 201: ProjectApi, 400: ErrorResponse, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      // Проверяем что org существует — иначе FK-error будет невнятный.
      const org = await organizationsRepo.findById(req.body.organization_id);
      if (!org) {
        reply.code(400);
        return { error: 'organization_id refers to non-existent organization' };
      }
      const row = await projectsRepo.create(req.body);
      reply.code(201);
      return projectsRepo.toApi(row);
    },
  );

  r.put(
    '/projects/:id',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Изменить проект',
        security: [{ bearerAuth: [] }],
        params: ProjectIdParam,
        body: ProjectPatch,
        response: { 200: ProjectApi, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await projectsRepo.update(req.params.id, req.body);
      if (!row) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return projectsRepo.toApi(row);
    },
  );

  // --- Users ---
  r.get(
    '/users',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Список пользователей',
        security: [{ bearerAuth: [] }],
        querystring: UserListQuery,
        response: { 200: UserListResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      const rows = await usersRepo.list(req.query.organization_id);
      return { items: rows.map((r) => usersRepo.toApi(r)) };
    },
  );

  r.post(
    '/users',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать пользователя',
        description:
          'Создаёт пользователя в БД. Per-user-токены не выдаются автоматически в этой фазе — единый Bearer API_KEY всё ещё маппится в системного super_admin. Поле api_token_hash готово к будущей реализации personal access tokens.',
        security: [{ bearerAuth: [] }],
        body: UserCreate,
        response: { 201: UserApi, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await usersRepo.create(req.body);
      reply.code(201);
      return usersRepo.toApi(row);
    },
  );

  r.put(
    '/users/:id',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Изменить пользователя',
        security: [{ bearerAuth: [] }],
        params: UserIdParam,
        body: UserPatch,
        response: { 200: UserApi, 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await usersRepo.update(req.params.id, req.body);
      if (!row) {
        reply.code(404);
        return { error: 'user not found' };
      }
      return usersRepo.toApi(row);
    },
  );

  // --- Access (user × project) ---
  r.get(
    '/users/access',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Список доступов user × project',
        security: [{ bearerAuth: [] }],
        querystring: AccessListQuery,
        response: { 200: AccessListResponse, 401: ErrorResponse },
      },
    },
    async (req) => {
      const rows = await usersRepo.listAccess({
        userId: req.query.user_id,
        projectId: req.query.project_id,
      });
      return { items: rows.map((r) => usersRepo.toAccessApi(r)) };
    },
  );

  r.post(
    '/users/access',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Выдать пользователю доступ к проекту',
        description:
          'Upsert по (user_id, project_id). Меняет роль если грант уже существовал.',
        security: [{ bearerAuth: [] }],
        body: AccessGrant,
        response: { 201: AccessApi, 401: ErrorResponse },
      },
    },
    async (req, reply) => {
      const row = await usersRepo.grantAccess(req.body);
      reply.code(201);
      return usersRepo.toAccessApi(row);
    },
  );

  r.delete(
    '/users/access',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Отозвать доступ',
        security: [{ bearerAuth: [] }],
        querystring: AccessRevokeQuery,
        response: { 204: z.null(), 401: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const ok = await usersRepo.revokeAccess(req.query.user_id, req.query.project_id);
      if (!ok) {
        reply.code(404);
        return { error: 'access record not found' };
      }
      reply.code(204);
      return null;
    },
  );
}
