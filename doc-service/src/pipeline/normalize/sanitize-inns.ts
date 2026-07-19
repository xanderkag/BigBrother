/**
 * F0e: санитизация ИНН сторон прямо в `extracted` (не только в проекции
 * `_normalized_fields`).
 *
 * Находка SLAI 2026-07-17: у одного контрагента («Ист-Вест Лоджистик»,
 * канонический ИНН 7811595513) в разных документах ИНН «плывёт» — ~25 вариантов
 * (7811595573, 7811593513, 193318, 781595513…), ВСЕ из tesseract (растровый OCR
 * сканов; цифры 5↔9, 3↔9 и обрезка длины). SLAI читает сырой `extracted.*.inn`
 * → вместо одной карточки контрагента плодятся дубли.
 *
 * Причина: F1 (normalizeExtractedFields) канонизирует ИНН ТОЛЬКО в
 * `_normalized_fields`, а сырой в `extracted` оставляет («пусть matcher
 * fuzzy-match»). Для OCR-дрейфа это backfire: битый по checksum ИНН не
 * fuzzy-матчится, а плодит новый фейковый ключ.
 *
 * Контракт:
 *   - Валидный ИНН (normalizeInn ≠ null) → пишем КАНОНИЧЕСКУЮ форму в extracted
 *     (без пробелов/дефисов) — SLAI получает единый вид.
 *   - Битый по длине/контрольной сумме → зануляем (лучше «нет ИНН, есть имя»,
 *     чем ЧУЖОЙ фейковый номер: у SLAI имя + их ЕГРЮЛ-проверка сведут в одну
 *     карточку, а фейк плодит дубль). Что выкинули — в `_inn_dropped` (аудит).
 *   - Валидный-но-неверный (чужой ИНН группы компаний) НЕ трогаем — checksum
 *     его пропускает; это отдельная задача (сверка имя↔ИНН через DaData).
 *   - Pure / идемпотентна.
 */
import { normalizeInn } from './identifiers.js';

// Все стороны первички + ВЭД (client/expeditor — forwarding_order).
const INN_PARTIES: readonly string[] = [
  'seller',
  'buyer',
  'shipper',
  'consignee',
  'carrier',
  'payer',
  'recipient',
  'client',
  'expeditor',
];

export function sanitizePartyInns(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  const canonicalized: Record<string, string> = {}; // party → канон-ИНН
  const dropped: Record<string, string> = {}; // party.inn → выкинутое сырьё

  for (const party of INN_PARTIES) {
    const obj = extracted[party];
    if (!obj || typeof obj !== 'object') continue;
    const raw = (obj as Record<string, unknown>).inn;
    if (raw === undefined || raw === null || raw === '') continue;

    const canonical = normalizeInn(raw);
    if (canonical !== null) {
      // Валидный: канонизируем, если форма отличается от сырья.
      if (canonical !== raw) canonicalized[party] = canonical;
    } else {
      // Битый по длине/контрольной сумме: зануляем.
      dropped[`${party}.inn`] = String(raw);
    }
  }

  if (Object.keys(canonicalized).length === 0 && Object.keys(dropped).length === 0) {
    return extracted;
  }

  // Иммутабельно: клонируем верх + только затронутые party-объекты.
  const next: Record<string, unknown> = { ...extracted };
  const touched = new Set<string>([
    ...Object.keys(canonicalized),
    ...Object.keys(dropped).map((k) => k.split('.')[0]!),
  ]);
  for (const party of touched) {
    const partyObj = { ...(next[party] as Record<string, unknown>) };
    if (canonicalized[party] !== undefined) partyObj.inn = canonicalized[party];
    if (dropped[`${party}.inn`] !== undefined) partyObj.inn = null;
    next[party] = partyObj;
  }
  if (Object.keys(dropped).length > 0) {
    const prev = (extracted._inn_dropped as Record<string, string>) ?? {};
    next._inn_dropped = { ...prev, ...dropped };
  }
  return next;
}
