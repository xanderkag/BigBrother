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

import { documentTypesRepo, type DocumentTypeRow } from '../storage/document-types.js';

const DEFAULT_TTL_MS = 60_000;

export class DocumentTypeResolver {
  private cache = new Map<string, { row: DocumentTypeRow | null; at: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

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
   * Drop a single slug or the entire cache. Called by future PUT/POST
   * handlers in document-types route so admins see their edits
   * reflected immediately, not at next TTL boundary.
   */
  invalidate(slug?: string): void {
    if (slug === undefined) this.cache.clear();
    else this.cache.delete(slug);
  }
}

/** Process-wide singleton used by the pipeline. */
export const documentTypeResolver = new DocumentTypeResolver();
