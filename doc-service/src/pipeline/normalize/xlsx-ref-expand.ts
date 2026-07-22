/**
 * SPEED-2 (2026-07-21): страховочный разворот словарных рефов @N.
 *
 * XlsxEngine при сериализации выносит повторяющиеся длинные ячейки в
 * словарь секции («@3 = POWERMAN LIMITED»), в строках остаётся @3. Модель
 * инструктируется подставлять полное значение, но может протащить реф в
 * extracted как есть. Этот шаг детерминированно разворачивает любые @N в
 * строковых значениях extracted по легенде из raw_text. Идемпотентен;
 * без легенды в raw_text — no-op.
 */

const LEGEND_LINE = /^(@\d+) = (.+)$/;
const REF_TOKEN = /@\d+/g;

/** Разобрать словарь «@N = значение» из raw_text (все секции-легенды). */
export function parseXlsxRefLegend(rawText: string | null | undefined): Map<string, string> {
  const dict = new Map<string, string>();
  if (!rawText || !rawText.includes('Словарь повторов')) return dict;
  for (const line of rawText.split('\n')) {
    const m = LEGEND_LINE.exec(line.trim());
    if (m) dict.set(m[1]!, m[2]!.trim());
  }
  return dict;
}

function expandValue(v: string, dict: Map<string, string>): string {
  if (!v.includes('@')) return v;
  return v.replace(REF_TOKEN, (tok) => dict.get(tok) ?? tok);
}

/** Рекурсивно развернуть @N во всех строковых значениях. Мутирует на месте. */
function walk(node: unknown, dict: Map<string, string>, counter: { n: number }): unknown {
  if (typeof node === 'string') {
    const out = expandValue(node, dict);
    if (out !== node) counter.n++;
    return out;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walk(node[i], dict, counter);
    return node;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) obj[k] = walk(obj[k], dict, counter);
    return node;
  }
  return node;
}

/**
 * Развернуть протащенные моделью @N в extracted. Возвращает число
 * развёрнутых значений (0 = ничего не менялось).
 */
export function expandXlsxRefs(
  extracted: Record<string, unknown> | null,
  rawText: string | null | undefined,
): number {
  if (!extracted) return 0;
  const dict = parseXlsxRefLegend(rawText);
  if (dict.size === 0) return 0;
  const counter = { n: 0 };
  walk(extracted, dict, counter);
  return counter.n;
}
