import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { organizationsRepo } from '../storage/organizations.js';
import { organizationSettingsRepo } from '../storage/organization-settings.js';
import { projectsRepo } from '../storage/projects.js';
import { usersRepo, type UserRow } from '../storage/users.js';
import { tokensRepo } from '../storage/tokens.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook, type AuthUser } from '../auth.js';
import {
  requireSuperAdmin,
  requireOrgAdmin,
  requireOrgAccess,
  getEffectiveScope,
} from '../authz.js';

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

// --- Organization settings (per-org consumer profile, CP7 фаза 2) ---

const ProcessingMode = z.enum(['extract', 'classify_only']);
const OutputMode = z.enum(['webhook', 'pull']);

/** http/https-only — повторяет isValidWebhookUrl из routes/jobs.ts. */
const webhookUrlSchema = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'webhook_url must be http(s) URL' },
  );

/** Response — БЕЗ raw-секрета, только `has_webhook_secret`. */
const OrganizationSettingsApi = z.object({
  organization_id: z.string().uuid().nullable(),
  mode: ProcessingMode,
  output: OutputMode,
  webhook_url: z.string().nullable(),
  has_webhook_secret: z.boolean(),
  auto_approve_threshold: z.number().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});

const OrganizationSettingsPatchBody = z.object({
  mode: ProcessingMode.optional(),
  output: OutputMode.optional(),
  webhook_url: webhookUrlSchema.nullable().optional(),
  // write-only: принимаем, но никогда не отдаём назад.
  webhook_hmac_secret: z.string().min(1).max(512).nullable().optional(),
  auto_approve_threshold: z.number().min(0).max(1).nullable().optional(),
});

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
    async (req) => {
      // Видимость организаций: super_admin → все; org_admin → только своя;
      // manager/viewer → объединение организаций из их проектов.
      const scope = await getEffectiveScope(req);
      const rows = await organizationsRepo.list();
      if (scope.kind === 'all') {
        return { items: rows.map((r) => organizationsRepo.toApi(r)) };
      }
      if (scope.kind === 'org') {
        return {
          items: rows
            .filter((r) => r.id === scope.orgId)
            .map((r) => organizationsRepo.toApi(r)),
        };
      }
      // projects-scope: достанем org_id из доступных проектов
      const allowedOrgIds = new Set<string>();
      if (scope.projectIds.size > 0) {
        const projs = await projectsRepo.list();
        for (const p of projs) {
          if (scope.projectIds.has(p.id)) allowedOrgIds.add(p.organization_id);
        }
      }
      return {
        items: rows.filter((r) => allowedOrgIds.has(r.id)).map((r) => organizationsRepo.toApi(r)),
      };
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
        response: { 201: OrganizationApi, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return reply;
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
        summary: 'Изменить организацию (super_admin или org_admin своей)',
        security: [{ bearerAuth: [] }],
        params: OrgIdParam,
        body: OrganizationPatch,
        response: { 200: OrganizationApi, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireOrgAdmin(req, reply, req.params.id)) return reply;
      const row = await organizationsRepo.update(req.params.id, req.body);
      if (!row) {
        reply.code(404);
        return { error: 'organization not found' };
      }
      return organizationsRepo.toApi(row);
    },
  );

  // --- Organization settings (per-org consumer profile) ---

  r.get(
    '/organizations/:id/settings',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Профиль организации (consumer settings)',
        description:
          'Возвращает per-org профиль (mode/output/webhook_url/auto_approve_threshold). ' +
          'Если строки нет — дефолты (extract/pull). Секрет не отдаётся — только has_webhook_secret. ' +
          'Доступ: super_admin или участник/админ этой орг.',
        security: [{ bearerAuth: [] }],
        params: OrgIdParam,
        response: {
          200: OrganizationSettingsApi,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!(await requireOrgAccess(req, reply, req.params.id))) return reply;
      const org = await organizationsRepo.findById(req.params.id);
      if (!org) {
        reply.code(404);
        return { error: 'organization not found' };
      }
      return organizationSettingsRepo.get(req.params.id);
    },
  );

  r.put(
    '/organizations/:id/settings',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Изменить профиль организации (super_admin или org_admin своей)',
        description:
          'Upsert профиля. webhook_hmac_secret — write-only (шифруется, никогда не эхо-ится). ' +
          'undefined оставляет секрет, null — очищает, строка — заменяет. ' +
          'Если output=webhook без webhook_url (ни в патче, ни уже сохранённого) → 400.',
        security: [{ bearerAuth: [] }],
        params: OrgIdParam,
        body: OrganizationSettingsPatchBody,
        response: {
          200: OrganizationSettingsApi,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!requireOrgAdmin(req, reply, req.params.id)) return reply;
      const org = await organizationsRepo.findById(req.params.id);
      if (!org) {
        reply.code(404);
        return { error: 'organization not found' };
      }
      // Guard: output=webhook требует webhook_url — в патче ИЛИ уже сохранённого.
      const current = await organizationSettingsRepo.get(req.params.id);
      const effectiveOutput = req.body.output ?? current.output;
      if (effectiveOutput === 'webhook') {
        const effectiveUrl =
          req.body.webhook_url !== undefined ? req.body.webhook_url : current.webhook_url;
        if (!effectiveUrl) {
          reply.code(400);
          return { error: "output='webhook' requires a webhook_url (in patch or already stored)" };
        }
      }
      return organizationSettingsRepo.upsert(req.params.id, req.body);
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
      const scope = await getEffectiveScope(req);
      let rows = await projectsRepo.list(req.query.organization_id);
      if (scope.kind === 'org') {
        rows = rows.filter((r) => r.organization_id === scope.orgId);
      } else if (scope.kind === 'projects') {
        rows = rows.filter((r) => scope.projectIds.has(r.id));
      }
      return { items: rows.map((r) => projectsRepo.toApi(r)) };
    },
  );

  r.post(
    '/projects',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать проект (super_admin или org_admin своей орг)',
        security: [{ bearerAuth: [] }],
        body: ProjectCreate,
        response: { 201: ProjectApi, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      if (!requireOrgAdmin(req, reply, req.body.organization_id)) return reply;
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
        response: { 200: ProjectApi, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      // org_admin своего org может править проект; super_admin — любой.
      const existing = await projectsRepo.findById(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'project not found' };
      }
      if (!requireOrgAdmin(req, reply, existing.organization_id)) return reply;
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
      const scope = await getEffectiveScope(req);
      let rows = await usersRepo.list(req.query.organization_id);
      if (scope.kind === 'org') {
        rows = rows.filter((r) => r.organization_id === scope.orgId);
      } else if (scope.kind === 'projects') {
        // manager/viewer не должен видеть юзеров вообще — это admin-функция
        rows = [];
      }
      return { items: rows.map((r) => usersRepo.toApi(r)) };
    },
  );

  /**
   * GET /users/me — текущий аутентифицированный пользователь.
   *
   * Используется UI для:
   *   - показа имени в шапке
   *   - gating'а админ-features (страница «Тестовая лаборатория», editor
   *     document_types, etc.) — фронту нужно знать `role`, чтобы не показывать
   *     ссылки которые backend всё равно завернёт 403'й.
   *
   * Для API_KEY root-токена возвращает виртуального super_admin без id (id='system').
   */
  r.get(
    '/users/me',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Текущий аутентифицированный пользователь',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            id: z.string(),
            role: z.string(),
            organization_id: z.string().uuid().nullable(),
            is_super_admin: z.boolean(),
          }),
          401: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) { reply.code(401); return { error: 'auth required' }; }
      return {
        id: user.id,
        role: user.role,
        organization_id: user.organization_id,
        is_super_admin: user.isSuperAdmin,
      };
    },
  );

  r.post(
    '/users',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать пользователя (super_admin или org_admin)',
        description:
          'super_admin может создать кого угодно. org_admin может создать только пользователя своей организации (с ролью не выше org_admin).',
        security: [{ bearerAuth: [] }],
        body: UserCreate,
        response: { 201: UserApi, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) {
        reply.code(401);
        return { error: 'auth required' };
      }
      // super_admin → всё. org_admin → только своя орг + роль не super_admin.
      if (!user.isSuperAdmin) {
        if (user.role !== 'org_admin' || user.organization_id !== req.body.organization_id) {
          reply.code(403);
          return { error: 'org_admin of target organization required' };
        }
        if (req.body.role === 'super_admin') {
          reply.code(403);
          return { error: 'cannot create super_admin' };
        }
      }
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
        response: { 200: UserApi, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const existing = await usersRepo.findById(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'user not found' };
      }
      const user = req.user;
      if (!user) {
        reply.code(401);
        return { error: 'auth required' };
      }
      // super_admin меняет всех. org_admin — только своих юзеров.
      if (!user.isSuperAdmin) {
        if (user.role !== 'org_admin' || existing.organization_id !== user.organization_id) {
          reply.code(403);
          return { error: 'cannot edit user of another organization' };
        }
      }
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

  // --- Personal access tokens ---
  //
  // Две модели сосуществуют:
  //   1. Legacy (`users.api_token_hash`) — один токен на юзера, без подписи.
  //      POST /users/:id/token / DELETE /users/:id/token. Сохранены ради
  //      backward-compat с уже выданными токенами.
  //   2. Multi-token (`personal_access_tokens`) — N токенов на юзера, с
  //      `name` и опциональным `expires_at`. GET/POST /users/:id/tokens
  //      + DELETE /tokens/:tokenId.

  const TokenRegenerateResponse = z.object({
    plaintext: z.string().describe('Plaintext-токен. Виден ровно один раз — сохраните его.'),
    user_id: z.string().uuid(),
  });

  const TokenApi = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    name: z.string(),
    expires_at: z.string().nullable(),
    is_expired: z.boolean(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  });
  const TokenCreateBody = z.object({
    name: z.string().min(1).max(80).regex(/^[A-Za-z0-9 ._-]+$/, {
      message: 'name: 1-80 символов, только [A-Za-z0-9 ._-]',
    }),
    expires_at: z.string().datetime().nullable().optional(),
  });
  const TokenCreateResponse = z.object({
    token: TokenApi,
    plaintext: z.string(),
  });
  const TokenListResponse = z.object({ items: z.array(TokenApi) });
  const TokenIdParam = z.object({ id: z.string().uuid() });

  /** Проверка права выдавать/смотреть/отзывать токены: super_admin кому
   *  угодно, org_admin своим юзерам, обычный — себе. */
  const canManageUserTokens = (me: AuthUser | undefined, target: UserRow): boolean => {
    if (!me) return false;
    if (me.isSuperAdmin) return true;
    if (me.role === 'org_admin' && target.organization_id === me.organization_id) return true;
    return me.id === target.id;
  };

  r.post(
    '/users/:id/token',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Сгенерировать или ротировать personal access token',
        description:
          'Возвращает plaintext-токен ровно ОДИН РАЗ. После ответа сервер хранит только sha-256 хэш. ' +
          'Если у юзера уже был токен — он автоматически инвалидируется. Использовать так: ' +
          '`Authorization: Bearer pdpat_...` в API-запросах.',
        security: [{ bearerAuth: [] }],
        params: UserIdParam,
        response: {
          200: TokenRegenerateResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const existing = await usersRepo.findById(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'user not found' };
      }
      const me = req.user;
      if (!me) {
        reply.code(401);
        return { error: 'auth required' };
      }
      // Право выдать токен: super_admin кому угодно; org_admin — своим
      // юзерам; обычный юзер — только себе.
      const canIssue =
        me.isSuperAdmin ||
        (me.role === 'org_admin' && existing.organization_id === me.organization_id) ||
        me.id === existing.id;
      if (!canIssue) {
        reply.code(403);
        return { error: 'cannot issue token for this user' };
      }
      const result = await usersRepo.regenerateToken(req.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'user not found' };
      }
      return { plaintext: result.plaintext, user_id: result.user.id };
    },
  );

  r.delete(
    '/users/:id/token',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Отозвать personal access token (если был)',
        security: [{ bearerAuth: [] }],
        params: UserIdParam,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const existing = await usersRepo.findById(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'user not found' };
      }
      const me = req.user;
      if (!me) {
        reply.code(401);
        return { error: 'auth required' };
      }
      const canRevoke =
        me.isSuperAdmin ||
        (me.role === 'org_admin' && existing.organization_id === me.organization_id) ||
        me.id === existing.id;
      if (!canRevoke) {
        reply.code(403);
        return { error: 'cannot revoke token for this user' };
      }
      await usersRepo.clearToken(req.params.id);
      reply.code(204);
      return null;
    },
  );

  // --- Multi-token API: список / создание / отзыв с label + expiry ---

  r.get(
    '/users/:id/tokens',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Список personal access tokens пользователя',
        security: [{ bearerAuth: [] }],
        params: UserIdParam,
        response: { 200: TokenListResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const target = await usersRepo.findById(req.params.id);
      if (!target) {
        reply.code(404);
        return { error: 'user not found' };
      }
      if (!canManageUserTokens(req.user, target)) {
        reply.code(403);
        return { error: 'cannot view tokens for this user' };
      }
      const rows = await tokensRepo.listByUser(req.params.id);
      return { items: rows.map((r) => tokensRepo.toApi(r)) };
    },
  );

  r.post(
    '/users/:id/tokens',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Создать новый personal access token (с подписью и опц. сроком)',
        description:
          'Создаёт токен с заданным `name` (уникальный в пределах юзера) и ' +
          'опциональным `expires_at` (ISO datetime; NULL = бессрочный). ' +
          'Plaintext возвращается ОДИН РАЗ — сохраните его сейчас.',
        security: [{ bearerAuth: [] }],
        params: UserIdParam,
        body: TokenCreateBody,
        response: {
          201: TokenCreateResponse,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const target = await usersRepo.findById(req.params.id);
      if (!target) {
        reply.code(404);
        return { error: 'user not found' };
      }
      if (!canManageUserTokens(req.user, target)) {
        reply.code(403);
        return { error: 'cannot create tokens for this user' };
      }
      const expiresAt = req.body.expires_at ? new Date(req.body.expires_at) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        reply.code(400);
        return { error: 'expires_at must be in the future' };
      }
      try {
        const { plaintext, row } = await tokensRepo.create({
          user_id: req.params.id,
          name: req.body.name,
          expires_at: expiresAt,
        });
        reply.code(201);
        return { token: tokensRepo.toApi(row), plaintext };
      } catch (err) {
        // UNIQUE (user_id, name) — дубль имени.
        if (err instanceof Error && /unique/i.test(err.message)) {
          reply.code(409);
          return { error: `token with name "${req.body.name}" already exists for this user` };
        }
        throw err;
      }
    },
  );

  r.delete(
    '/tokens/:id',
    {
      schema: {
        tags: ['tenants'],
        summary: 'Отозвать конкретный токен по id',
        security: [{ bearerAuth: [] }],
        params: TokenIdParam,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      const tokenRow = await tokensRepo.findById(req.params.id);
      if (!tokenRow) {
        reply.code(404);
        return { error: 'token not found' };
      }
      const owner = await usersRepo.findById(tokenRow.user_id);
      if (!owner) {
        reply.code(404);
        return { error: 'token owner not found' };
      }
      if (!canManageUserTokens(req.user, owner)) {
        reply.code(403);
        return { error: 'cannot revoke this token' };
      }
      await tokensRepo.revoke(req.params.id);
      reply.code(204);
      return null;
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
