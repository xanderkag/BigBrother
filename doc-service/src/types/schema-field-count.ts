/**
 * Подсчёт листовых полей эффективной JSON Schema типа документа — число для
 * колонки «Поля» в UI. Раньше UI показывал длину сырой БД-колонки
 * `expected_fields`, которая у типов со схемой-в-коде (bill_of_lading / CMR /
 * TTN — llm_schema NULL, боевая схема в EXTENDED_SCHEMAS) пуста → таблица
 * показывала «0» при богатом реальном извлечении. Считаем по той же схеме,
 * которую реально шлём в LLM (резолвер с fallback'ом).
 */

interface SchemaNode {
  type?: unknown;
  properties?: unknown;
  items?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function countProps(props: Record<string, unknown>, depth: number): number {
  let n = 0;
  for (const def of Object.values(props)) {
    n += countNode(def, depth);
  }
  return n;
}

function countNode(def: unknown, depth: number): number {
  // Глубина ограничена защитно: реальные схемы ≤3 уровней (стороны →
  // реквизиты, items[] → колонки); циклов в них нет, но чужой admin-override
  // из БД может быть произвольным.
  if (!isRecord(def) || depth >= 6) return 1;
  const node = def as SchemaNode;
  if (isRecord(node.properties)) {
    // Объект (сторона сделки и т.п.) — считаем его листья, сам объект не поле.
    return Math.max(1, countProps(node.properties, depth + 1));
  }
  if (isRecord(node.items)) {
    const items = node.items as SchemaNode;
    if (isRecord(items.properties)) {
      // Массив объектов (позиции, контейнеры) — считаем колонки строки.
      return Math.max(1, countProps(items.properties, depth + 1));
    }
  }
  return 1;
}

/** Число листовых полей схемы; 0 для пустой/невалидной схемы. */
export function countSchemaLeafFields(schema: Record<string, unknown> | null | undefined): number {
  if (!isRecord(schema)) return 0;
  const props = (schema as SchemaNode).properties;
  if (!isRecord(props)) return 0;
  return countProps(props, 0);
}
