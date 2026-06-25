/**
 * XML OCR engine — уплощает XML-документ в читаемый текст для feeding в
 * classifier + LLM extract. Особенности:
 *
 *   - fast-xml-parser (lightweight, без нативных бинарей) парсит XML в дерево
 *   - Уплощаем дерево в строки `path/to/element: value` (по строке на лист-узел)
 *   - Атрибуты выводятся как `path/to/element@attr: value`
 *   - Повторяющиеся элементы индексируются (`Goods/Item[0]`, `Goods/Item[1]`),
 *     чтобы LLM мог различить позиции списка (товары в декларации и т.п.)
 *
 * Контракт: возвращает один многострочный text. classifier и LLM extract
 * работают на нём как на любом другом OCR-выводе. confidence всегда 1.0 —
 * это точное чтение через XML-парсер, не вероятностное OCR на изображении.
 *
 * Сценарий из реального кейса: электронные документы (ЭД) — таможенные
 * декларации в XML. Раньше XML отвергался на ингесте.
 */
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import type { OcrEngine, OcrInput, OcrResult } from './types.js';

const XML_MIMES = new Set(['application/xml', 'text/xml']);

/** Защита от мегабольших XML'ей (огромных деклараций/выгрузок). */
const MAX_TEXT_CHARS = 500_000; // ~125k tokens — больше Qwen context window

/** Парсер: НЕ игнорируем атрибуты (нужны для деклараций), без префикса в имени. */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false, // храним значения как строки — не теряем ведущие нули в кодах/ИНН
  parseAttributeValue: false,
  ignoreDeclaration: true, // `<?xml?>` — служебный пролог, не контент
  ignorePiTags: true, // processing-instructions тоже не контент
});

/**
 * Рекурсивно обходит дерево, накапливая строки `path: value`. Лист-узел —
 * примитив (строка/число/булево) или текстовый узел `#text`. Атрибуты узла
 * (ключи с префиксом `@`) выводятся как `path@attr: value`. Повторяющиеся
 * элементы (массивы) индексируются `path[i]`.
 */
function flatten(node: unknown, path: string, out: string[]): void {
  if (node === null || node === undefined) {
    if (path) out.push(`${path}:`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (key.startsWith('?')) {
        // Processing instruction / XML declaration (`?xml`) — служебный узел,
        // не контент документа. Не выводим.
        continue;
      }
      if (key.startsWith('@')) {
        // Атрибут: path@attr: value
        out.push(`${path}@${key.slice(1)}: ${String(value)}`);
      } else if (key === '#text') {
        // Текстовое содержимое узла, у которого ещё есть атрибуты.
        if (value !== '' && value !== null && value !== undefined) {
          out.push(`${path}: ${String(value)}`);
        }
      } else {
        flatten(value, path ? `${path}/${key}` : key, out);
      }
    }
    return;
  }
  // Примитив (лист) — выводим как path: value
  const v = String(node);
  if (v !== '') out.push(`${path}: ${v}`);
}

export class XmlEngine implements OcrEngine {
  readonly name = 'xml';
  // Точное чтение, не вероятностное — threshold невысокий, чтобы первый же
  // engine в chain accept'нул и остальные skip'нули.
  readonly acceptanceThreshold = 0.5;

  supports(input: OcrInput): boolean {
    return XML_MIMES.has(input.mimeType);
  }

  isAvailable(): boolean {
    // fast-xml-parser — npm-пакет, всегда доступен.
    return true;
  }

  async run(input: OcrInput): Promise<OcrResult> {
    const t0 = Date.now();
    const raw = await readFile(input.filePath, 'utf-8');

    let tree: unknown;
    try {
      tree = parser.parse(raw);
    } catch {
      // Битый XML — мягко, как docx/xlsx на пустом: пустой text → confidence 0,
      // job завершится needs_review/без типа, оператор увидит причину.
      tree = null;
    }

    const lines: string[] = [];
    flatten(tree, '', lines);
    let text = lines.join('\n');

    // Защита от мегабольших: trim до limit с маркером.
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) +
        `\n\n[TRUNCATED: документ длиннее ${MAX_TEXT_CHARS} chars, обрезан]`;
    }

    return {
      engine: 'xml',
      text,
      // confidence 1.0 для непустого — точное чтение через XML-парсер,
      // не вероятностное OCR. Пустой/битый → 0.0 (как docx/xlsx).
      confidence: text.length > 0 ? 1.0 : 0.0,
      durationMs: Date.now() - t0,
    };
  }
}
