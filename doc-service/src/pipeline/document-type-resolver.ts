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
import {
  documentTypesRepo,
  type DocumentTypeRow,
  type DocumentTypeTier,
} from '../storage/document-types.js';
import { DOCUMENT_JSON_SCHEMAS, EXTENDED_SCHEMAS, EXPECTED_FIELDS } from '../types/document-json-schemas.js';
import type { DocumentTypeSlug } from '../types/documents.js';
import type { ResolutionConfig } from '../resolution/types.js';

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
  /**
   * Кастомная инструкция для LLM-агента из `document_types.llm_prompt`.
   * Если не задана админом — `null`, и inference-service использует
   * встроенный prompt для этого типа.
   */
  llmPrompt: string | null;
  /**
   * CP1: parser_kind из БД. Если 'llm_extract' — форсируем GenericLlmParser
   * даже для builtin-slug'ов (позволяет отключить regex и перейти на чистый
   * LLM для конкретного типа без передеплоя кода).
   * null = используем дефолтный диспатч фабрики.
   */
  parserKind: string | null;
  /**
   * Конфиг резолюционного пайплайна из document_types.resolution_config.
   * null — резолюция не настроена для этого типа документа.
   */
  resolutionConfig: ResolutionConfig | null;
  /**
   * Зрелость типа (см. DocumentTypeTier). Информационное поле для UI
   * и логов — runtime не принимает решений на его основе. Для fallback'а
   * (row=null) дефолтим в 'experimental' — это самый осторожный bucket.
   */
  tier: DocumentTypeTier;
  /**
   * Hybrid-routing (SLAI #3): per-type принудительный vision-путь. true →
   * роутер маршрутизирует extract этого типа через vision-провайдера даже при
   * чистом text-слое. Fallback (row=null) → false. Гейтится HYBRID_ROUTING_ENABLED.
   */
  preferVision: boolean;
  /**
   * Adaptive-model routing (2026-07-09): id LLM-провайдера для extract'а
   * этого типа документа. Читается из `metadata.preferred_provider_id`
   * (JSONB). Use-case: тяжёлые ГТД с длинными items[] уходят на Ollama
   * (context 32k), лёгкие BL/invoice — на vLLM (context 8k, но 40× быстрее).
   * `null` = используем дефолтного провайдера (без override).
   */
  preferredProviderId: string | null;
  /** Whether this config was DB-sourced or fully built from fallbacks. */
  source: 'db' | 'fallback';
};

export class DocumentTypeResolver {
  private cache = new Map<string, { row: DocumentTypeRow | null; at: number }>();
  /**
   * Кэш для listActiveForOrg() — keyed по org-bucket'у, чтобы набор типов
   * tenant A не утёк в tenant B (CP7). Ключ '∅' = globals-only (orgId=null);
   * прочие ключи = orgId. Инвалидируется широко (любой write на document_types
   * сбрасывает ВСЕ bucket'ы — типы меняются редко, точечная инвалидация по
   * org не стоит сложности).
   */
  private listCache = new Map<string, { rows: DocumentTypeRow[]; at: number }>();

  /**
   * Хуки, вызываемые на invalidate() — производные кэши (LLM-каталог
   * классификатора), которые зависят от состава активных типов. Регистрируются
   * извне (registerInvalidationHook), чтобы избежать циклического импорта
   * resolver ↔ catalog. Ошибки хука не роняют invalidate.
   */
  private invalidationHooks: Array<() => void> = [];

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** Зарегистрировать callback, срабатывающий на каждый invalidate(). */
  registerInvalidationHook(hook: () => void): void {
    this.invalidationHooks.push(hook);
  }

  /**
   * CP7: scope-aware активный набор для пайплайна организации `orgId`.
   *   orgId = <uuid> ⇒ глобальные ∪ свои типы этой орг;
   *   orgId = null   ⇒ только глобальные.
   * Один DB round-trip на (org, ttl); кэш per-org. При любом CRUD-write на
   * document_types вызовите `invalidate()` — это сбросит весь list-кэш.
   */
  async listActiveForOrg(orgId: string | null): Promise<DocumentTypeRow[]> {
    const key = orgId ?? '∅';
    const cached = this.listCache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.rows;
    }
    let rows: DocumentTypeRow[];
    try {
      rows = await documentTypesRepo.listActiveForOrg(orgId);
    } catch {
      // DB hiccup — не отравляем кэш. Возвращаем пустой список, классификатор
      // деградирует к hardcoded fallback'у.
      return [];
    }
    this.listCache.set(key, { rows, at: Date.now() });
    return rows;
  }

  /**
   * Org-unaware активный набор (globals + ВСЕ tenant-типы). Оставлен для
   * не-tenant контекстов / совместимости. Hot-path должен использовать
   * `listActiveForOrg(orgId)`. Кэшируется в том же bucket-map под ключом '*'.
   */
  async listActive(): Promise<DocumentTypeRow[]> {
    const key = '*';
    const cached = this.listCache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.rows;
    }
    let rows: DocumentTypeRow[];
    try {
      rows = await documentTypesRepo.listActive();
    } catch {
      return [];
    }
    this.listCache.set(key, { rows, at: Date.now() });
    return rows;
  }

  /**
   * Get the config for a slug. Returns `null` (cached) when the slug
   * doesn't exist in the registry — caller is expected to fall back.
   * Cache-misses make one DB call; subsequent reads in the TTL window
   * are in-memory.
   */
  async get(slug: string): Promise<DocumentTypeRow | null> {
    // F22 (2026-05-17): case-insensitive lookup + SLAI alias map.
    // SLAI ТЗ v1 использует нейминг отличный от наших исторических slug'ов
    // (services_act ≠ AKT, tax_invoice ≠ factInvoice, upd ≠ UPD).
    // Чтобы не делать миграцию данных в БД — расширяем candidates list
    // и пробуем каждый. Первый найденный row возвращается.
    const candidates = this.expandSlugCandidates(slug);
    for (const candidate of candidates) {
      const cached = this.cache.get(candidate);
      if (cached && Date.now() - cached.at < this.ttlMs) {
        if (cached.row) return cached.row;
        continue;
      }
      let row: DocumentTypeRow | null;
      try {
        row = await documentTypesRepo.findBySlug(candidate);
      } catch {
        // DB hiccup — don't poison the cache, just say "no entry" for now
        // so the caller falls back to hardcoded behaviour. We can revisit
        // if this masks real DB outages in production.
        return null;
      }
      this.cache.set(candidate, { row, at: Date.now() });
      if (row) return row;
    }
    return null;
  }

  /**
   * F22: расширить slug в список candidate'ов которые искать в БД.
   * Порядок важен: пробуем сначала точное совпадение, потом alias'ы,
   * потом регистр-варианты. Первый найденный row побеждает.
   *
   * SLAI_ALIASES — explicit map от их нейминга к нашему историческому
   * (см. PARSDOCS_REPLY_TO_SLAI_TZ.md секция 2.1). Расширяется по мере
   * появления новых типов в их ТЗ.
   */
  private expandSlugCandidates(slug: string): string[] {
    const SLAI_ALIASES: Record<string, string> = {
      services_act: 'AKT',
      tax_invoice: 'factInvoice',
      // upd/ttn/cmr попадают через uppercase ниже — не нужны в alias map
    };
    const result: string[] = [slug];
    const lowered = slug.toLowerCase();
    if (SLAI_ALIASES[lowered] && !result.includes(SLAI_ALIASES[lowered])) {
      result.push(SLAI_ALIASES[lowered]);
    }
    const upper = slug.toUpperCase();
    if (upper !== slug && !result.includes(upper)) {
      result.push(upper);
    }
    if (lowered !== slug && !result.includes(lowered)) {
      result.push(lowered);
    }
    return result;
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
    // CP7: list-кэш keyed по org-bucket'у. Любой write мог поменять состав
    // активных типов в любом bucket'е (global-тип виден всем; tenant-тип —
    // одной орг). Чистим весь map целиком — типы меняются редко.
    this.listCache.clear();
    // Производные кэши (LLM-каталог классификатора) — тоже сбрасываем, состав
    // типов мог поменяться. Ошибки хука глушим (invalidate не должен падать).
    for (const hook of this.invalidationHooks) {
      try {
        hook();
      } catch {
        // best-effort — производный кэш протухнет сам по TTL
      }
    }
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
  const extSchemas = EXTENDED_SCHEMAS as Record<string, Record<string, unknown> | undefined>;
  const fields = EXPECTED_FIELDS as Record<string, string[] | undefined>;
  // Fallback-схема для типа без своей DB-llm_schema: сначала классические
  // DOCUMENT_JSON_SCHEMAS (invoice/TTN/CMR/AKT), затем EXTENDED_SCHEMAS
  // (bill_of_lading/waybill/transport_* и др. — иначе они резолвились в {} и
  // LLM получал «extract whatever» → пустой extracted).
  const fallbackSchema = schemas[slug] ?? extSchemas[slug] ?? {};
  const fallbackFields = fields[slug] ?? [];

  if (!row) {
    return {
      slug,
      confidenceThreshold: config.thresholds.needsReview,
      regexFallbackThreshold: config.thresholds.regexFallback,
      expectedFields: [...fallbackFields],
      validators: [],
      llmSchema: fallbackSchema as Record<string, unknown>,
      llmPrompt: null,
      parserKind: null,
      resolutionConfig: null,
      tier: 'experimental',
      preferVision: false,
      preferredProviderId: null,
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
    // Пустую строку трактуем как «не задан» — в форме админ может Save'нуть
    // textarea с одними пробелами; не разваливаем prompt.
    llmPrompt: row.llm_prompt && row.llm_prompt.trim().length > 0 ? row.llm_prompt : null,
    parserKind: row.parser_kind ?? null,
    resolutionConfig: (row.resolution_config as ResolutionConfig | null) ?? null,
    // tier на row есть всегда после миграции 20260525000001 (NOT NULL default
    // 'experimental'). Если по какой-то причине row из старого snapshot'а без
    // колонки — деградируем в 'experimental'.
    tier: (row.tier ?? 'experimental') as DocumentTypeTier,
    preferVision: row.prefer_vision === true,
    preferredProviderId: readPreferredProviderId(row.metadata),
    source: 'db',
  };
}

/**
 * Читает `preferred_provider_id` из document_types.metadata (JSONB).
 * Возвращает id провайдера, если задан непустой строкой, иначе null.
 * Валидность провайдера (существует ли, active?) проверяется на runtime
 * в `dynamicLlm.probeForceProvider()` — тут мы просто извлекаем строку.
 */
function readPreferredProviderId(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const v = metadata.preferred_provider_id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
