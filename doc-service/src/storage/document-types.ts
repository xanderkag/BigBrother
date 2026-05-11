import { db } from '../db.js';

/**
 * Document Type Registry — repository over the `document_types` table.
 *
 * The table is the future single source of truth for "how does the
 * service process a given document type". Today the runtime still
 * reads hardcoded values from src/types/documents.ts and friends —
 * this repo exists so the UI and admin API can surface the configured
 * state, and so next phases can swap runtime to read from DB without
 * another API redesign.
 *
 * Methods are read-only for the initial release; CRUD lands when the
 * editor UI ships.
 */

export type DocumentTypeRow = {
  slug: string;
  display_name: string;
  description: string | null;
  is_active: boolean;
  is_builtin: boolean;
  parser_kind: 'builtin:invoice_regex' | 'builtin:upd_regex' | 'llm_extract';
  llm_prompt: string | null;
  llm_schema: Record<string, unknown> | null;
  expected_fields: string[];
  validators: string[];
  confidence_threshold: string | null;        // NUMERIC → string
  regex_fallback_threshold: string | null;    // NUMERIC → string
  classification_keywords: string[];
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

class DocumentTypesRepo {
  /** All types, ordered by display_name. Used to populate admin lists. */
  async list(): Promise<DocumentTypeRow[]> {
    const { rows } = await db.query<DocumentTypeRow>(
      `SELECT * FROM document_types ORDER BY display_name`,
    );
    return rows;
  }

  /** Single type by slug. Returns `null` when missing — lets routes 404 cleanly. */
  async findBySlug(slug: string): Promise<DocumentTypeRow | null> {
    const { rows } = await db.query<DocumentTypeRow>(
      `SELECT * FROM document_types WHERE slug = $1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  /**
   * Public-API shape: dates → ISO strings, NUMERIC → number. Other
   * conversions (e.g. exposing only the active ones via list filters)
   * stay in the route handler so this stays a pure data layer.
   */
  toApi(row: DocumentTypeRow): Record<string, unknown> {
    return {
      slug: row.slug,
      display_name: row.display_name,
      description: row.description,
      is_active: row.is_active,
      is_builtin: row.is_builtin,
      parser_kind: row.parser_kind,
      llm_prompt: row.llm_prompt,
      llm_schema: row.llm_schema,
      expected_fields: row.expected_fields,
      validators: row.validators,
      confidence_threshold:
        row.confidence_threshold === null ? null : Number(row.confidence_threshold),
      regex_fallback_threshold:
        row.regex_fallback_threshold === null ? null : Number(row.regex_fallback_threshold),
      classification_keywords: row.classification_keywords,
      metadata: row.metadata,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const documentTypesRepo = new DocumentTypesRepo();
