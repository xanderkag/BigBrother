import { documentTypeResolver } from '../document-type-resolver.js';
import type { DocumentTypeRow } from '../../storage/document-types.js';

/**
 * Каталог типов для LLM-классификатора (production LLM classifier).
 *
 * Строит текст `slug — description` по всем активным типам организации
 * (globals ∪ tenant-owned), который уходит в system-prompt каталог-классификации.
 * Проверено в probe: qwen3.6:27b выбирает РОВНО ОДИН slug из ~38 типов
 * (каталог ~6.3k chars) за ~1s warm.
 *
 * Описание типа берём как в probe: description, иначе первые 80 символов
 * llm_prompt (у многих типов description пустой, но есть инструкция).
 *
 * Кэш: per-org bucket, TTL 60s. Инвалидация — через
 * documentTypeResolver.invalidate() (любой CRUD на document_types его зовёт),
 * которая дёргает наш invalidateCatalogCache() ниже. Так каталог не строится
 * на каждый job (это O(типов) конкатенация строк, но всё равно лишняя работа).
 */

const CATALOG_TTL_MS = 60_000;
const LLM_PROMPT_DESC_CHARS = 80;

type CachedCatalog = { text: string; at: number };

const cache = new Map<string, CachedCatalog>();

/** Ключ per-org bucket'а (совпадает с логикой listActiveForOrg). */
function bucketKey(orgId: string | null): string {
  return orgId ?? '∅';
}

/** Описание типа для каталога: description → first 80 chars llm_prompt → ''. */
function describeRow(row: DocumentTypeRow): string {
  const desc = (row.description ?? '').trim();
  if (desc.length > 0) return desc;
  const prompt = (row.llm_prompt ?? '').trim();
  if (prompt.length > 0) {
    // Однострочим — перевод строки в каталоге ломал бы «slug — description» разбивку.
    return prompt.replace(/\s+/g, ' ').slice(0, LLM_PROMPT_DESC_CHARS);
  }
  return '';
}

/** Собрать каталог-текст из строк типов. */
export function buildCatalogText(rows: readonly DocumentTypeRow[]): string {
  return rows
    .map((r) => {
      const d = describeRow(r);
      return d ? `${r.slug} — ${d}` : r.slug;
    })
    .join('\n');
}

/**
 * Получить (с кэшем) каталог активных типов для организации. Возвращает
 * `{ text, count }`. Пустой список → пустой текст (caller решает пропустить
 * LLM-классификацию и упасть на keyword).
 */
export async function getCatalogForOrg(
  orgId: string | null,
): Promise<{ text: string; count: number }> {
  const key = bucketKey(orgId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return { text: cached.text, count: cached.text ? cached.text.split('\n').length : 0 };
  }
  const rows = await documentTypeResolver.listActiveForOrg(orgId);
  const text = buildCatalogText(rows);
  cache.set(key, { text, at: Date.now() });
  return { text, count: rows.length };
}

/** Сбросить кэш каталога (все bucket'ы). Зовётся из documentTypeResolver.invalidate(). */
export function invalidateCatalogCache(): void {
  cache.clear();
}

// Регистрируем инвалидацию каталога на любой CRUD-write document_types —
// resolver зовёт зарегистрированные хуки в своём invalidate(). Так каталог
// подхватывает новый/удалённый/переименованный тип без ожидания TTL.
// Guard'им наличие метода: часть unit-тестов мокает resolver частичным
// объектом (vi.mock) без registerInvalidationHook — на нём каталог протухнет
// по TTL, чего для теста достаточно.
if (typeof documentTypeResolver.registerInvalidationHook === 'function') {
  documentTypeResolver.registerInvalidationHook(invalidateCatalogCache);
}
