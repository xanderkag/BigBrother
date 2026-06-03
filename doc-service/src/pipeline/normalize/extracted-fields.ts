/**
 * Применяет identifier-normalizers к известным полям внутри `extracted`.
 *
 * Контракт:
 *   - Запускается ПОСЛЕ парсера и ДО validation. Validation должен видеть
 *     уже нормализованный ИНН/госномер чтобы checksum-проверка не падала
 *     на форматированных значениях («ИНН: 7728-168-971»).
 *   - Идемпотентна.
 *   - Если нормализация не удалась — оставляет оригинальное значение
 *     (validation отдельно ругнётся через validateInn). Это лучше чем null:
 *     SLAI matcher хотя бы увидит сырую строку и сможет fuzzy-match.
 *   - В результат добавляет `_normalized_fields: { 'seller.inn': '...', 'vehicle.plate': '...' }`
 *     — это явный отдельный канал для интеграторов которым нужны exact-match
 *     значения, а оригинальные строки оставляем для отображения в UI.
 *
 * Покрытые пути:
 *   - `seller.inn` / `buyer.inn` / `shipper.inn` / `consignee.inn` /
 *     `carrier.inn` / `payer.inn` / `recipient.inn`
 *   - `vehicle.plate` / `vehicle.license_plate`
 */
import { normalizeInn, normalizePlate } from './identifiers.js';

const INN_PATHS: ReadonlyArray<readonly string[]> = [
  ['seller', 'inn'],
  ['buyer', 'inn'],
  ['shipper', 'inn'],
  ['consignee', 'inn'],
  ['carrier', 'inn'],
  ['payer', 'inn'],
  ['recipient', 'inn'],
];

const PLATE_PATHS: ReadonlyArray<readonly string[]> = [
  ['vehicle', 'plate'],
  ['vehicle', 'license_plate'],
];

function getByPath(obj: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function normalizeExtractedFields(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  const normalizedMap: Record<string, string> = {};

  for (const path of INN_PATHS) {
    const raw = getByPath(extracted, path);
    if (raw === undefined || raw === null) continue;
    const normalized = normalizeInn(raw);
    if (normalized !== null) {
      normalizedMap[path.join('.')] = normalized;
    }
  }

  for (const path of PLATE_PATHS) {
    const raw = getByPath(extracted, path);
    if (raw === undefined || raw === null) continue;
    const normalized = normalizePlate(raw);
    if (normalized !== null) {
      normalizedMap[path.join('.')] = normalized;
    }
  }

  // EXT-LINE-3 (SLAI 2026-06-03 P0): идентификаторы для SLAI matcher.
  // order_ref / permit_no — uppercase + trim. route.from/to_canonical —
  // простая нормализация (убрать «г.», убрать запятые/адрес после города).
  const orderRef = extracted.order_ref;
  if (typeof orderRef === 'string' && orderRef.trim().length > 0) {
    normalizedMap['order_ref'] = orderRef.trim().toUpperCase();
  }
  const permitNo = extracted.permit_no;
  if (typeof permitNo === 'string' && permitNo.trim().length > 0) {
    normalizedMap['permit_no'] = permitNo.trim();
  }
  // route.from / route.to → from_canonical / to_canonical
  const canonCity = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    // Убрать «г.»/«г »/«город», запятые с адресом после, лишние пробелы.
    const cleaned = raw
      .replace(/^\s*(?:г\.?|город)\s+/i, '')
      .split(/[,(]/)[0]!
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  };
  const rFrom = canonCity(extracted.route_from);
  if (rFrom) normalizedMap['route.from_canonical'] = rFrom;
  const rTo = canonCity(extracted.route_to);
  if (rTo) normalizedMap['route.to_canonical'] = rTo;
  // Также если есть transport.route.from/to — берём оттуда (для LLM-fallback'а)
  const transport = extracted.transport as Record<string, unknown> | undefined;
  const tRoute = transport?.route as Record<string, unknown> | undefined;
  if (tRoute && !normalizedMap['route.from_canonical']) {
    const f = canonCity(tRoute.from);
    if (f) normalizedMap['route.from_canonical'] = f;
  }
  if (tRoute && !normalizedMap['route.to_canonical']) {
    const t = canonCity(tRoute.to);
    if (t) normalizedMap['route.to_canonical'] = t;
  }

  if (Object.keys(normalizedMap).length === 0) return extracted;

  return {
    ...extracted,
    _normalized_fields: normalizedMap,
  };
}
