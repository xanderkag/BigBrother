/**
 * F13 polish: обогащение items[] полем `_slai_category_id` из lookup-table.
 *
 * После F6 (`applyCategoryHints`) каждая позиция имеет `category_hint`
 * вроде "food" / "metal" / "fuel" — наш внутренний слаг из 17 категорий.
 *
 * Если SLAI команда (через UI / sync events) сопоставила свои категории
 * с нашими hints (slai_category_map.our_hint), мы можем сразу добавить
 * `_slai_category_id: 42` на уровне item — это даёт SLAI matcher'у прямой
 * ID без необходимости делать дополнительные lookup на их стороне.
 *
 * Поведение:
 *   - Если lookup-table пустая (sync ещё не запущен / operator не настроил) —
 *     no-op (items не меняются)
 *   - Если у item уже есть `_slai_category_id` (например, LLM каким-то
 *     образом узнала) — НЕ перетираем
 *   - Идемпотентно
 *
 * Pure function на mapper, реальный лоокап делается caller'ом и
 * прокидывается как параметр (Map). Это нужно чтобы загружать lookup
 * один раз на job, а не для каждого item отдельно.
 */

export function enrichItemsWithSlaiCategoryIds(
  extracted: Record<string, unknown> | null,
  hintToSlaiId: Map<string, number>,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (hintToSlaiId.size === 0) return extracted; // lookup пустой — no-op

  const items = (extracted as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return extracted;

  let anyChanged = false;
  const newItems = items.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const row = raw as Record<string, unknown>;

    // Уважаем существующий _slai_category_id
    if (row._slai_category_id !== undefined && row._slai_category_id !== null) {
      return row;
    }

    const hint = typeof row.category_hint === 'string' ? row.category_hint : '';
    if (!hint) return row;

    const slaiId = hintToSlaiId.get(hint);
    if (slaiId === undefined) return row;

    anyChanged = true;
    return { ...row, _slai_category_id: slaiId };
  });

  if (!anyChanged) return extracted;
  return { ...extracted, items: newItems };
}
