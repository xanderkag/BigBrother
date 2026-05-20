import { db } from '../db.js';

/**
 * Document Type Registry — repository over the `document_types` table.
 *
 * The table is the source of truth for "how does the service process a given
 * document type". Runtime читает её через `documentTypeResolver` (TTL-кэш
 * поверх этого репо); admin-UI CRUD'ит таблицу через PATCH/POST/DELETE и
 * каждый раз тригерит `documentTypeResolver.invalidate(slug)` чтобы изменения
 * подхватились без рестарта.
 *
 * Builtin-types (`is_builtin=true`) защищены от DELETE: их можно деактивировать,
 * можно переопределить любое поле, но удалять — нельзя, иначе классификатор и
 * валидация остаются без fallback'а.
 */

export type ParserKind =
  | 'builtin:invoice_regex'
  | 'builtin:upd_regex'
  | 'llm_extract'
  /**
   * Phase B: двухпроходный LLM extract для длинных документов (200+ позиций).
   * Pass 1 — header на head+tail текста; Pass 2 — items[] батчами по ~12KB.
   * Активируется явно админом или авто-режимом orchestrator'а при размере
   * OCR-текста > config.thresholds.multipassAutoBytes.
   */
  | 'llm_extract_multipass';

/**
 * Уровень зрелости (см. миграция 20260525000001):
 *   stable       — типизированная Zod-схема + regex parser + golden-set ≥90%.
 *                  6 builtin'ов: invoice/factInvoice/UPD/TTN/CMR/AKT.
 *   beta         — llm_extract only, keywords + validators настроены,
 *                  обкатан на ≥50 реальных доках, но без golden-set измерения.
 *   experimental — недавно создан, нет статистики, может ошибаться.
 *                  Default для нового типа.
 *
 * Поле информационное: runtime НЕ принимает решений на его основе,
 * только UI и логи показывают бейдж.
 */
export type DocumentTypeTier = 'stable' | 'beta' | 'experimental';

export type DocumentTypeRow = {
  slug: string;
  display_name: string;
  description: string | null;
  is_active: boolean;
  is_builtin: boolean;
  tier: DocumentTypeTier;
  parser_kind: ParserKind;
  llm_prompt: string | null;
  llm_schema: Record<string, unknown> | null;
  expected_fields: string[];
  validators: string[];
  confidence_threshold: string | null;        // NUMERIC → string
  regex_fallback_threshold: string | null;    // NUMERIC → string
  classification_keywords: string[];
  /**
   * Per-keyword weights, parallel array to classification_keywords (migration
   * 0023). weight[i] — вес keyword[i]. Higher = higher priority при разрешении
   * конфликтов между типами. NULL / пустой массив / shorter array → default
   * 1.0 для всех (или для missing indices).
   *
   * Стандартные значения:
   *   5.0 — very specific signature (e.g. "PRICE LIST №", "N RU Д-")
   *   3.0 — distinguishable phrase
   *   1.0 — default (generic)
   *   0.5–0.9 — explicit downgrade для generic patterns которые часто
   *             встречаются в других типах (e.g. "Country of origin"
   *             в commercial_invoice — присутствует и в прайс-листе)
   */
  classification_keyword_weights: string[] | null;  // numeric[] → string[]
  metadata: Record<string, unknown> | null;
  resolution_config: Record<string, unknown> | null;  // ResolutionConfig JSON
  created_at: Date;
  updated_at: Date;
};

/** Полный набор полей для create. `slug` обязателен и неизменяем. */
export type DocumentTypeCreateInput = {
  slug: string;
  display_name: string;
  description?: string | null;
  is_active?: boolean;
  tier?: DocumentTypeTier;
  parser_kind?: ParserKind;
  llm_prompt?: string | null;
  llm_schema?: Record<string, unknown> | null;
  expected_fields?: string[];
  validators?: string[];
  confidence_threshold?: number | null;
  regex_fallback_threshold?: number | null;
  classification_keywords?: string[];
  metadata?: Record<string, unknown> | null;
  /** Конфиг резолюционного пайплайна (entity_links + item_matching). */
  resolution_config?: Record<string, unknown> | null;
};

/** Partial update. Любое поле = `undefined` оставляет колонку как есть. `null` — обнуляет. */
export type DocumentTypePatch = Partial<Omit<DocumentTypeCreateInput, 'slug'>>;

class DocumentTypesRepo {
  /** All types, ordered by display_name. Used to populate admin lists. */
  async list(): Promise<DocumentTypeRow[]> {
    const { rows } = await db.query<DocumentTypeRow>(
      `SELECT * FROM document_types ORDER BY display_name`,
    );
    return rows;
  }

  /**
   * Active types only — для classifier'а и dropdown'ов выбора типа.
   * is_active=false скрыты из user-facing surface, но остаются в БД для
   * аудита и быстрого включения обратно.
   */
  async listActive(): Promise<DocumentTypeRow[]> {
    const { rows } = await db.query<DocumentTypeRow>(
      `SELECT * FROM document_types WHERE is_active = true ORDER BY display_name`,
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
   * Create a new user-defined type (is_builtin=false). Fails if slug already
   * exists. Callers should pre-check with findBySlug and return 409.
   */
  async create(input: DocumentTypeCreateInput): Promise<DocumentTypeRow> {
    const { rows } = await db.query<DocumentTypeRow>(
      `INSERT INTO document_types (
         slug, display_name, description, is_active, is_builtin, tier, parser_kind,
         llm_prompt, llm_schema, expected_fields, validators,
         confidence_threshold, regex_fallback_threshold, classification_keywords, metadata,
         resolution_config
       ) VALUES (
         $1, $2, $3, COALESCE($4, true), false, COALESCE($5, 'experimental'), COALESCE($6, 'llm_extract'),
         $7, $8, COALESCE($9, ARRAY[]::TEXT[]), COALESCE($10, ARRAY[]::TEXT[]),
         $11, $12, COALESCE($13, ARRAY[]::TEXT[]), $14,
         $15
       ) RETURNING *`,
      [
        input.slug,
        input.display_name,
        input.description ?? null,
        input.is_active ?? null,
        input.tier ?? null,
        input.parser_kind ?? null,
        input.llm_prompt ?? null,
        input.llm_schema ?? null,
        input.expected_fields ?? null,
        input.validators ?? null,
        input.confidence_threshold ?? null,
        input.regex_fallback_threshold ?? null,
        input.classification_keywords ?? null,
        input.metadata ?? null,
        input.resolution_config ?? null,
      ],
    );
    return rows[0]!;
  }

  /**
   * Partial update by slug. Returns null if the row doesn't exist.
   * Builtin rows can be edited (admin может поднастроить тюнинг под себя),
   * слово `is_builtin` саму не меняется через этот метод.
   */
  async patch(slug: string, patch: DocumentTypePatch): Promise<DocumentTypeRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const push = (col: string, value: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(value);
    };
    if (patch.display_name !== undefined) push('display_name', patch.display_name);
    if (patch.description !== undefined) push('description', patch.description);
    if (patch.is_active !== undefined) push('is_active', patch.is_active);
    if (patch.tier !== undefined) push('tier', patch.tier);
    if (patch.parser_kind !== undefined) push('parser_kind', patch.parser_kind);
    if (patch.llm_prompt !== undefined) push('llm_prompt', patch.llm_prompt);
    if (patch.llm_schema !== undefined) push('llm_schema', patch.llm_schema);
    if (patch.expected_fields !== undefined) push('expected_fields', patch.expected_fields);
    if (patch.validators !== undefined) push('validators', patch.validators);
    if (patch.confidence_threshold !== undefined)
      push('confidence_threshold', patch.confidence_threshold);
    if (patch.regex_fallback_threshold !== undefined)
      push('regex_fallback_threshold', patch.regex_fallback_threshold);
    if (patch.classification_keywords !== undefined)
      push('classification_keywords', patch.classification_keywords);
    if (patch.metadata !== undefined) push('metadata', patch.metadata);
    if (patch.resolution_config !== undefined) push('resolution_config', patch.resolution_config);
    if (sets.length === 0) return this.findBySlug(slug);

    values.push(slug);
    const { rows } = await db.query<DocumentTypeRow>(
      `UPDATE document_types SET ${sets.join(', ')} WHERE slug = $${i} RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  /**
   * Delete by slug. Returns the deleted row for audit, or null if missing.
   * Routes должны проверять is_builtin до вызова — этот метод не блокирует
   * builtin-удаление, чтобы тесты могли подчищать seed-данные.
   */
  async delete(slug: string): Promise<DocumentTypeRow | null> {
    const { rows } = await db.query<DocumentTypeRow>(
      `DELETE FROM document_types WHERE slug = $1 RETURNING *`,
      [slug],
    );
    return rows[0] ?? null;
  }

  /**
   * Public-API shape: dates → ISO strings, NUMERIC → number. Other
   * conversions (e.g. exposing only the active ones via list filters)
   * stay in the route handler so this stays a pure data layer.
   */
  toApi(row: DocumentTypeRow) {
    return {
      slug: row.slug,
      display_name: row.display_name,
      description: row.description,
      is_active: row.is_active,
      is_builtin: row.is_builtin,
      tier: row.tier,
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
      resolution_config: row.resolution_config,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const documentTypesRepo = new DocumentTypesRepo();
