import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import { EXTENDED_SCHEMAS } from '../../types/document-json-schemas.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';

/**
 * GenericLlmParser — парсер для **любого** типа документа, который не
 * входит в шесть builtin'ов. Используется, когда админ через UI создал
 * пользовательский тип (`commercial_invoice`, `packing_list`, …) с
 * `parser_kind='llm_extract'`.
 *
 * В отличие от типизированных Phase 2 парсеров (TtnParser/CmrParser/
 * AktParser), здесь нет hardcoded JSON-схемы и нет hardcoded списка
 * полей: всё приходит через `ParserOverride` — оркестратор берёт их из
 * `ResolvedTypeConfig` (DB row, прошитой через резолвер).
 *
 * Если override не дали (e.g. в smoke-runner'е без DB) или схема в
 * override пустая — парсер всё равно работает, но в `missing[]` ничего
 * не попадает (нечего ожидать), а LLM получает пустую `{}` схему. Это
 * деградация к "extract whatever you can"; качество низкое, но не падаем.
 *
 * Slug задаётся при конструировании — он же передаётся как hint в LLM.
 * Если в override задан `llmPrompt` (админ-настроенная инструкция),
 * парсер пробрасывает её в inference-service, который заменяет ею
 * встроенный prompt для этого типа.
 */
export class GenericLlmParser implements DocumentParser {
  readonly type: DocumentTypeSlug;

  constructor(
    private readonly llm: LlmClient,
    slug: DocumentTypeSlug,
  ) {
    this.type = slug;
  }

  parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    // EXT-TTN-1 (SLAI 2026-06-04): fallback на EXTENDED_SCHEMAS[slug] если
    // override не дал схему. Раньше схема была `{}` → LLM получал «extract
    // whatever» инструкцию → пустой extracted (особенно сильно ударяло по
    // bill_of_lading / waybill / transport_invoice / transport_request).
    // Теперь если в EXTENDED_SCHEMAS есть запись по slug — используем её.
    const fallbackSchema = EXTENDED_SCHEMAS[this.type] ?? {};
    return llmExtract(
      this.llm,
      rawText,
      override?.llmSchema ?? fallbackSchema,
      this.type,
      override?.expectedFields ?? [],
      override?.llmPrompt,
      override?.imagePath,
    );
  }
}
