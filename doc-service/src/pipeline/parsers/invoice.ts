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

// EXT-TTN-1 (SLAI 2026-06-04): items добавлены в expected — без них regex
// «достаточно хороший» (0.833) и LLM-fallback не зовётся, items[] остаются
// пустыми даже когда таблица в счёте есть. items на regex не извлечь —
// добавление в expected опускает confidence ниже threshold (0.7) и
// активирует LLM-fallback, который таблицу разберёт.
const DEFAULT_REGEX_EXPECTED_FIELDS: readonly string[] = ['number', 'date', 'total', 'items'];

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
    // для перевозочных счетов. Все паттерны опциональны — если в счёте
    // нет — поля просто отсутствуют. LLM-fallback подхватит то же самое
    // из schema если regex промахнулся.
    const orderRef = extractOrderRef(rawText);
    const vehiclePlate = extractVehiclePlate(rawText);
    const { from: routeFrom, to: routeTo } = extractRoute(rawText);
    const permitNo = extractPermitNo(rawText);
    // ── EXT-LINE-3 (SLAI 2026-06-03 P0): bank/ogrn/due_date/payment_method
    const dueDate = extractDueDate(rawText);
    const paymentMethod = extractPaymentMethod(rawText);
    const ogrnMatches = (rawText.match(/ОГРН[\s:№]*(\d{15}|\d{13})(?!\d)/gi) ?? [])
      .map((m) => m.match(/(\d{15}|\d{13})/)?.[1])
      .filter((x): x is string => !!x);
    const sellerOgrn = ogrnMatches[0];
    const buyerOgrn = ogrnMatches[1];
    const bik = rawText.match(/БИК[\s:№]*(\d{9})(?!\d)/i)?.[1];
    const account = rawText.match(/(?:расч(?:[её]т|\.))?\s*(?:р\/?с|сч[её]т)[^\d\n]{0,30}(\d{20})(?!\d)/i)?.[1]
      ?? rawText.match(/\b(\d{20})\b/)?.[1];
    const corrAccount = rawText.match(/(?:к(?:орр)?\.?\s*с(?:ч[её]т)?|к\/с)[^\d\n]{0,30}(\d{20})(?!\d)/i)?.[1];
    // ── EXT-LINE-4 (SLAI 2026-06-03 P1): cargo/escort/vehicle.model/trailer
    const vehicleModel = extractVehicleModel(rawText);
    const vehicleTrailer = extractVehicleTrailer(rawText);
    const vehicleAxles = extractVehicleAxles(rawText);
    const permitIssuer = extractPermitIssuer(rawText);
    const permitValidTo = extractPermitValidTo(rawText);
    const cargo = extractCargo(rawText);
    const escort = extractEscort(rawText);
    const legKind = extractLegKind(rawText);

    const sellerObj: Record<string, unknown> = {};
    if (sellerInn ?? fallbackInn) sellerObj.inn = sellerInn ?? fallbackInn;
    if (sellerOgrn) sellerObj.ogrn = sellerOgrn;
    if (bik) sellerObj.bik = bik;
    if (account) sellerObj.account = account;
    if (corrAccount) sellerObj.corr_account = corrAccount;
    const buyerObj: Record<string, unknown> = {};
    if (buyerInn) buyerObj.inn = buyerInn;
    if (buyerOgrn) buyerObj.ogrn = buyerOgrn;

    const vehicleObj: Record<string, unknown> = {};
    if (vehiclePlate) vehicleObj.plate = vehiclePlate;
    if (vehicleModel) vehicleObj.model = vehicleModel;
    if (vehicleTrailer) vehicleObj.trailer = vehicleTrailer;
    if (vehicleAxles !== undefined) vehicleObj.axles = vehicleAxles;

    // EXT-LINE-4: transport.* nested зеркало + расширения.
    const transportObj: Record<string, unknown> = {};
    if (Object.keys(vehicleObj).length > 0) transportObj.vehicle = vehicleObj;
    if (routeFrom || routeTo || legKind) {
      const routeObj: Record<string, unknown> = {};
      if (routeFrom) routeObj.from = routeFrom;
      if (routeTo) routeObj.to = routeTo;
      if (legKind) routeObj.leg_kind = legKind;
      transportObj.route = routeObj;
    }
    if (permitNo || permitIssuer || permitValidTo) {
      const permitObj: Record<string, unknown> = {};
      if (permitNo) permitObj.number = permitNo;
      if (permitIssuer) permitObj.issued_by = permitIssuer;
      if (permitValidTo) permitObj.valid_to = permitValidTo;
      transportObj.permit = permitObj;
    }
    if (cargo) transportObj.cargo = cargo;
    if (escort) transportObj.escort = escort;

    const extracted: Record<string, unknown> = {
      number,
      date,
      seller: Object.keys(sellerObj).length > 0 ? sellerObj : undefined,
      buyer: Object.keys(buyerObj).length > 0 ? buyerObj : undefined,
      total,
      vat,
      vat_rate,
      // positions[] на regex не извлечь — ждём LLM-fallback.
      ...(orderRef ? { order_ref: orderRef } : {}),
      ...(Object.keys(vehicleObj).length > 0 ? { vehicle: vehicleObj } : {}),
      ...(routeFrom ? { route_from: routeFrom } : {}),
      ...(routeTo ? { route_to: routeTo } : {}),
      ...(permitNo ? { permit_no: permitNo } : {}),
      ...(dueDate ? { due_date: dueDate } : {}),
      ...(paymentMethod ? { payment_method: paymentMethod } : {}),
      ...(Object.keys(transportObj).length > 0 ? { transport: transportObj } : {}),
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

// ── EXT-LINE-3 P0 helpers ────────────────────────────────────────────────

/** due_date — «оплатить до DD.MM.YYYY», «срок оплаты DD.MM.YYYY». */
function extractDueDate(text: string): string | undefined {
  const re = /(?:оплатить\s+до|срок\s+оплаты|оплата\s+до)[^\n]{0,30}?(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/i;
  const m = text.match(re);
  if (!m) return undefined;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/** payment_method — enum cash/bank_transfer/prepayment/postpayment/card/other. */
function extractPaymentMethod(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(нал(?:ичн|ични)|cash)/i.test(text)) return 'cash';
  if (/\b(банковск\w*\s+перевод|безналичн\w*|б\/?н\b|bank\s*transfer)/i.test(lower)) return 'bank_transfer';
  if (/\b(предоплат\w*|аванс|prepay)/i.test(lower)) return 'prepayment';
  if (/\b(постоплат\w*|оплата\s+после|postpay)/i.test(lower)) return 'postpayment';
  if (/\b(карт(?:а|ой)|card)/i.test(lower)) return 'card';
  return undefined;
}

// ── EXT-LINE-4 P1 helpers ────────────────────────────────────────────────

/** vehicle.model — известные бренды тягачей. Без якоря — список фиксированный. */
function extractVehicleModel(text: string): string | undefined {
  const re = /\b(MAN(?:\s+\w+(?:\s+\d+\.\d+)?)?|Volvo(?:\s+\w+)?|Scania(?:\s+\w+)?|DAF(?:\s+\w+)?|КАМАЗ[\s-]?\d+|КамАЗ[\s-]?\d+|Mercedes(?:[\s-]Benz)?(?:\s+\w+)?|Iveco(?:\s+\w+)?)/i;
  const m = text.match(re);
  return m?.[1]?.trim();
}

/** vehicle.trailer — Goldhofer / Faymonville и пр. трал-бренды. */
function extractVehicleTrailer(text: string): string | undefined {
  const re = /\b(Goldhofer(?:\s+[\w-]+)?|Faymonville(?:\s+[\w-]+)?|Nooteboom(?:\s+[\w-]+)?|Scheuerle(?:\s+[\w-]+)?|низкорамн\w*\s+трал(?:\s+\w+)?)/i;
  const m = text.match(re);
  return m?.[1]?.trim();
}

/** vehicle.axles — «5 осей», «5-осный». */
function extractVehicleAxles(text: string): number | undefined {
  const re = /(\d{1,2})[\s-]*ос(?:ей|ный|ный?|евой)/i;
  const m = text.match(re);
  return m?.[1] ? parseInt(m[1], 10) : undefined;
}

/** permit.issued_by — кто выдал спецразрешение. */
function extractPermitIssuer(text: string): string | undefined {
  // Якорь: «выдано», «выдан», «issued by» возле строки разрешения, либо
  // прямое упоминание уполномоченных органов.
  const orgRe = /\b(Росавтодор|Ространснадзор|ЦОДД|Минтранс\s+\w+|ГИБДД)/i;
  const m = text.match(orgRe);
  return m?.[1]?.trim();
}

/** permit.valid_to — «действует до DD.MM.YYYY», «срок действия до DD.MM.YYYY». */
function extractPermitValidTo(text: string): string | undefined {
  const re = /(?:действ(?:ует|ительн\w*)|срок\s+действия|valid)[^\n]{0,30}?(?:до\s+)?(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/i;
  const m = text.match(re);
  if (!m) return undefined;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/** cargo — description / weight_kg / dimensions / oversized. */
function extractCargo(text: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  // weight «35 т», «35.5 т», «35000 кг»
  const wTons = text.match(/(\d+(?:[.,]\d+)?)\s*т(?:онн)?\b/i);
  const wKg = text.match(/(\d+(?:[.,]\d+)?)\s*кг\b/i);
  if (wTons?.[1]) out.weight_kg = Math.round(parseFloat(wTons[1]!.replace(',', '.')) * 1000);
  else if (wKg?.[1]) out.weight_kg = parseFloat(wKg[1]!.replace(',', '.'));
  // dimensions «10.5 × 3.8 × 4.2 м» / «10,5x3,8x4,2 м»
  const dim = text.match(/(\d+(?:[.,]\d+)?)\s*[×xх]\s*(\d+(?:[.,]\d+)?)\s*[×xх]\s*(\d+(?:[.,]\d+)?)\s*м/i);
  if (dim) {
    const toNum = (s: string): number => parseFloat(s.replace(',', '.'));
    out.dimensions = {
      length_m: toNum(dim[1]!),
      width_m: toNum(dim[2]!),
      height_m: toNum(dim[3]!),
    };
  } else {
    const dimRaw = text.match(/(?:габарит\w*|размер\w*)[^\n]{0,80}/i);
    if (dimRaw) out.dimensions_raw = dimRaw[0].trim();
  }
  // oversized — упоминание «негабарит» / «крупногабарит» / «тяжеловес»
  if (/негабарит\w*|крупногабарит\w*|тяжеловес\w*/i.test(text)) out.oversized = true;
  // description — желательно из явного блока «груз:», иначе пропускаем (LLM-fallback подхватит)
  const desc = text.match(/(?:груз|перевозим\w*\s+груз)\s*[:—-]\s*([^\n]{5,120})/i);
  if (desc?.[1]) out.description = desc[1]!.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}

/** escort — required / type / area. */
function extractEscort(text: string): Record<string, unknown> | undefined {
  const hasEscort = /сопровожд\w*|эскорт|escort/i.test(text);
  if (!hasEscort) return undefined;
  const out: Record<string, unknown> = { required: true };
  const typeMatch = text.match(/(патрул[ьея]\s+ГИБДД|машин\w+\s+прикрытия|лоцман[\s-]?водител\w*|эскорт\s+\w+)/i);
  if (typeMatch?.[1]) out.type = typeMatch[1]!.trim();
  const areaMatch = text.match(/(?:сопровожд\w*|эскорт)[^\n]{0,80}?(?:на|по)\s+((?:[А-ЯЁа-яё-]+\s*){1,4}участк\w*|весь\s+маршрут)/i);
  if (areaMatch?.[1]) out.area = areaMatch[1]!.trim();
  return out;
}

/** route.leg_kind — auto/rail/sea/air/customs. */
function extractLegKind(text: string): string | undefined {
  if (/(жд|железнодорожн\w*|ж\.д\.)/i.test(text)) return 'rail';
  if (/(морск\w*|sea|vessel|контейнерн\w+\s+перевозк\w*)/i.test(text)) return 'sea';
  if (/(авиа\w*|air\s*freight|самол[её]т\w*)/i.test(text)) return 'air';
  if (/(таможен\w*|customs|растаможк\w*)/i.test(text)) return 'customs';
  if (/(автотранспорт\w*|автоперевозк\w*|низкорамн\w+\s+трал|тягач|фур[ау])/i.test(text)) return 'auto';
  return undefined;
}
