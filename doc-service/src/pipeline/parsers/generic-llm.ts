import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
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
 * Slug задаётся при конструировании — он же передаётся как hint в LLM,
 * чтобы inference-service мог поднять prompt для нужного типа из своих
 * настроек (когда подключится фича llm_prompt override).
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
    return llmExtract(
      this.llm,
      rawText,
      override?.llmSchema ?? {},
      this.type,
      override?.expectedFields ?? [],
    );
  }
}
