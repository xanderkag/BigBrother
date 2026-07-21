import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { documentTypesRepo } from '../storage/document-types.js';
import { auditLogRepo } from '../storage/audit-log.js';
import { jobsRepo } from '../storage/jobs.js';
import { documentTypeResolver, resolveConfigFromRow } from '../pipeline/document-type-resolver.js';
import type { DocumentTypeSlug } from '../types/documents.js';
import { countSchemaLeafFields } from '../types/schema-field-count.js';
import { ErrorResponse, Job } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';
import { requireSuperAdmin, requireOrgAdmin, getEffectiveScope } from '../authz.js';

/**
 * Document Type Registry — admin CRUD.
 *
 * Read endpoints — surface the configured state for the admin UI dropdowns
 * and detail pages.
 *
 * Write endpoints (POST/PATCH/DELETE) — let the operator add custom document
 * types, retune prompts/schemas/thresholds, deactivate types that are no
 * longer needed. Every write:
 *   1. mutates the row in the DB,
 *   2. fires `documentTypeResolver.invalidate(slug)` so the next job picks
 *      up the new config without waiting for TTL,
 *   3. appends an `audit_log` entry with before/after snapshots.
 *
 * Builtin-protection: `is_builtin=true` rows can be edited (admins do tune
 * them), but never deleted via the API. Deactivate them instead.
 *
 * Auth: same Bearer scheme as the rest of /api/v1/*. There are no per-user
 * roles yet — any valid token can write. Future: gate writes on `admin` role.
 */

const ParserKind = z.enum([
  'builtin:invoice_regex',
  'builtin:upd_regex',
  'llm_extract',
  'llm_extract_multipass',
]);

/**
 * Зрелость типа документа (см. DocumentTypeTier в storage/document-types.ts).
 * Информационное поле — UI рисует бейдж, runtime не реагирует.
 */
const Tier = z.enum(['stable', 'beta', 'experimental']);

/**
 * Resolution config: формализованная Zod-схема для document_types.resolution_config.
 * См. полное описание + примеры — src/resolution/types.ts.
 *
 * Жёсткая валидация на write-ручках, чтобы админ не записал JSON «куда придётся»:
 * пустой массив `entity_links: []` валиден (просто нет привязок); `item_matching`
 * можно опустить целиком.
 */
const OnNotFoundSchema = z.enum(['needs_review', 'warn', 'ignore']);

const EntityLinkConfigSchema = z.object({
  list_type: z.string().min(1).max(64),
  match_fields: z.array(z.string().min(1).max(80)).min(1).max(16),
  on_not_found: OnNotFoundSchema.optional(),
});

const ItemMatchingConfigSchema = z.object({
  list_type: z.string().min(1).max(64),
  items_field: z.string().min(1).max(80),
  name_field: z.string().min(1).max(80).optional(),
  code_field: z.string().min(1).max(80).optional(),
  fuzzy_threshold: z.number().min(0).max(1).optional(),
  on_not_found: OnNotFoundSchema.optional(),
});

const ResolutionConfigSchema = z.object({
  entity_links: z.array(EntityLinkConfigSchema).max(32).optional(),
  item_matching: ItemMatchingConfigSchema.optional(),
});

const DocumentType = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  is_builtin: z.boolean(),
  tier: Tier,
  parser_kind: ParserKind,
  llm_prompt: z.string().nullable(),
  llm_schema: z.record(z.unknown()).nullable(),
  expected_fields: z.array(z.string()),
  validators: z.array(z.string()),
  confidence_threshold: z.number().nullable(),
  regex_fallback_threshold: z.number().nullable(),
  classification_keywords: z.array(z.string()),
  // Позиционные веса (параллельно keywords); read-only для клиента — при
  // PATCH keywords сервер пересобирает их сам по identity слова.
  classification_keyword_weights: z.array(z.number()).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  resolution_config: ResolutionConfigSchema.nullable(),
  // CP7: владелец типа. null = глобальный/builtin/shared. uuid = tenant-owned.
  organization_id: z.string().uuid().nullable(),
  // Hybrid-routing (SLAI #3): per-type принудительный vision-путь.
  prefer_vision: z.boolean(),
  // Число листовых полей ЭФФЕКТИВНОЙ схемы (БД llm_schema ?? код-fallback
  // резолвера). Именно его показывает колонка «Поля» в UI — сырой
  // expected_fields у типов со схемой-в-коде (BL/CMR/TTN) пуст и врал «0».
  extracted_fields_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ListResponse = z.object({
  items: z.array(DocumentType),
});

/**
 * toApi + счётчик полей по ЭФФЕКТИВНОЙ схеме. resolveConfigFromRow — чистая
 * функция (без запросов в БД), поэтому обогащение списка из 52 типов ничего
 * не стоит. Считать по сырому row.llm_schema нельзя: у BL/CMR/TTN он NULL,
 * боевая схема приходит из код-fallback'а (EXTENDED_SCHEMAS / builtin).
 */
function toApiWithFieldsCount(row: Parameters<typeof documentTypesRepo.toApi>[0]) {
  const resolved = resolveConfigFromRow(row.slug as DocumentTypeSlug, row);
  return {
    ...documentTypesRepo.toApi(row),
    extracted_fields_count: countSchemaLeafFields(resolved.llmSchema),
  };
}

/**
 * F2 (§8.2): эффективная схема полей типа для schema-driven редактора.
 * Возвращает JSON Schema, фактически используемую пайплайном (admin-override
 * из БД ?? встроенный fallback по slug'у), плюс список ожидаемых полей. Фронт
 * строит из неё форму ввода. `schema` может быть пустым `{}` для типов без
 * встроенной схемы и без override — тогда фронт деградирует в форму по
 * фактически распознанным полям.
 */
const SchemaResponse = z.object({
  slug: z.string(),
  schema: z.record(z.unknown()),
  expected_fields: z.array(z.string()),
  source: z.enum(['db', 'fallback']),
});

const SlugParam = z.object({
  slug: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: 'slug должен начинаться с буквы/цифры и содержать только [A-Za-z0-9_-]',
  }),
});

const Threshold = z.number().min(0).max(1).nullable();

// Поля, которые валидны в create. is_builtin не выставляется через API.
const CreateBody = z.object({
  slug: SlugParam.shape.slug,
  display_name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  is_active: z.boolean().optional(),
  tier: Tier.optional(),
  parser_kind: ParserKind.optional(),
  llm_prompt: z.string().max(8000).nullable().optional(),
  llm_schema: z.record(z.unknown()).nullable().optional(),
  expected_fields: z.array(z.string().min(1).max(80)).max(64).optional(),
  validators: z.array(z.string().min(1).max(120)).max(64).optional(),
  confidence_threshold: Threshold.optional(),
  regex_fallback_threshold: Threshold.optional(),
  classification_keywords: z.array(z.string().min(1).max(200)).max(64).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  resolution_config: ResolutionConfigSchema.nullable().optional(),
  // Hybrid-routing (SLAI #3): per-type принудительный vision-путь.
  prefer_vision: z.boolean().optional(),
  /**
   * CP7: владелец создаваемого типа.
   *   omitted / null ⇒ глобальный тип — только super_admin;
   *   <uuid>         ⇒ tenant-owned. org_admin может указать только свою орг
   *                    (route forces / rejects чужую). Builtin через create
   *                    не заводится (is_builtin всегда false в repo.create),
   *                    поэтому пара builtin+org здесь невозможна; DB CHECK
   *                    chk_builtin_is_global — backstop для прямых INSERT'ов.
   */
  organization_id: z.string().uuid().nullable().optional(),
});

// PATCH — все поля опциональные, slug нельзя менять (берётся из URL).
// organization_id переназначить через PATCH нельзя — владение фиксируется
// на create (omit ниже).
const PatchBody = CreateBody.omit({ slug: true, organization_id: true }).partial();

export async function documentTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  /**
   * CP7 mutate-guard для PATCH/DELETE по владельцу типа.
   *   ownerOrgId = null  ⇒ глобальный/builtin тип — super_admin only.
   *   ownerOrgId = uuid  ⇒ tenant-owned — super_admin или org_admin этой орг.
   * Возвращает true если доступ есть; иначе уже отправлен 401/403.
   */
  function canMutate(
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    ownerOrgId: string | null,
  ): boolean {
    if (ownerOrgId === null) return requireSuperAdmin(req, reply);
    return requireOrgAdmin(req, reply, ownerOrgId);
  }

  r.get(
    '/document-types',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Список зарегистрированных типов документов (scope-aware)',
        description:
          'Возвращает document_types видимые вызывающему (включая inactive). ' +
          'super_admin видит все типы всех орг; org_admin/manager — глобальные ' +
          '(organization_id IS NULL) ∪ типы своей организации. Для админ-UI.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ListResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      // CP7: scope. super_admin (kind='all') видит всё. org_admin (kind='org')
      // и обычные юзеры с организацией — globals ∪ своя орг. Юзер без орг и
      // без super → только globals.
      const scope = await getEffectiveScope(req);
      let rows;
      if (scope.kind === 'all') {
        rows = await documentTypesRepo.list();
      } else if (scope.kind === 'org') {
        rows = await documentTypesRepo.listForOrg(scope.orgId);
      } else {
        // kind='projects' (manager/viewer): тип-владение на уровне орг, не
        // проекта — берём organization_id юзера. Нет орг → globals-only.
        const orgId = req.user?.organization_id ?? null;
        // orgId=null → globals-only (listActiveForOrg(null)), не listActive()
        // которая org-unaware и слила бы чужие tenant-типы.
        rows = orgId
          ? await documentTypesRepo.listForOrg(orgId)
          : await documentTypesRepo.listActiveForOrg(null);
      }
      return { items: rows.map((r) => toApiWithFieldsCount(r)) };
    },
  );

  r.get(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Конфигурация конкретного типа документа',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: {
          200: DocumentType,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const row = await documentTypesRepo.findBySlug(req.params.slug);
      if (!row) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      return toApiWithFieldsCount(row);
    },
  );

  // F2 (§8.2): эффективная схема полей для schema-driven редактора в UI.
  // Любой авторизованный — это read-only справка о полях типа; права на саму
  // правку extracted проверяет PATCH /jobs/:id/extracted. Резолвер отдаёт
  // схему даже для builtin'ов с NULL llm_schema (встроенный fallback), чего
  // не делает обычный GET :slug (он возвращает сырую строку с llm_schema=null).
  r.get(
    '/document-types/:slug/schema',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Эффективная схема полей типа (для редактора extracted)',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: {
          200: SchemaResponse,
          401: ErrorResponse,
        },
      },
    },
    async (req) => {
      const resolved = await documentTypeResolver.resolveConfig(
        req.params.slug as DocumentTypeSlug,
      );
      return {
        slug: resolved.slug,
        schema: resolved.llmSchema ?? {},
        expected_fields: resolved.expectedFields,
        source: resolved.source,
      };
    },
  );

  r.post(
    '/document-types',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Создать новый тип документа',
        description:
          'Заводит пользовательский тип (is_builtin=false). slug должен быть уникален. ' +
          'После создания — инвалидируется resolver-кэш, пишется запись в audit_log.',
        security: [{ bearerAuth: [] }],
        body: CreateBody,
        response: {
          201: DocumentType,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      // CP7 authz:
      //   - super_admin: глобальный тип (organization_id null/omitted) ИЛИ
      //     тип для любой орг.
      //   - org_admin: только тип своей орг — глобальный создавать нельзя.
      //   - manager/viewer/no-org: запрещено.
      const user = req.user;
      if (!user) {
        reply.code(401);
        return { error: 'authentication required' };
      }
      const bodyOrg = req.body.organization_id ?? null;
      if (user.isSuperAdmin) {
        // любой scope ок
      } else if (user.role === 'org_admin' && user.organization_id) {
        if (bodyOrg === null) {
          reply.code(403);
          return { error: 'org_admin cannot create a global type (organization_id required)' };
        }
        // requireOrgAdmin отбивает чужую орг (даёт true только для своей).
        if (!requireOrgAdmin(req, reply, bodyOrg)) return reply;
      } else {
        reply.code(403);
        return { error: 'super_admin or org_admin role required' };
      }

      const existing = await documentTypesRepo.findBySlug(req.body.slug);
      if (existing) {
        reply.code(409);
        return { error: `document type "${req.body.slug}" already exists` };
      }
      const row = await documentTypesRepo.create({ ...req.body, organization_id: bodyOrg });
      const after = documentTypesRepo.toApi(row);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'document_type',
        entity_id: row.slug,
        action: 'create',
        after,
      });
      documentTypeResolver.invalidate(row.slug);
      reply.code(201);
      // Ответ несёт счётчик полей (схема DocumentType); в audit_log — сырой
      // снимок строки без вычисляемых полей.
      return toApiWithFieldsCount(row);
    },
  );

  r.patch(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Частичное обновление типа документа',
        description:
          'Любое поле = `undefined` оставляется как есть, явный `null` — обнуляет. ' +
          'Инвалидирует resolver-кэш, пишет audit_log.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        body: PatchBody,
        response: {
          200: DocumentType,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const before = await documentTypesRepo.findBySlug(req.params.slug);
      if (!before) {
        // 404 до authz: slug — публичный идентификатор, утечки нет.
        reply.code(404);
        return { error: 'document type not found' };
      }
      // CP7: tenant-owned тип может править super_admin или org_admin его орг.
      // Глобальный/builtin тип — super_admin only (как раньше).
      if (!canMutate(req, reply, before.organization_id)) return reply;
      // Веса keywords позиционные (weights[i] ↔ keywords[i]) и курируются
      // миграциями. Клиент их не шлёт; при изменении списка слов пересобираем
      // по identity слова: знакомое слово сохраняет свой вес, новое = 1.0.
      // Без этого удаление/перестановка строки в UI молча сдвигала вес на
      // соседнее слово (испорченный prior добивал до прод-классификации).
      const patchInput: Parameters<typeof documentTypesRepo.patch>[1] = { ...req.body };
      if (
        req.body.classification_keywords !== undefined &&
        (before.classification_keyword_weights?.length ?? 0) > 0
      ) {
        const weightByWord = new Map(
          before.classification_keywords.map((w, idx) => [
            w,
            Number(before.classification_keyword_weights![idx] ?? 1),
          ]),
        );
        patchInput.classification_keyword_weights = (req.body.classification_keywords ?? []).map(
          (w) => weightByWord.get(w) ?? 1.0,
        );
      }
      const updated = await documentTypesRepo.patch(req.params.slug, patchInput);
      if (!updated) {
        // race: row vanished between findBySlug and patch
        reply.code(404);
        return { error: 'document type not found' };
      }
      const beforeApi = documentTypesRepo.toApi(before);
      const afterApi = documentTypesRepo.toApi(updated);
      await auditLogRepo.append({
        actor: 'admin',
        entity: 'document_type',
        entity_id: updated.slug,
        action: 'update',
        before: beforeApi,
        after: afterApi,
      });
      documentTypeResolver.invalidate(updated.slug);
      return toApiWithFieldsCount(updated);
    },
  );

  r.delete(
    '/document-types/:slug',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Удалить тип документа',
        description:
          'Удаляет пользовательский тип. Builtin-типы (is_builtin=true) защищены — ' +
          'их следует деактивировать через PATCH { is_active: false }, а не удалять.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        response: {
          204: z.null(),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const row = await documentTypesRepo.findBySlug(req.params.slug);
      if (!row) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      // CP7: tenant-owned → super_admin или org_admin владеющей орг; глобальный
      // → super_admin only. (builtin всегда глобальный, отдельно отбивается ниже.)
      if (!canMutate(req, reply, row.organization_id)) return reply;
      if (row.is_builtin) {
        reply.code(403);
        return {
          error:
            'builtin types cannot be deleted; deactivate via PATCH { is_active: false } instead',
        };
      }
      const deleted = await documentTypesRepo.delete(req.params.slug);
      if (deleted) {
        await auditLogRepo.append({
          actor: 'admin',
          entity: 'document_type',
          entity_id: row.slug,
          action: 'delete',
          before: documentTypesRepo.toApi(row),
        });
        documentTypeResolver.invalidate(row.slug);
      }
      reply.code(204);
      return null;
    },
  );

  // --- Observation endpoints: realtime feedback на работу типа ---

  const RecentJobsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  const RecentJobsResponse = z.object({
    items: z.array(Job),
  });

  r.get(
    '/document-types/:slug/jobs',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Последние jobs этого типа документа',
        description:
          'Возвращает N последних jobs с `document_type=:slug`, по убыванию created_at. ' +
          'Используется страницей типа документа для отображения реальных примеров обработки.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: RecentJobsQuery,
        response: {
          200: RecentJobsResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const exists = await documentTypesRepo.findBySlug(req.params.slug);
      if (!exists) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      const rows = await jobsRepo.listByDocumentType(req.params.slug, req.query.limit);
      return { items: rows.map((r) => jobsRepo.toApi(r)) };
    },
  );

  const StatsQuery = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
  });

  const StatsResponse = z.object({
    slug: z.string(),
    period_days: z.number(),
    total_jobs: z.number(),
    terminal_breakdown: z.object({
      done: z.number(),
      needs_review: z.number(),
      failed: z.number(),
    }),
    avg_confidence: z.number().nullable(),
    expected_fields_coverage: z.array(
      z.object({
        field: z.string(),
        filled: z.number(),
        total: z.number(),
        filled_pct: z.number(),
      }),
    ),
  });

  // --- History endpoint: changelog из audit_log для конкретного типа ---

  const HistoryQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  const AuditDiffEntry = z.record(z.object({ from: z.unknown(), to: z.unknown() }));

  const AuditLogEntry = z.object({
    id: z.number(),
    at: z.string(),
    actor: z.string(),
    action: z.enum(['create', 'update', 'delete']),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()).nullable(),
    diff: AuditDiffEntry.nullable(),
  });

  const HistoryResponse = z.object({
    slug: z.string(),
    items: z.array(AuditLogEntry),
  });

  r.get(
    '/document-types/:slug/history',
    {
      schema: {
        tags: ['document-types'],
        summary: 'История изменений типа документа',
        description:
          'Возвращает записи audit_log для данного slug в порядке убывания времени. ' +
          'Каждая запись содержит `before`/`after` снимки конфига и `diff` ' +
          '(поля, изменённые данной правкой). Используется страницей типа документа ' +
          'для отображения changelog\'а — кто и что менял.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: HistoryQuery,
        response: {
          200: HistoryResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const exists = await documentTypesRepo.findBySlug(req.params.slug);
      if (!exists) {
        reply.code(404);
        return { error: 'document type not found' };
      }
      const rows = await auditLogRepo.list({
        entity: 'document_type',
        entity_id: req.params.slug,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return {
        slug: req.params.slug,
        items: rows.map((row) => auditLogRepo.toApi(row)),
      };
    },
  );

  r.get(
    '/document-types/:slug/stats',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Сводная статистика по типу: покрытие полей, doneness, avg confidence',
        description:
          'За последние N дней (по умолчанию 30) возвращает: сколько jobs обработано, ' +
          'раскладку по терминальным статусам, средний confidence терминальных, и ' +
          'для каждого `expected_field` — долю jobs где это поле фактически заполнено. ' +
          'Под выявление пробелов в parser/prompt — если `seller.inn` filled_pct=0.6, ' +
          'значит модель не справляется и нужно тюнить инструкцию или схему.',
        security: [{ bearerAuth: [] }],
        params: SlugParam,
        querystring: StatsQuery,
        response: {
          200: StatsResponse,
          401: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const type = await documentTypesRepo.findBySlug(req.params.slug);
      if (!type) {
        reply.code(404);
        return { error: 'document type not found' };
      }

      const days = req.query.days;
      // Покрытие считаем по ЭФФЕКТИВНОМУ списку полей (резолвер с
      // код-fallback'ом), а не по сырой колонке: у TTN/CMR (миграция
      // 20260604000001) колонка пуста, но runtime проверяет missing[] по
      // EXPECTED_FIELDS из кода — ручка мониторинга обязана мерить то же.
      const resolvedForStats = resolveConfigFromRow(
        req.params.slug as DocumentTypeSlug,
        type,
      );
      const [stats, coverage] = await Promise.all([
        jobsRepo.getTypeStats(req.params.slug, days),
        jobsRepo.getFieldCoverage(req.params.slug, resolvedForStats.expectedFields, days),
      ]);

      return {
        slug: req.params.slug,
        period_days: days,
        total_jobs: stats.total_jobs,
        terminal_breakdown: stats.terminal_breakdown,
        avg_confidence: stats.avg_confidence,
        expected_fields_coverage: coverage.map((c) => ({
          field: c.field,
          filled: c.filled,
          total: c.total,
          filled_pct: c.total === 0 ? 0 : Math.round((c.filled / c.total) * 100) / 100,
        })),
      };
    },
  );
}
