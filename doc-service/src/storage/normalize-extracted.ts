/**
 * Normalize-extracted — мост между старой и новой schema'ой v2.
 *
 * Phase A унифицировала имя массива позиций (раньше: positions / services /
 * goods / cargo) на единое `items[]`. Job'ы созданные до миграции содержат
 * extracted со старыми именами, и UI / Resolution Engine / ItemMatching
 * не должны знать про это разнообразие.
 *
 * Контракт: вызывается в `jobsRepo.toApi()` и в любом месте где extracted
 * читается ДЛЯ ОТОБРАЖЕНИЯ или ДЛЯ РЕЗОЛЮЦИИ. На write-пути (finalize)
 * наоборот — оставляем как пришло от LLM, чтобы дебагить разные схемы.
 *
 * Поведение:
 *   - Если в extracted уже есть `items[]` — ничего не делаем (новая схема)
 *   - Иначе ищем первое из ['positions','services','goods'] и копируем
 *     значение под ключ `items`. Старый ключ оставляем для совместимости
 *     (а вдруг прежний UI на него завязан).
 *   - Для TTN/CMR где исторически `cargo` — отдельный объект (а не массив):
 *     если items[] нет, оставляем cargo как есть; items останется undefined
 *     и UI просто не нарисует таблицу позиций.
 *
 * Функция чистая и идемпотентная: повторный вызов на нормализованном объекте
 * ничего не меняет.
 */

/** Имена legacy-полей которые мы канонизируем к `items[]`. Порядок = приоритет. */
const LEGACY_ITEM_FIELDS = ['positions', 'services', 'goods', 'line_items'] as const;

/**
 * Привести extracted к каноническому виду schema v2. Возвращает либо тот же
 * объект (если ничего не изменилось), либо новый — caller сам решает делать
 * ли копию защититься от мутации внешнего state.
 */
export function normalizeExtracted(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  // Если items[] уже есть — это новая schema, нечего делать
  if ('items' in extracted && Array.isArray(extracted.items)) {
    return extracted;
  }

  // Ищем первый legacy-ключ который содержит массив
  for (const legacyKey of LEGACY_ITEM_FIELDS) {
    const val = extracted[legacyKey];
    if (Array.isArray(val) && val.length > 0) {
      return {
        ...extracted,
        items: val,
        // Оставляем legacy-ключ — старый UI / интеграции на него могут
        // быть завязаны. Лишних 80KB на job нас не убьют.
      };
    }
  }

  // Ничего не нашли — возвращаем как есть (документ без table-секции)
  return extracted;
}

/**
 * Хелпер для Resolution Engine: при настройке `item_matching.items_field` админ
 * мог указать legacy-имя (positions / services). Резолвим к фактическому
 * массиву с учётом нормализации. Используется внутри pipeline/resolution.
 */
export function resolveItemsArray(
  extracted: Record<string, unknown>,
  preferredField: string = 'items',
): unknown[] {
  // 1. Сначала пытаемся прочитать как админ указал
  const direct = extracted[preferredField];
  if (Array.isArray(direct)) return direct;

  // 2. Fallback на каноническое items[]
  if (preferredField !== 'items' && Array.isArray(extracted.items)) {
    return extracted.items as unknown[];
  }

  // 3. Fallback на legacy-имена в порядке приоритета
  for (const legacyKey of LEGACY_ITEM_FIELDS) {
    if (legacyKey === preferredField) continue;
    const val = extracted[legacyKey];
    if (Array.isArray(val)) return val;
  }

  return [];
}
