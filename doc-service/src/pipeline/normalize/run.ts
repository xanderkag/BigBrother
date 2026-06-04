/**
 * Pipeline post-extract нормализации.
 *
 * Объединяет 4 нормализатора в один вызов с **явным порядком**:
 *   1. normalizeExtractedFields (F1) — ИНН/госномер в каноническом виде
 *   2. recomputeTotalsFromItems (F7) — пересчёт total_with_vat из items[]
 *   2b. deriveHeaderTotals (F7b) — канонические header-поля total /
 *      total_without_vat / vat / vat_rate, если модель их не дала в шапке
 *   3. applyCategoryHints (F6) — keyword-mapper по items[].name
 *   4. enrichItemsWithSlaiCategoryIds (F13 polish) — обогащение items
 *      из lookup-table SLAI nomenclature
 *
 * **Почему именно такой порядок:**
 *   - F1 первым потому что validation (которая идёт после нормализации)
 *     ожидает чистый ИНН без пробелов/дефисов
 *   - F7 после F1: пересчёт totals не зависит от ИНН, но логически
 *     post-extract «исправления» делаем до категоризации
 *   - F6 третьим: keyword-категоризация нужна ДО F13 enrichment'а
 *     (last step добавляет SLAI category_id _основываясь_ на category_hint
 *     который ставит F6)
 *   - F13 polish последним: требует наличия category_hint от F6 и не
 *     ставит сам, только обогащает существующий
 *
 * **Что НЕ здесь:**
 *   - F4 redactPii — применяется в webhook delivery (conditional на
 *     metadata.redact_pii=true, БД хранит non-redacted для аудита)
 *   - F2 processFieldConfidence — то же, в webhook delivery
 *
 * Все шаги pure / идемпотентны. Async только из-за F13 lookup в БД,
 * который best-effort: при ошибке БД пропускаем enrichment, остальные
 * шаги отрабатывают как обычно.
 */
import type { Logger } from 'pino';
import { normalizeExtractedFields } from './extracted-fields.js';
import { recomputeTotalsFromItems, deriveHeaderTotals } from './totals.js';
import { applyCategoryHints } from './categories.js';
import { enrichItemsWithSlaiCategoryIds } from './slai-enrichment.js';
import { slaiCategoriesRepo } from '../../storage/slai-categories.js';

export async function runPostExtractNormalization(
  extracted: Record<string, unknown> | null,
  log?: Logger,
): Promise<Record<string, unknown> | null> {
  if (!extracted) return extracted;

  let result: Record<string, unknown> | null = extracted;

  // F1: ИНН/госномер → канонический вид (validation потом проще)
  const normalized = normalizeExtractedFields(result);
  if (normalized && normalized !== result) result = normalized;

  // F7: пересчёт total_with_vat если расходится с items[]
  const recomputed = recomputeTotalsFromItems(result);
  if (recomputed && recomputed !== result) result = recomputed;

  // F7b: вывод канонических header-полей (total / total_without_vat / vat /
  // vat_rate), когда модель положила их под строчными именами или только
  // в items[]. После F7 — чтобы опираться на уже выверенный total_with_vat.
  const headered = deriveHeaderTotals(result);
  if (headered && headered !== result) result = headered;

  // F6: категоризация items[].name через keyword-mapper (детерминирован)
  const withCategories = applyCategoryHints(result);
  if (withCategories && withCategories !== result) result = withCategories;

  // F13 polish: обогащение _slai_category_id из lookup-table.
  // Best-effort: ошибка БД не блокирует остальной pipeline (например,
  // в smoke-тестах БД не инициализирована).
  try {
    const hintToSlaiId = await slaiCategoriesRepo.loadHintToIdMap();
    const enriched = enrichItemsWithSlaiCategoryIds(result, hintToSlaiId);
    if (enriched && enriched !== result) result = enriched;
  } catch (err) {
    if (log) log.warn({ err }, 'SLAI category enrichment skipped (DB error)');
  }

  return result;
}
