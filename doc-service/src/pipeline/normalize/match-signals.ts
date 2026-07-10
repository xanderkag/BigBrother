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

// 1.2 (SLAI 2026-07-10): + container_details[] (пер-контейнерный вес/объём/
// места). Аддитивно — MINOR-bump по политике Q17 (SLAI логирует, не гейтит).
export const MATCH_SIGNALS_SCHEMA_VERSION = '1.2';

interface Party {
  name?: string;
  inn?: string;
  kpp?: string;
}

interface Vehicle {
  plate?: string;
  trailer?: string;
}

/** Пер-контейнерная разбивка веса/объёма/мест (SLAI 2026-07-10). */
export interface ContainerDetail {
  number: string;
  gross_weight_kg?: number;
  net_weight_kg?: number;
  volume_m3?: number;
  packages?: number;
}

export interface MatchSignals {
  schema_version: string;
  containers?: string[];
  /**
   * Богатая пер-контейнерная разбивка (SLAI 2026-07-10): вес/объём/места
   * по КАЖДОМУ контейнеру, когда в документе есть табличка «по контейнерам»
   * (пакинг-лист / контейнерная разбивка коносамента). Аддитивно к
   * `containers` (тот остаётся string[] для back-compat). Present-only:
   * эмитим только если хотя бы у одного контейнера есть вес/объём/места —
   * иначе SLAI берёт номера из `containers`. Нужно для сверки
   * «Σ по контейнерам = итог заказа = итог ГТД».
   */
  container_details?: ContainerDetail[];
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
  /**
   * Стадия документа (schema 1.1). ВСЕГДА присутствует (единственное исключение
   * из present-only, наравне с schema_version). SLAI трактует отсутствие как
   * final — эмитим всегда чтобы убрать неоднозначность. См. computeDocumentStage.
   */
  document_stage?: 'draft' | 'proforma' | 'final';
  release_type?: 'original' | 'telex_release' | 'seaway_waybill' | 'surrendered';
  bl_type?: 'Master' | 'House' | 'Sea Waybill';
  master_bl_number?: string;
  number_of_original_bls?: number;
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

// ── schema 1.1: document_stage / release_type / bl_type ────────────────────

/**
 * Стадия документа (schema 1.1). ВСЕГДА возвращает значение (default final).
 * proforma_invoice → 'proforma' по типу; иначе читаем LLM-маркер
 * `ex.document_stage` (draft/proforma/final по подстроке); нет маркера → final.
 * SLAI трактует отсутствие поля как final — мы всегда эмитим явно.
 */
function computeDocumentStage(
  canonicalType: string | null,
  ex: Extracted,
): 'draft' | 'proforma' | 'final' {
  if (canonicalType === 'proforma_invoice') return 'proforma';
  const marker = str(ex.document_stage)?.toLowerCase();
  if (marker) {
    if (marker.includes('draft')) return 'draft';
    if (marker.includes('proforma')) return 'proforma';
    if (marker.includes('final')) return 'final';
  }
  return 'final';
}

/** Нормализует bl_type к канону SLAI. Неизвестное → undefined (present-only). */
function normalizeBlType(
  v: string | undefined,
): 'Master' | 'House' | 'Sea Waybill' | undefined {
  const t = v?.toLowerCase();
  if (!t) return undefined;
  if (t.includes('master')) return 'Master';
  if (t.includes('house') || t.includes('hbl')) return 'House';
  if (
    t.includes('sea waybill') ||
    t.includes('seaway') ||
    t.includes('swb') ||
    t.includes('waybill')
  ) {
    return 'Sea Waybill';
  }
  return undefined;
}

/**
 * Нормализует release_type. Если явный маркер (v) есть — мапим его. Если нет —
 * выводим 'original' ТОЛЬКО когда число оригиналов >= 1 (present-only: не
 * угадываем telex при неизвестном).
 */
function normalizeReleaseType(
  v: string | undefined,
  originals: unknown,
): 'original' | 'telex_release' | 'seaway_waybill' | 'surrendered' | undefined {
  const t = v?.toLowerCase();
  if (t) {
    if (t.includes('telex')) return 'telex_release';
    if (t.includes('surrender')) return 'surrendered';
    if (t.includes('seaway') || t.includes('sea waybill')) return 'seaway_waybill';
    if (t.includes('original')) return 'original';
    return undefined;
  }
  const n = num(originals);
  if (n !== undefined && Number.isInteger(n) && n >= 1) return 'original';
  return undefined;
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
  // Извлекаем ISO-6346 как ПОДСТРОКУ, а не требуем совпадения всей строки:
  // модель часто приклеивает к номеру тип/размер контейнера
  // («MRKU1234567 40HC», «MRKU123456745G1») — целиком такое маску не проходит,
  // но валидный ISO внутри есть. `[A-Z]{4}\s?\d{7}` допускает один пробел между
  // префиксом и цифрами (OCR «MRKU 1234567»), пробел убираем из результата;
  // `{4}` подряд букв не даёт склеить соседние поля в ложный контейнер.
  const matched = nums.flatMap((n) => {
    if (!n) return [];
    const hits = n.toUpperCase().match(/[A-Z]{4}\s?\d{7}/g) ?? [];
    return hits.map((h) => h.replace(/\s/g, ''));
  });
  return uniqStrings(matched);
}

/** Извлекает ISO-6346 номер контейнера как подстроку (та же логика, что в
 * collectContainers, но для одного значения). null если валидного нет. */
function extractIso6346(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  const hit = s.toUpperCase().match(/[A-Z]{4}\s?\d{7}/)?.[0];
  return hit ? hit.replace(/\s/g, '') : null;
}

/**
 * Пер-контейнерная разбивка (SLAI 2026-07-10): собирает вес/объём/места
 * ПО КАЖДОМУ контейнеру из `containers[]`, когда модель заполнила их
 * (табличка «по контейнерам» в пакинге/коносаменте). Present-only:
 * возвращает undefined если ни у одного контейнера нет ни веса, ни объёма,
 * ни мест — в этом случае SLAI берёт номера из плоского `containers`.
 *
 * Дедуп по номеру: если один контейнер встретился дважды, берём первую
 * запись с непустыми метриками.
 */
function collectContainerDetails(ex: Extracted): ContainerDetail[] | undefined {
  const byNumber = new Map<string, ContainerDetail>();
  for (const c of arr(ex.containers) ?? []) {
    const o = obj(c);
    if (!o) continue;
    const number = extractIso6346(o.number) ?? extractIso6346(o.container_number);
    if (!number) continue;
    const gross = num(o.gross_weight_kg) ?? num(o.gross_weight) ?? num(o.weight_gross);
    const net = num(o.net_weight_kg) ?? num(o.net_weight) ?? num(o.weight_net);
    const volume = num(o.volume_m3) ?? num(o.volume);
    const packages = num(o.packages) ?? num(o.places) ?? num(o.packages_count);
    // Пропускаем контейнеры без единой метрики — они уже в плоском containers.
    if (gross === undefined && net === undefined && volume === undefined && packages === undefined) {
      continue;
    }
    if (byNumber.has(number)) continue; // первая запись с метриками выигрывает
    byNumber.set(number, {
      number,
      ...(gross !== undefined ? { gross_weight_kg: gross } : {}),
      ...(net !== undefined ? { net_weight_kg: net } : {}),
      ...(volume !== undefined ? { volume_m3: volume } : {}),
      ...(packages !== undefined ? { packages } : {}),
    });
  }
  return byNumber.size > 0 ? [...byNumber.values()] : undefined;
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

/**
 * Проецирует контейнеры в оба сигнала: плоский `containers` (string[],
 * back-compat) и богатый `container_details[]` (present-only, только когда
 * есть пер-контейнерный вес/объём/места). Единый хелпер для всех типов с
 * контейнерами (BL/TTN/CMR/AKT/commercial_invoice/packing_list) — чтобы
 * пер-контейнерная разбивка не разъезжалась между проекторами.
 */
function setContainerSignals(ctx: Ctx, ex: Extracted): void {
  const containers = collectContainers(ex);
  if (containers) ctx.out.containers = containers;
  const details = collectContainerDetails(ex);
  if (details) ctx.out.container_details = details;
}

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
    // Активная BL_SCHEMA — плоская (number/containers[].number). Прежний DB-снимок
    // (bl_number / containers[].container_number / nested bl) обнулён миграцией
    // 20260604000001 и не эмитится ни схемой, ни pipeline (PD-CONTRACT-1).
    const blNumber = str(ex.number);
    if (blNumber) ctx.out.bl_number = blNumber;
    setContainerSignals(ctx, ex);
    setParty(ctx, 'shipper', ex.shipper);
    setParty(ctx, 'consignee', ex.consignee);
    setParty(ctx, 'notify_party', ex.notify_party);
    setDate(ctx, 'document', ex.date);
    setDate(ctx, 'shipped_on_board', ex.shipped_on_board);
    // schema 1.1: тип BL / master-link / состояние выпуска / число оригиналов.
    const blType = normalizeBlType(str(ex.bl_type));
    if (blType) ctx.out.bl_type = blType;
    // master link: у Master нет родителя → master_bl_number на Master ОМИТ.
    // Нормализуем ТЕМ ЖЕ str() что и bl_number (trim), без доп. канонизации.
    // Условие `!== 'Master'` НАМЕРЕННО ловит и blType===undefined (тип BL не
    // распознан): если модель не дала bl_type, но заполнила master_bl_number —
    // это почти всегда House с непрочитанным типом, master-линк осмыслен.
    // Сузить до `=== 'House'` регрессировало бы (потеря линка при пустом
    // bl_type). Ложный Master-номер тут не пройдёт: schema-промпт явно
    // запрещает заполнять master_bl_number на самом Master B/L.
    if (blType !== 'Master') {
      const m = str(ex.master_bl_number);
      if (m) ctx.out.master_bl_number = m;
    }
    const rel = normalizeReleaseType(str(ex.release_type), ex.number_of_original_bls);
    if (rel) ctx.out.release_type = rel;
    const nob = num(ex.number_of_original_bls);
    if (nob !== undefined && Number.isInteger(nob)) ctx.out.number_of_original_bls = nob;
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
    setContainerSignals(ctx, ex);
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
    setContainerSignals(ctx, ex);
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

  // packing_list — главный источник пер-контейнерной разбивки (SLAI
  // 2026-07-10): вес/объём/места по контейнерам. Проецируем containers +
  // container_details (если модель заполнила разбивку по containers[]).
  // container_number (одиночный, top-level) тоже подхватывается через
  // collectContainers внутри helper'а.
  packing_list: (ctx) => {
    const { ex } = ctx;
    setParty(ctx, 'seller', ex.exporter ?? ex.seller);
    setParty(ctx, 'buyer', ex.consignee ?? ex.buyer);
    setDate(ctx, 'document', ex.date);
    const orderRefs = collectOrderRefs(ex);
    if (orderRefs) ctx.out.order_refs = orderRefs;
    setContainerSignals(ctx, ex);
  },

  // commercial_invoice — логика invoice + контейнеры (Q16). У КИ есть
  // containers[] в схеме (commercial_invoice ↔ B/L ↔ packing_list ↔ ГТД
  // линкуются по ISO-6346), поэтому в отличие от обычного invoice проецируем
  // containers через тот же collectContainers, что и B/L/TTN/CMR/AKT.
  commercial_invoice: (ctx) => {
    const { ex } = ctx;
    setParty(ctx, 'seller', ex.seller);
    setParty(ctx, 'buyer', ex.buyer);
    setTotals(ctx, ex.total ?? ex.total_with_vat, ex.currency, ex.vat);
    setDate(ctx, 'document', ex.date);
    const orderRefs = collectOrderRefs(ex);
    if (orderRefs) ctx.out.order_refs = orderRefs;
    const vehicle = obj(ex.vehicle);
    if (vehicle) setVehicle(ctx, vehicle.plate, vehicle.trailer);
    setContainerSignals(ctx, ex);
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
    setContainerSignals(ctx, ex);
    setDate(ctx, 'document', ex.date);
  },

  // Акт оказанных услуг (AKT → outbound `services_act`). Схема использует
  // party_a (Исполнитель) / party_b (Заказчик), поэтому generic fallback
  // (seller/buyer) их не подхватывает. Проецируем под канонические для SLAI
  // роли: executor (исполнитель) + customer (заказчик). Доп. fallback на
  // прямые executor/customer на случай иной модели.
  services_act: (ctx) => {
    const { ex } = ctx;
    setParty(ctx, 'executor', ex.party_a ?? ex.executor);
    setParty(ctx, 'customer', ex.party_b ?? ex.customer);
    setDate(ctx, 'document', ex.date);
    setContainerSignals(ctx, ex);
  },
};

// invoice-семейство шарит проектор (commercial_invoice — свой, с контейнерами).
PROJECTORS.tax_invoice = PROJECTORS.invoice!;
PROJECTORS.upd = PROJECTORS.invoice!;
PROJECTORS.proforma_invoice = PROJECTORS.invoice!;

// ── §2.3 confidence для канонических ключей ────────────────────────────────
// Источник — `_field_confidence` (LLM-map, dotted source-paths) который ещё
// присутствует в extracted на этом шаге (webhook-delivery вытащит его позже).
// Мапим source-path → canonical key только для уже присутствующих сигналов.

const CONFIDENCE_SOURCES: Record<string, readonly string[]> = {
  bl_number: ['number'],
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
  'parties.executor': ['party_a.inn'],
  'parties.customer': ['party_b.inn'],
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
  const canonicalType = documentType ? normalizeSlugForApi(documentType) : null;
  if (!extracted || typeof extracted !== 'object') {
    // document_stage ВСЕГДА присутствует даже без extracted (см. ниже).
    out.document_stage = computeDocumentStage(canonicalType, {});
    return out;
  }

  const ctx: Ctx = { ex: extracted, out };

  // Generic fallback первым — даёт seller/buyer/totals/date/order_refs из
  // плоских полей. Per-type проектор затем добивает и уточняет специфику.
  genericFallback(ctx);

  const projector = canonicalType ? PROJECTORS[canonicalType] : undefined;
  if (projector) projector(ctx);

  // schema 1.1: document_stage — ЕДИНСТВЕННОЕ исключение из present-only
  // (наравне со schema_version): ВСЕГДА присутствует. SLAI трактует отсутствие
  // как final; мы эмитим явно чтобы убрать неоднозначность (draft vs final).
  out.document_stage = computeDocumentStage(canonicalType, extracted);

  const fc =
    fieldConfidence ??
    (obj(extracted._field_confidence) as Record<string, number> | undefined);
  const conf = buildConfidence(out, fc);
  if (conf) out._confidence = conf;

  return out;
}
