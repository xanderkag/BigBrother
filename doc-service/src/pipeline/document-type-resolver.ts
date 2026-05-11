/**
 * DocumentTypeResolver — кэширующий слой над `documentTypesRepo`.
 *
 * Цель: позволить hot-path коду (pipeline/validation, parsers,
 * classifier) обращаться к конфигурации типов документов **синхронно
 * по идее, но асинхронно по интерфейсу** — без каждого раза DB
 * round-trip. Resolver хранит per-slug кэш с TTL, и предоставляет
 * хук инвалидации для CP4 (когда appear PUT/POST handlers).
 *
 * Сейчас resolver используется только валидацией. Парсеры, классификатор
 * и пороги — следующие миграции в CP1.
 *
 * Поведение при пустой БД: если slug не найден, возвращается `null`.
 * Вызывающий код тогда падает в hardcoded fallback (см. validation/index.ts).
 */

import { config } from '../config.js';
import { documentTypesRepo, type DocumentTypeRow } from '../storage/document-types.js';
import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../types/document-json-schemas.js';
import type { DocumentTypeSlug } from '../types/documents.js';

const DEFAULT_TTL_MS = 60_000;

/**
 * Snapshot of "everything the runtime needs to process a job of this
 * document type". Resolves DB-supplied values where present and falls
 * back to env/hardcoded defaults where not. The runtime never sees the
 * raw `DocumentTypeRow` — only this normalised view, which simplifies
 * downstream consumers (they don't deal with null thresholds, missing
 * schemas, etc.).
 */
export type ResolvedTypeConfig = {
  slug: DocumentTypeSlug;
  /** Effective needs-review threshold for the combined OCR + parser confidence. */
  confidenceThreshold: number;
  /** Below this regex confidence, Phase 1 parsers fall through to the LLM. */
  regexFallbackThreshold: number;
  /** Field names the parser is expected to populate; used for `missing[]`. */
  expectedFields: string[];
  /** Validator specs run after extraction. Empty array → no domain checks. */
  validators: string[];
  /** JSON Schema sent to LLM /v1/extract. Defaults to builtin per type. */
  llmSchema: Record<string, unknown>;
  /** Whether this config was DB-sourced or fully built from fallbacks. */
  source: 'db' | 'fallback';
};

export class DocumentTypeResolver {
  private cache = new Map<string, { row: DocumentTypeRow | null; at: number }>();
  /** Кэш для listActive() — отдельный, потому что инвалидируется широко (любой write). */
  private listCache: { rows: DocumentTypeRow[]; at: number } | null = null;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Список всех активных типов (для classifier'а и UI dropdown'ов). Один
   * DB round-trip на ttl; при любом CRUD-write на document_types вызовите
   * `invalidate()` без аргумента — это сбросит и список, и per-slug кэш.
   */
  async listActive(): Promise<DocumentTypeRow[]> {
    if (this.listCache && Date.now() - this.listCache.at < this.ttlMs) {
      return this.listCache.rows;
    }
    let rows: DocumentTypeRow[];
    try {
      rows = await documentTypesRepo.listActive();
    } catch {
      // DB hiccup — не отравляем кэш. Возвращаем пустой список, классификатор
      // деградирует к hardcoded fallback'у.
      return [];
    }
    this.listCache = { rows, at: Date.now() };
    return rows;
  }

  /**
   * Get the config for a slug. Returns `null` (cached) when the slug
   * doesn't exist in the registry — caller is expected to fall back.
   * Cache-misses make one DB call; subsequent reads in the TTL window
   * are in-memory.
   */
  async get(slug: string): Promise<DocumentTypeRow | null> {
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.row;
    }
    let row: DocumentTypeRow | null;
    try {
      row = await documentTypesRepo.findBySlug(slug);
    } catch {
      // DB hiccup — don't poison the cache, just say "no entry" for now
      // so the caller falls back to hardcoded behaviour. We can revisit
      // if this masks real DB outages in production.
      return null;
    }
    this.cache.set(slug, { row, at: Date.now() });
    return row;
  }

  /**
   * Drop a single slug or the entire cache. Called by PUT/POST/DELETE
   * handlers in document-types route so admins see their edits reflected
   * immediately, not at next TTL boundary. Also clears the listActive()
   * cache — состав активных типов мог поменяться.
   */
  invalidate(slug?: string): void {
    if (slug === undefined) this.cache.clear();
    else this.cache.delete(slug);
    this.listCache = null;
  }

  /**
   * Resolve the runtime-facing config for a slug. Always returns a
   * fully-populated `ResolvedTypeConfig` — caller doesn't have to
   * handle null thresholds or missing schemas. `source` tells the
   * caller whether the values came from DB (admin can change them)
   * or from fallback (need to seed the DB).
   */
  async resolveConfig(slug: DocumentTypeSlug): Promise<ResolvedTypeConfig> {
    const row = await this.get(slug);
    return resolveConfigFromRow(slug, row);
  }
}

/** Process-wide singleton used by the pipeline. */
export const documentTypeResolver = new DocumentTypeResolver();

/**
 * Pure builder: given a slug and optional row, fold in env/hardcoded
 * defaults. Extracted so tests can exercise the fallback logic without
 * the cache/db plumbing.
 */
export function resolveConfigFromRow(
  slug: DocumentTypeSlug,
  row: DocumentTypeRow | null,
): ResolvedTypeConfig {
  // Hardcoded fallback'и есть только для шести builtin-slug'ов. Для
  // пользовательских типов индексация вернёт undefined — ловим через
  // `??` и подсовываем пустые дефолты. Custom-type без row в БД =
  // ничего не парсим (вряд ли осмысленный кейс, но не падаем).
  const schemas = DOCUMENT_JSON_SCHEMAS as Record<string, Record<string, unknown> | undefined>;
  const fields = EXPECTED_FIELDS as Record<string, string[] | undefined>;
  const fallbackSchema = schemas[slug] ?? {};
  const fallbackFields = fields[slug] ?? [];

  if (!row) {
    return {
      slug,
      confidenceThreshold: config.thresholds.needsReview,
      regexFallbackThreshold: config.thresholds.regexFallback,
      expectedFields: [...fallbackFields],
      validators: [],
      llmSchema: fallbackSchema as Record<string, unknown>,
      source: 'fallback',
    };
  }

  return {
    slug,
    confidenceThreshold:
      row.confidence_threshold === null
        ? config.thresholds.needsReview
        : Number(row.confidence_threshold),
    regexFallbackThreshold:
      row.regex_fallback_threshold === null
        ? config.thresholds.regexFallback
        : Number(row.regex_fallback_threshold),
    expectedFields: row.expected_fields.length > 0 ? [...row.expected_fields] : [...fallbackFields],
    validators: [...row.validators],
    llmSchema: (row.llm_schema ?? fallbackSchema) as Record<string, unknown>,
    source: 'db',
  };
}
