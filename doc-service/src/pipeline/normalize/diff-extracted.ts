/**
 * diffExtracted — pure-функция сравнения двух extracted-снимков (before/after)
 * на уровне листовых полей. Используется для operator corrections ledger:
 * каждая правка оператора раскладывается на before→after по dot-path.
 *
 * Листья — скаляры (string/number/boolean/null). Объекты и массивы
 * разворачиваются в dot-path до листьев (`a.b.c`, `items.0.name`).
 * Целые объекты/массивы как листья НЕ эмитятся.
 *
 * Эмитим запись на каждое ИЗМЕНЁННОЕ / ДОБАВЛЕННОЕ / УДАЛЁННОЕ листовое поле:
 *   - ADDED   → before=null
 *   - REMOVED → after=null
 *   - CHANGED → оба заполнены и различаются
 *
 * Мета-ключи (служебные, не человеческие правки) исключаются на любом
 * уровне пути — см. META_KEYS.
 */

export type ExtractedDiffEntry = {
  path: string;
  before: string | null;
  after: string | null;
};

/**
 * Зарезервированные служебные ключи — не правки человека, а артефакты
 * пайплайна/доставки. Исключаем где бы они ни встретились в пути.
 */
const META_KEYS = new Set<string>([
  '_match_signals',
  '_normalized_fields',
  '_field_confidence',
  '_issues',
  '_multidoc_documents',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Скаляр-лист → строка для хранения. null остаётся null. */
function stringifyLeaf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  // Прочие экзотические скаляры (symbol/function) — не данные, игнорируем.
  return null;
}

/**
 * Разворачивает значение в плоскую мапу dot-path → лист.
 * Листья — всё, что не plain-object и не массив. Мета-ключи отсекаются.
 */
function flattenLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (META_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      flattenLeaves(v, path, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const path = prefix ? `${prefix}.${i}` : String(i);
      flattenLeaves(value[i], path, out);
    }
    return;
  }
  // Лист (scalar/null/undefined). Пустой prefix невозможен на верхнем
  // вызове (before/after — объекты), но защищаемся: листья без пути не
  // эмитим.
  if (prefix) out.set(prefix, value);
}

/**
 * Сравнивает два extracted-снимка по листьям. Каждая сторона может быть
 * null/undefined/не-объектом — в этом случае её мапа листьев пуста.
 */
export function diffExtracted(before: unknown, after: unknown): ExtractedDiffEntry[] {
  const beforeLeaves = new Map<string, unknown>();
  const afterLeaves = new Map<string, unknown>();

  // Разворачиваем только если сторона — контейнер; иначе оставляем пустой
  // мапой (не-объект целиком не считаем правкой по полю).
  if (isPlainObject(before) || Array.isArray(before)) {
    flattenLeaves(before, '', beforeLeaves);
  }
  if (isPlainObject(after) || Array.isArray(after)) {
    flattenLeaves(after, '', afterLeaves);
  }

  const paths = new Set<string>([...beforeLeaves.keys(), ...afterLeaves.keys()]);
  const entries: ExtractedDiffEntry[] = [];

  for (const path of paths) {
    const hasBefore = beforeLeaves.has(path);
    const hasAfter = afterLeaves.has(path);
    const beforeStr = hasBefore ? stringifyLeaf(beforeLeaves.get(path)) : null;
    const afterStr = hasAfter ? stringifyLeaf(afterLeaves.get(path)) : null;

    if (hasBefore && hasAfter) {
      // Изменение только если строковое представление различается.
      if (beforeStr !== afterStr) entries.push({ path, before: beforeStr, after: afterStr });
    } else if (hasAfter) {
      // ADDED — поля не было.
      entries.push({ path, before: null, after: afterStr });
    } else {
      // REMOVED — поле было, исчезло.
      entries.push({ path, before: beforeStr, after: null });
    }
  }

  return entries;
}
