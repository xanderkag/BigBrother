import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { documentTypesRepo } from '../storage/document-types.js';
import { ErrorResponse } from '../types/api-schemas.js';
import { bearerAuthHook } from '../auth.js';

/**
 * Read-only API for the Document Type Registry.
 *
 * Today's purpose: surface the current configured state for the admin
 * UI. Tomorrow's: become the editing surface. Write methods are
 * deliberately omitted in this iteration — adding PUT/POST should be
 * a separate, audited change with role-checks and the runtime
 * actually reading from this table.
 *
 * Auth: same Bearer scheme as the rest of /api/v1/*. We don't have
 * roles yet, so any valid token can read; an `admin` role will gate
 * writes when we add them.
 */

const DocumentType = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  is_builtin: z.boolean(),
  parser_kind: z.enum(['builtin:invoice_regex', 'builtin:upd_regex', 'llm_extract']),
  llm_prompt: z.string().nullable(),
  llm_schema: z.record(z.unknown()).nullable(),
  expected_fields: z.array(z.string()),
  validators: z.array(z.string()),
  confidence_threshold: z.number().nullable(),
  regex_fallback_threshold: z.number().nullable(),
  classification_keywords: z.array(z.string()),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ListResponse = z.object({
  items: z.array(DocumentType),
});

const SlugParam = z.object({
  slug: z.string().min(1).max(64),
});

export async function documentTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('onRequest', bearerAuthHook);

  r.get(
    '/document-types',
    {
      schema: {
        tags: ['document-types'],
        summary: 'Список всех зарегистрированных типов документов',
        description:
          'Возвращает все document_types из БД (включая inactive). Для админ-UI. ' +
          'Runtime пока продолжает использовать захардкоженные значения в pipeline — это foundation-API.',
        security: [{ bearerAuth: [] }],
        response: {
          200: ListResponse,
          401: ErrorResponse,
        },
      },
    },
    async () => {
      const rows = await documentTypesRepo.list();
      return { items: rows.map((r) => documentTypesRepo.toApi(r)) };
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
      return documentTypesRepo.toApi(row);
    },
  );
}
