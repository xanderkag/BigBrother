import { DOCUMENT_JSON_SCHEMAS, EXPECTED_FIELDS } from '../../types/document-json-schemas.js';
import type { LlmClient } from '../llm/types.js';
import { llmExtract } from './llm-extractor.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';
import {
  findDocNumber,
  findDate,
  findInn,
  findMoney,
  findVat,
  findVatRate,
  scoreCompleteness,
} from './common.js';

const DEFAULT_REGEX_EXPECTED_FIELDS: readonly string[] = ['number', 'date', 'total'];

/**
 * Phase 1 invoice parser. Strategy:
 *
 *  1. Run regex extraction (free, fast, deterministic) over the OCR text.
 *  2. If regex confidence ≥ `fallbackThreshold` — return regex result.
 *  3. Otherwise, if LLM is available, also run LLM /extract and return
 *     whichever result has higher confidence.
 *  4. If LLM is unavailable or fails, return the regex result regardless;
 *     the orchestrator will trip needs_review on low overall confidence.
 *
 * Bills only on the documents that actually need help: well-formed text
 * PDFs with the standard "Счёт № X от Y / Итого / НДС" pattern stay on
 * the regex path and never call the LLM.
 *
 * Parameters from `ParserOverride` (passed by the orchestrator from the
 * resolved Document Type Registry) take precedence over constructor
 * defaults. Without an override, behaviour is identical to pre-CP1.
 */
export class InvoiceParser implements DocumentParser {
  readonly type = 'invoice' as const;

  constructor(
    private readonly llm: LlmClient,
    private readonly fallbackThreshold: number = 0.7,
  ) {}

  async parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    const expectedFields = override?.expectedFields ?? DEFAULT_REGEX_EXPECTED_FIELDS;
    const fallbackThreshold = override?.regexFallbackThreshold ?? this.fallbackThreshold;

    const regex = this.parseWithRegex(rawText, expectedFields);

    // threshold=0 disables LLM-fallback entirely (regex always wins);
    // otherwise skip the LLM only when regex strictly exceeds the bar, so
    // threshold=1 forces the LLM even on a "perfect" regex result.
    if (fallbackThreshold === 0 || regex.confidence > fallbackThreshold || !this.llm.isAvailable()) {
      return regex;
    }

    let llm: ParseResult;
    try {
      llm = await llmExtract(
        this.llm,
        rawText,
        override?.llmSchema ?? DOCUMENT_JSON_SCHEMAS.invoice,
        'invoice',
        override?.expectedFields ?? EXPECTED_FIELDS.invoice,
        override?.llmPrompt,
        override?.imagePath,
      );
    } catch {
      // LLM glitch — silently fall back to regex. The orchestrator will
      // see low confidence and route to needs_review.
      return regex;
    }

    return llm.confidence > regex.confidence ? llm : regex;
  }

  private parseWithRegex(rawText: string, expectedFields: readonly string[]): ParseResult {
    const number = findDocNumber(rawText, 'счёт|счет');
    const date = findDate(rawText);
    const total = findMoney(rawText, 'Итого\\s+к\\s+оплате', 'Всего\\s+к\\s+оплате', 'Итого');
    const vat = findVat(rawText);
    const vat_rate = findVatRate(rawText);

    // Seller/buyer INN — best-effort: take first two INN occurrences.
    const innMatches = rawText.match(/ИНН[\s:№]*?(\d{12}|\d{10})(?!\d)/gi) ?? [];
    const sellerInn = innMatches[0]?.match(/(\d{12}|\d{10})/)?.[1];
    const buyerInn = innMatches[1]?.match(/(\d{12}|\d{10})/)?.[1];

    const fallbackInn = findInn(rawText);

    // ── EXT-LINE-2 (SLAI 2026-06-03): транспортные doc-level сигналы
    // для перевозочных счетов. Все 5 паттернов опциональны — если в счёте
    // нет — поля просто отсутствуют (frontend/SLAI matcher проверяют
    // existence). LLM-fallback подхватит то же самое из schema если regex
    // промахнулся, поэтому даём regex'ам жёстко-консервативные шаблоны.
    const orderRef = extractOrderRef(rawText);
    const vehiclePlate = extractVehiclePlate(rawText);
    const { from: routeFrom, to: routeTo } = extractRoute(rawText);
    const permitNo = extractPermitNo(rawText);

    const extracted: Record<string, unknown> = {
      number,
      date,
      seller: sellerInn || fallbackInn ? { inn: sellerInn ?? fallbackInn } : undefined,
      buyer: buyerInn ? { inn: buyerInn } : undefined,
      total,
      vat,
      vat_rate,
      // positions[] на regex не извлечь — ждём LLM-fallback.
      ...(orderRef ? { order_ref: orderRef } : {}),
      ...(vehiclePlate ? { vehicle: { plate: vehiclePlate } } : {}),
      ...(routeFrom ? { route_from: routeFrom } : {}),
      ...(routeTo ? { route_to: routeTo } : {}),
      ...(permitNo ? { permit_no: permitNo } : {}),
    };

    const { confidence, missing } = scoreCompleteness(
      extracted as Record<string, unknown>,
      expectedFields,
    );

    return { extracted, confidence, missing };
  }
}

// ── EXT-LINE-2 regex helpers ────────────────────────────────────────────
// Кириллические буквы РФ-номеров (только те что омографичны латыни — это
// исчерпывающий набор для ТС): А В Е К М Н О Р С Т У Х. Шаблон допускает
// как стандартный РФ-номер «А777ОО777», так и краткие региональные «К123АВ77».
const RU_PLATE_LETTERS = '[АВЕКМНОРСТУХ]';
const RU_PLATE_RE = new RegExp(
  `(${RU_PLATE_LETTERS}\\d{3}${RU_PLATE_LETTERS}{2}\\d{2,3})`,
);

/**
 * order_ref — номер заявки/основания перевозки.
 * Якорим на слова «заявка», «основание», «по заявке», «по основанию» —
 * без якоря (просто весь шаблон в тексте) слишком много ложных
 * срабатываний на номера договоров/документов.
 */
function extractOrderRef(text: string): string | undefined {
  // Шаблон: 2-5 заглавных латинских — год 4 цифры — порядковый 3-4 цифры.
  const re = /(?:заявк[аеи]|основани[еюя]|по\s+заявке|по\s+основанию)[^\n]{0,80}?\b([A-Z]{2,5}-\d{4}-\d{3,4})\b/i;
  const m = text.match(re);
  return m?.[1];
}

/**
 * vehicle.plate — гос. номер ТС. Якорим на «гос. номер», «ТС», «транспортное
 * средство», «авто», «автомобиль» — счёт может содержать чужие
 * последовательности типа «А4 размер» / «офис К123» / лицензии, поэтому
 * без якоря рискованно. После якоря допускаем до 80 символов служебных.
 */
function extractVehiclePlate(text: string): string | undefined {
  const re = new RegExp(
    `(?:гос\\.?\\s*номер|ТС[:\\s]|транспортное\\s+средство|авто(?:мобиль)?[:\\s])[^\\n]{0,80}?${RU_PLATE_RE.source}`,
    'i',
  );
  const m = text.match(re);
  return m?.[1]?.toUpperCase();
}

/**
 * route_from / route_to — городская пара через стрелку. Минимизируем
 * ложные срабатывания: ищем только в блоке «Маршрут», «маршрут плеча»,
 * «направление», «откуда → куда». Стрелки: →, ->, –, —.
 */
function extractRoute(text: string): { from?: string; to?: string } {
  // Лимит на длину города (1-25 буквы + опц. дефис). Один опциональный
  // второй кусок «Нижний Новгород» через пробел. Запрет \n в группах —
  // иначе захватываем следующую строку до точки с запятой.
  const cityRe = '[А-ЯЁ][а-яё-]{1,24}(?:[ ][А-ЯЁ][а-яё-]{1,24})?';
  const re = new RegExp(
    `(?:маршрут(?:\\s+плеч[аи])?|направление|откуда[^\\n]{0,10}куда)[^\\n]*?(?:г\\.?\\s*)?(${cityRe})\\s*(?:→|->|–|—)\\s*(?:г\\.?\\s*)?(${cityRe})`,
    'i',
  );
  const m = text.match(re);
  if (!m) return {};
  return { from: m[1]?.trim(), to: m[2]?.trim() };
}

/**
 * permit_no — номер спецразрешения для негабарита. Шаблон 2-3 / 4 / 3-6
 * взят с примера «77-2026-12345», ослабили до 1-3 / 4 / 3-7 чтобы
 * допускать вариации.
 */
function extractPermitNo(text: string): string | undefined {
  const re = /(?:спецразрешени[ею]|разрешени[еюя])[^\n]{0,60}?№?\s*(\d{1,3}-\d{4}-\d{3,7})/i;
  const m = text.match(re);
  return m?.[1];
}
