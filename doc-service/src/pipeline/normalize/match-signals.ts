/**
 * Канонический FLAT match-signals projection (SLAI PD-CONTRACT-1 §2.1).
 *
 * Кладёт в `extracted._match_signals` стабильный плоский набор кросс-типовых
 * ключей, чтобы SLAI matcher не лазил по per-type вложенным полям. Запускается
 * в normalize pipeline (после F1/F7/F6) — результат попадает и в БД, и в
 * webhook payload (внутри `extracted`).
 *
 * Правила контракта:
 *   - `schema_version: "1.0"` — всегда.
 *   - present-only: ключ присутствует ТОЛЬКО если у документа есть значение.
 *     Никаких пустых строк / [] / null в выходе (исключение —
 *     `schema_version`). Пустой объект/массив выкидываем целиком.
 *   - additive namespace `_match_signals` — не пересекается с per-type полями.
 *
 * Per-type мапа декларативная (PROJECTORS), расширяется добавлением записи.
 * Неизвестный тип → только generic fallback. document_type приводим к
 * outbound snake_case (normalizeSlugForApi) чтобы ключевать таблицу
 * канонически (внутри pipeline слаги ещё исторические — TTN/factInvoice).
 *
 * order_refs (SLAI Q2 — #1 match-signal после контейнера): собираем из нового
 * top-level `order_refs[]` (модель заполняет по schema-описанию любой
 * «Заказ №»/«Order Ref»/«Our ref»/PO), плюс legacy `order_ref`/`order_number`
 * и per-line `items[]`/`positions[].order_ref`. Flatten + dedupe, present-only
 * (НЕ выдумываем — пустой → ключ отсутствует).
 */
import { normalizePlate } from './identifiers.js';
import { normalizeSlugForApi } from '../../types/slug-normalize.js';

export const MATCH_SIGNALS_SCHEMA_VERSION = '1.0';

const ISO6346_RE = /^[A-Z]{4}\d{7}$/;

interface Party {
  name?: string;
  inn?: string;
  kpp?: string;
}

interface Vehicle {
  plate?: string;
  trailer?: string;
}

export interface MatchSignals {
  schema_version: string;
  containers?: string[];
  bl_number?: string;
  cmr_number?: string;
  ttn_number?: string;
  awb_number?: string;
  declaration_numbers?: string[];
  order_refs?: string[];
  vehicle?: Vehicle;
  parties?: Record<string, Party>;
  dates?: Record<string, string>;
  totals?: { amount?: number; currency?: string; vat?: number };
  /** §2.3 confidence для канонических ключей, если доступен из _field_confidence */
  _confidence?: Record<string, number>;
}

type Extracted = Record<string, unknown>;

// ── present-only helpers ──────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(n) && v.trim().length > 0) return n;
  }
  return undefined;
}

function obj(v: unknown): Extracted | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Extracted)
    : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** Собирает Party из исходного объекта стороны (present-only). undefined если пусто. */
function party(v: unknown): Party | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const p: Party = {};
  const name = str(o.name);
  const inn = str(o.inn);
  const kpp = str(o.kpp);
  if (name) p.name = name;
  if (inn) p.inn = inn;
  if (kpp) p.kpp = kpp;
  return Object.keys(p).length > 0 ? p : undefined;
}

/** Уникальные непустые строки, .trim(); сохраняет порядок. [] → undefined. */
function uniqStrings(values: Array<string | undefined>): string[] | undefined {
  const out: string[] = [];
  for (const v of values) {
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

// ── Projector context: накапливает части сигнала declarative-стилем ────────

interface Ctx {
  ex: Extracted;
  out: MatchSignals;
}

function setParty(ctx: Ctx, role: string, value: unknown): void {
  const p = party(value);
  if (!p) return;
  (ctx.out.parties ??= {})[role] = p;
}

function setDate(ctx: Ctx, key: string, value: unknown): void {
  const d = str(value);
  if (!d) return;
  (ctx.out.dates ??= {})[key] = d;
}

function setVehicle(ctx: Ctx, plateRaw: unknown, trailerRaw: unknown): void {
  const plateStr = str(plateRaw);
  // Нормализуем госномер тем же канонизатором что и field-confidence/F1,
  // но при неудаче отдаём исходную строку — SLAI хотя бы fuzzy-сматчит.
  const plate = plateStr ? normalizePlate(plateStr) ?? plateStr : undefined;
  const trailer = str(trailerRaw);
  if (!plate && !trailer) return;
  const v: Vehicle = {};
  if (plate) v.plate = plate;
  if (trailer) v.trailer = trailer;
  ctx.out.vehicle = v;
}

function setTotals(
  ctx: Ctx,
  amount: unknown,
  currency: unknown,
  vat: unknown,
): void {
  const a = num(amount);
  const c = str(currency);
  const v = num(vat);
  if (a === undefined && c === undefined && v === undefined) return;
  const t: NonNullable<MatchSignals['totals']> = {};
  if (a !== undefined) t.amount = a;
  if (c !== undefined) t.currency = c;
  if (v !== undefined) t.vat = v;
  ctx.out.totals = t;
}

/** ISO-6346 номера контейнеров из BL containers[].number / items[].container_no. */
function collectContainers(ex: Extracted): string[] | undefined {
  const nums: Array<string | undefined> = [];
  for (const c of arr(ex.containers) ?? []) {
    const o = obj(c);
    if (o) nums.push(str(o.number) ?? str(o.container_number));
  }
  for (const it of arr(ex.items) ?? []) {
    const o = obj(it);
    if (o) nums.push(str(o.container_no));
  }
  const top = str(ex.container_number) ?? str(obj(ex.container)?.number);
  if (top) nums.push(top);
  // Нормализуем к upper для ISO-6346 проверки, но в выход кладём как есть
  // (после .trim()) если совпало с маской.
  const matched = nums
    .map((n) => (n ? n.replace(/\s/g, '').toUpperCase() : undefined))
    .filter((n): n is string => !!n && ISO6346_RE.test(n));
  return uniqStrings(matched);
}

/**
 * order_refs из всех источников (PD-CONTRACT-1 Q2): новый top-level
 * `order_refs[]` (массив строк, который модель заполняет по schema-описанию),
 * плюс doc-level `order_ref`/`order_number`, плюс per-line
 * `items[]`/`positions[].order_ref`. Flatten + trim + dedupe, present-only.
 */
function collectOrderRefs(ex: Extracted): string[] | undefined {
  const refs: Array<string | undefined> = [];
  for (const v of arr(ex.order_refs) ?? []) refs.push(str(v));
  refs.push(str(ex.order_ref), str(ex.order_number));
  for (const it of [...(arr(ex.items) ?? []), ...(arr(ex.positions) ?? [])]) {
    const o = obj(it);
    if (o) refs.push(str(o.order_ref));
  }
  return uniqStrings(refs);
}

// ── Per-type projectors ────────────────────────────────────────────────────
// Каждый — мутирует ctx.out через set*-хелперы. Generic fallback всегда
// применяется первым; per-type добивает специфику и уточняет общие поля.

type Projector = (ctx: Ctx) => void;

function genericFallback(ctx: Ctx): void {
  const { ex } = ctx;
  setParty(ctx, 'seller', ex.seller);
  setParty(ctx, 'buyer', ex.buyer);
  setDate(ctx, 'document', ex.date);
  setTotals(ctx, ex.total ?? ex.total_with_vat ?? ex.total_amount, ex.currency, ex.vat);
  const orderRefs = collectOrderRefs(ex);
  if (orderRefs) ctx.out.order_refs = orderRefs;
}

const PROJECTORS: Record<string, Projector> = {
  bill_of_lading: (ctx) => {
    const { ex } = ctx;
    // Активная BL_SCHEMA — плоская (number/containers/...), но прежний DB-снимок
    // использовал bl_number / containers[].container_number → поддерживаем оба.
    const bl = obj(ex.bl);
    const blNumber = str(ex.number) ?? str(ex.bl_number) ?? str(bl?.number);
    if (blNumber) ctx.out.bl_number = blNumber;
    const containers = collectContainers(ex);
    if (containers) ctx.out.containers = containers;
    setParty(ctx, 'shipper', ex.shipper);
    setParty(ctx, 'consignee', ex.consignee);
    setParty(ctx, 'notify_party', ex.notify_party);
    setDate(ctx, 'document', ex.date);
    setDate(ctx, 'shipped_on_board', ex.shipped_on_board);
  },

  ttn: (ctx) => {
    const { ex } = ctx;
    const ttnNumber = str(ex.number);
    if (ttnNumber) ctx.out.ttn_number = ttnNumber;
    const vehicle = obj(ex.vehicle);
    setVehicle(ctx, vehicle?.plate, vehicle?.trailer_plate ?? vehicle?.trailer);
    setParty(ctx, 'shipper', ex.shipper);
    setParty(ctx, 'consignee', ex.consignee);
    setParty(ctx, 'carrier', ex.carrier);
    setDate(ctx, 'document', ex.date);
    const containers = collectContainers(ex);
    if (containers) ctx.out.containers = containers;
  },

  transport_invoice: (ctx) => {
    const { ex } = ctx;
    const ttnNumber = str(ex.number);
    if (ttnNumber) ctx.out.ttn_number = ttnNumber;
    const vehicle = obj(ex.vehicle);
    setVehicle(ctx, vehicle?.plate, vehicle?.trailer_plate);
    setParty(ctx, 'shipper', ex.shipper);
    setParty(ctx, 'consignee', ex.consignee);
    setParty(ctx, 'carrier', ex.carrier);
    setParty(ctx, 'forwarder', ex.forwarder);
    setDate(ctx, 'document', ex.date);
  },

  cmr: (ctx) => {
    const { ex } = ctx;
    const cmrNumber = str(ex.number);
    if (cmrNumber) ctx.out.cmr_number = cmrNumber;
    const vehicle = obj(ex.vehicle);
    setVehicle(ctx, vehicle?.plate, vehicle?.trailer_plate);
    // consignor/consignee + legacy sender/recipient алиасы.
    setParty(ctx, 'shipper', ex.consignor ?? ex.sender);
    setParty(ctx, 'consignee', ex.consignee ?? ex.recipient);
    setParty(ctx, 'carrier', ex.carrier);
    setDate(ctx, 'document', ex.date);
  },

  invoice: (ctx) => {
    const { ex } = ctx;
    setParty(ctx, 'seller', ex.seller);
    setParty(ctx, 'buyer', ex.buyer);
    setTotals(ctx, ex.total ?? ex.total_with_vat, ex.currency, ex.vat);
    setDate(ctx, 'document', ex.date);
    const orderRefs = collectOrderRefs(ex);
    if (orderRefs) ctx.out.order_refs = orderRefs;
    const vehicle = obj(ex.vehicle);
    if (vehicle) setVehicle(ctx, vehicle.plate, vehicle.trailer);
  },

  wire_transfer_application: (ctx) => {
    const { ex } = ctx;
    // refined schema — плоские sender_*/beneficiary_* поля.
    setParty(ctx, 'payer', {
      name: ex.sender_name ?? obj(ex.sender)?.name,
      inn: ex.sender_inn ?? obj(ex.sender)?.inn,
    });
    setParty(ctx, 'payee', {
      name: ex.beneficiary_name ?? obj(ex.beneficiary)?.name,
    });
    setTotals(ctx, ex.amount, ex.currency, undefined);
    setDate(ctx, 'document', ex.date);
  },

  payment_order: (ctx) => {
    const { ex } = ctx;
    setParty(ctx, 'payer', ex.payer);
    setParty(ctx, 'payee', ex.payee);
    setTotals(ctx, ex.amount, ex.currency, undefined);
    setDate(ctx, 'document', ex.date);
  },

  customs_declaration: (ctx) => {
    const { ex } = ctx;
    const declNum = str(ex.declaration_number);
    if (declNum) ctx.out.declaration_numbers = [declNum];
    setParty(ctx, 'seller', ex.sender);
    setParty(ctx, 'buyer', ex.recipient);
    setTotals(ctx, ex.total_value, ex.currency, undefined);
    setDate(ctx, 'document', ex.date);
  },

  weighing_act: (ctx) => {
    const { ex } = ctx;
    const containers = collectContainers(ex);
    if (containers) ctx.out.containers = containers;
    setDate(ctx, 'document', ex.date);
  },
};

// invoice-семейство шарит проектор.
PROJECTORS.tax_invoice = PROJECTORS.invoice!;
PROJECTORS.upd = PROJECTORS.invoice!;
PROJECTORS.commercial_invoice = PROJECTORS.invoice!;
PROJECTORS.proforma_invoice = PROJECTORS.invoice!;

// ── §2.3 confidence для канонических ключей ────────────────────────────────
// Источник — `_field_confidence` (LLM-map, dotted source-paths) который ещё
// присутствует в extracted на этом шаге (webhook-delivery вытащит его позже).
// Мапим source-path → canonical key только для уже присутствующих сигналов.

const CONFIDENCE_SOURCES: Record<string, readonly string[]> = {
  bl_number: ['number', 'bl_number', 'bl.number'],
  ttn_number: ['number'],
  cmr_number: ['number'],
  declaration_numbers: ['declaration_number'],
  containers: ['containers.0.number', 'containers', 'container_number'],
  'vehicle.plate': ['vehicle.plate'],
  'totals.amount': ['total', 'total_with_vat', 'total_amount', 'amount'],
  'parties.seller': ['seller.inn'],
  'parties.buyer': ['buyer.inn'],
  'parties.shipper': ['shipper.inn'],
  'parties.consignee': ['consignee.inn'],
  'parties.carrier': ['carrier.inn'],
  'dates.document': ['date'],
};

function buildConfidence(
  out: MatchSignals,
  fieldConfidence: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!fieldConfidence || Object.keys(fieldConfidence).length === 0) return undefined;
  const conf: Record<string, number> = {};
  for (const [canonical, sources] of Object.entries(CONFIDENCE_SOURCES)) {
    // Только для реально присутствующих в out сигналов.
    if (!signalPresent(out, canonical)) continue;
    for (const src of sources) {
      const v = fieldConfidence[src];
      if (typeof v === 'number') {
        conf[canonical] = v;
        break;
      }
    }
  }
  return Object.keys(conf).length > 0 ? conf : undefined;
}

function signalPresent(out: MatchSignals, canonical: string): boolean {
  if (canonical === 'vehicle.plate') return !!out.vehicle?.plate;
  if (canonical === 'totals.amount') return out.totals?.amount !== undefined;
  if (canonical === 'dates.document') return out.dates?.document !== undefined;
  if (canonical.startsWith('parties.')) return !!out.parties?.[canonical.slice('parties.'.length)];
  return (out as unknown as Record<string, unknown>)[canonical] !== undefined;
}

/**
 * Строит canonical FLAT match-signals для документа.
 *
 * @param documentType внутренний slug (исторический TTN/factInvoice ОК —
 *        приводится к outbound snake_case внутри).
 * @param extracted извлечённые поля документа (после F1/F7/F6 normalize).
 * @param fieldConfidence опц. LLM field-confidence map (dotted source-paths);
 *        обычно `extracted._field_confidence`. Если задан и непустой —
 *        наполняем `_match_signals._confidence`.
 * @returns объект с present-only ключами + `schema_version`. Никогда не null.
 */
export function buildMatchSignals(
  documentType: string | null,
  extracted: Extracted | null,
  fieldConfidence?: Record<string, number>,
): MatchSignals {
  const out: MatchSignals = { schema_version: MATCH_SIGNALS_SCHEMA_VERSION };
  if (!extracted || typeof extracted !== 'object') return out;

  const ctx: Ctx = { ex: extracted, out };

  // Generic fallback первым — даёт seller/buyer/totals/date/order_refs из
  // плоских полей. Per-type проектор затем добивает и уточняет специфику.
  genericFallback(ctx);

  const canonicalType = documentType ? normalizeSlugForApi(documentType) : null;
  const projector = canonicalType ? PROJECTORS[canonicalType] : undefined;
  if (projector) projector(ctx);

  const fc =
    fieldConfidence ??
    (obj(extracted._field_confidence) as Record<string, number> | undefined);
  const conf = buildConfidence(out, fc);
  if (conf) out._confidence = conf;

  return out;
}
