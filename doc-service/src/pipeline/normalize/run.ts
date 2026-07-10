/**
 * Pipeline post-extract нормализации.
 *
 * Объединяет нормализаторы в один вызов с **явным порядком**:
 *   0. recoverPartyInnsFromText (F0) — добить seller/buyer.inn из raw_text
 *      по меткам сторон, когда модель вернула placeholder/пропуск. До F1,
 *      чтобы F1 подхватил добитый ИНН в _normalized_fields.
 *   1. normalizeExtractedFields (F1) — ИНН/госномер в каноническом виде
 *   2. recomputeTotalsFromItems (F7) — пересчёт total_with_vat из items[]
 *   2b. deriveHeaderTotals (F7b) — канонические header-поля total /
 *      total_without_vat / vat / vat_rate, если модель их не дала в шапке
 *   3. applyCategoryHints (F6) — keyword-mapper по items[].name
 *   4. enrichItemsWithSlaiCategoryIds (F13 polish) — обогащение items
 *      из lookup-table SLAI nomenclature
 *   5. buildMatchSignals (PD-CONTRACT-1 §2.1) — канонический FLAT
 *      `_match_signals` для SLAI matcher. Последним: читает уже
 *      нормализованные поля (plate/ИНН), кладёт additive namespace.
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
import { recoverPartyInnsFromText } from './inn-recovery.js';
import { relocateOgrnFromInn } from './ogrn-relocate.js';
import { recoverContainersFromText } from './container-recovery.js';
import { normalizeExtractedFields } from './extracted-fields.js';
import { recomputeTotalsFromItems, deriveHeaderTotals } from './totals.js';
import { applyCategoryHints } from './categories.js';
import { enrichItemsWithSlaiCategoryIds } from './slai-enrichment.js';
import { buildMatchSignals } from './match-signals.js';
import { slaiCategoriesRepo } from '../../storage/slai-categories.js';

export async function runPostExtractNormalization(
  extracted: Record<string, unknown> | null,
  log?: Logger,
  rawText?: string | null,
  documentType?: string | null,
): Promise<Record<string, unknown> | null> {
  if (!extracted) return extracted;

  let result: Record<string, unknown> | null = extracted;

  // F0a: перенести 13/15-значный ОГРН из inn в ogrn. До F0-inn-recovery,
  // чтобы recovery добивал inn в уже освобождённое поле, а не спотыкался о
  // засевший там ОГРН. Детерминированно, по всем сторонам всех типов.
  const ogrnFixed = relocateOgrnFromInn(result);
  if (ogrnFixed && ogrnFixed !== result) result = ogrnFixed;

  // F0: добить ИНН сторон из raw_text по меткам, если модель их пропустила.
  // До F1 — чтобы F1 подхватил добитый ИНН в _normalized_fields.
  const innRecovered = recoverPartyInnsFromText(result, rawText);
  if (innRecovered && innRecovered !== result) result = innRecovered;

  // F0c (SLAI Q15): добить номер контейнера (ISO 6346) из raw_text по метке
  // «контейнер», если модель его пропустила. phi4 на крупных схемах (CMR)
  // отбрасывает хвостовой `containers` даже при явном «Контейнер: …» в тексте —
  // строгий формат надёжнее достаётся regex'ом, чем LLM.
  const contRecovered = recoverContainersFromText(result, rawText);
  if (contRecovered && contRecovered !== result) result = contRecovered;

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

  // PD-CONTRACT-1 §2.1: канонический FLAT `_match_signals` для SLAI matcher.
  // Последним — опирается на уже нормализованные plate/ИНН. `_field_confidence`
  // (если LLM прислала) ещё в extracted → §2.3 confidence наполняется тут же.
  // Additive: добавляем reserved-ключ, остальной extracted не трогаем.
  if (result && typeof result === 'object') {
    result = { ...result, _match_signals: buildMatchSignals(documentType ?? null, result) };
  }

  return result;
}
