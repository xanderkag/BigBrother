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

  if (Object.keys(normalizedMap).length === 0) return extracted;

  return {
    ...extracted,
    _normalized_fields: normalizedMap,
  };
}
