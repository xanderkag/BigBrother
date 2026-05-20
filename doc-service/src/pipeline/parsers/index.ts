import type { DocumentTypeSlug, BuiltinDocumentType } from '../../types/documents.js';
import { isBuiltinDocumentType } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import type { DocumentParser } from './types.js';
import { InvoiceParser } from './invoice.js';
import { UpdParser } from './upd.js';
import { TtnParser } from './ttn.js';
import { CmrParser } from './cmr.js';
import { AktParser } from './akt.js';
import { GenericLlmParser } from './generic-llm.js';
import { MultiPassLlmParser, type MultipassConfig } from './multipass-llm.js';

export type ParsersOptions = {
  /**
   * Confidence threshold below which Phase 1 parsers fall back to the
   * LLM /extract endpoint. Phase 2 parsers always use the LLM directly,
   * so this option doesn't affect them.
   */
  regexFallbackThreshold?: number;
  /**
   * MultiPassLlmParser thresholds (config.multipass). Опционально —
   * при отсутствии парсер использует встроенные дефолты.
   */
  multipass?: MultipassConfig;
};

/**
 * ParsersFactory — диспатчер парсеров.
 *
 * Зачем factory вместо `Record<DocumentType, Parser>`:
 *   - **Builtin slug'и** (шесть классов: invoice, factInvoice, UPD, TTN,
 *     CMR, AKT) обслуживаются типизированными парсерами, как и раньше.
 *   - **Пользовательские slug'и** (всё, что админ создал через UI) не
 *     знают своего типа на этапе компиляции — для них фабрика отдаёт
 *     `GenericLlmParser`, который берёт JSON-схему и список полей из
 *     `ParserOverride` (DB row через resolver).
 *
 * Generic-парсеры мемоизируются по slug — повторное обращение возвращает
 * тот же инстанс. Builtin'ы строятся один раз в конструкторе.
 */
export class ParsersFactory {
  private readonly builtins: Record<BuiltinDocumentType, DocumentParser>;
  private readonly genericCache = new Map<string, DocumentParser>();
  private readonly multipassConfig?: MultipassConfig;

  constructor(
    private readonly llm: LlmClient,
    options: ParsersOptions = {},
  ) {
    const fallback = options.regexFallbackThreshold ?? 0.7;
    this.multipassConfig = options.multipass;
    this.builtins = {
      invoice: new InvoiceParser(llm, fallback),
      factInvoice: new UpdParser(llm, 'factInvoice', fallback),
      UPD: new UpdParser(llm, 'UPD', fallback),
      TTN: new TtnParser(llm),
      CMR: new CmrParser(llm),
      AKT: new AktParser(llm),
    };
  }

  get(slug: DocumentTypeSlug): DocumentParser {
    if (isBuiltinDocumentType(slug)) {
      return this.builtins[slug];
    }
    return this.getGeneric(slug);
  }

  /**
   * CP1: Force GenericLlmParser regardless of slug type.
   * Used when parser_kind='llm_extract' is set in the DB for a builtin type,
   * bypassing the regex pipeline and going straight to LLM extraction.
   */
  getGeneric(slug: DocumentTypeSlug): DocumentParser {
    const cached = this.genericCache.get(slug);
    if (cached) return cached;
    const parser = new GenericLlmParser(this.llm, slug);
    this.genericCache.set(slug, parser);
    return parser;
  }

  /**
   * Phase B: MultiPassLlmParser — для длинных документов (большое число
   * позиций). Активируется когда parser_kind='llm_extract_multipass' в БД
   * или автоматически при OCR-тексте > MULTIPASS_AUTO_THRESHOLD (см.
   * orchestrator). Делает Pass 1 на header + Pass 2 батчами на items[].
   */
  getMultipass(slug: DocumentTypeSlug): DocumentParser {
    const cacheKey = `__multipass__:${slug}`;
    const cached = this.genericCache.get(cacheKey);
    if (cached) return cached;
    const parser = new MultiPassLlmParser(this.llm, slug, this.multipassConfig);
    this.genericCache.set(cacheKey, parser);
    return parser;
  }
}

/**
 * Сохраняем экспорт `buildParsers` для обратной совместимости с тестами,
 * которые ожидают `Record<BuiltinDocumentType, Parser>`. Новый код
 * (orchestrator) использует `ParsersFactory` напрямую.
 */
export function buildParsers(
  llm: LlmClient,
  options: ParsersOptions = {},
): Record<BuiltinDocumentType, DocumentParser> {
  const factory = new ParsersFactory(llm, options);
  return {
    invoice: factory.get('invoice'),
    factInvoice: factory.get('factInvoice'),
    UPD: factory.get('UPD'),
    TTN: factory.get('TTN'),
    CMR: factory.get('CMR'),
    AKT: factory.get('AKT'),
  };
}
