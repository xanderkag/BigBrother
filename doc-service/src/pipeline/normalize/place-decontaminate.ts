/**
 * FIX-F (находки SLAI 2026-07-19, docs/BCTT_EXTRACT_FIXES.md).
 *
 * Место погрузки/разгрузки замусорено ИМЕНЕМ стороны. В графе 3 CMR («место,
 * предназначенное для доставки») физически стоит грузополучатель — название
 * компании + адрес + город. Модель кладёт в `place_of_delivery` всю строку
 * целиком, а не топоним.
 *
 * Улика (заказ #4 OSKAR, `IMG_20231222_125231.jpg`, тип CMR):
 *   place_of_delivery = "LLP MONDELEZ KAZAKHSTAN ALMATY"
 *   consignee.name    = "LLP MONDELEZ KAZAKHSTAN"   ← то же имя утекло в место
 *   → должно быть "ALMATY".
 *
 * Почему дорого потребителю (SLAI): место доставки — ЕДИНСТВЕННЫЙ источник
 * финальной точки маршрута (их правило RTE-4: берём только из гр.3, не из
 * адреса стороны). Имя компании вместо города → точка не приземляется в
 * справочник городов, маршрут спотыкается на самой важной точке.
 *
 * Фикс детерминированный (как ogrn-relocate / inn-recovery): если поле места
 * СОДЕРЖИТ имя связанной стороны — вырезаем имя, оставляем осмысленный остаток
 * (топоним). Имя компании остаётся только в `<party>.name`. Не трогаем поле,
 * если имени в нём нет или после выреза не остаётся внятного места.
 *
 * Pure / идемпотентна. Срез помечается в `_place_decontaminated` (аудит-канал:
 * оператор видит, что топоним добыт из замусоренного поля, а не распознан).
 */

/** Группа: поля места ← имена сторон, которым это место принадлежит. */
const GROUPS: ReadonlyArray<{ placeKeys: readonly string[]; partyKeys: readonly string[] }> = [
  {
    placeKeys: ['place_of_delivery', 'delivery_place'],
    partyKeys: ['consignee', 'recipient'],
  },
  {
    placeKeys: ['place_of_loading', 'loading_place'],
    partyKeys: ['consignor', 'sender', 'shipper'],
  },
];

/**
 * Юр-формы, которыми часто НАЧИНАЕТСЯ имя (RU + EN + типовые пост-советские/EU).
 * Срезаем ведущую форму, чтобы «MONDELEZ KAZAKHSTAN» матчился, когда в имени
 * есть «LLP», а в поле места — нет (или наоборот).
 */
const LEGAL_FORMS = new Set([
  'llp', 'llc', 'ltd', 'inc', 'co', 'plc', 'jsc', 'gmbh', 'ag', 'bv', 'nv',
  'sarl', 'srl', 'spa', 'sia', 'uab', 'ou', 'oü', 'doo', 'kg', 'as', 'oy',
  'ооо', 'оао', 'ао', 'зао', 'пао', 'нао', 'тоо', 'ип', 'чп', 'зат', 'тов',
]);

const SEP_EDGE = /^[\s,;:./\\|\-–—]+|[\s,;:./\\|\-–—]+$/g;

function isLegalForm(token: string): boolean {
  return LEGAL_FORMS.has(token.toLowerCase().replace(/[.,]/g, ''));
}

function stripLegalForm(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1 && isLegalForm(parts[0]!)) return parts.slice(1).join(' ');
  return name.trim();
}

/**
 * Срезать юр-формы по КРАЯМ остатка. После выреза имени по «голому» кандидату
 * (без юр-формы) ведущая форма может осесть в остатке: вырез «MONDELEZ
 * KAZAKHSTAN» из «LLP MONDELEZ KAZAKHSTAN 12» даёт «LLP 12» — не место.
 */
function dropEdgeLegalForms(s: string): string {
  const tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length && isLegalForm(tokens[0]!)) tokens.shift();
  while (tokens.length && isLegalForm(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

/** Остаток после выреза похож на место? Есть буква и длина ≥ 2, и это не юр-форма. */
function isMeaningfulPlace(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (!/[A-Za-zА-Яа-яЁё]/.test(t)) return false;
  if (LEGAL_FORMS.has(t.toLowerCase())) return false;
  return true;
}

/**
 * Вырезать имя стороны из строки места. Возвращает очищенный топоним или null,
 * если имени в поле нет либо внятного остатка не получилось.
 */
export function stripPartyNameFromPlace(place: string, partyName: string): string | null {
  const p = place.trim();
  if (!p) return null;
  // Кандидаты имени: полное + без ведущей юр-формы (оба ≥ 3 симв., иначе матч
  // по короткому токену вроде «AO» испортит нормальные места).
  const seen = new Set<string>();
  const candidates = [partyName.trim(), stripLegalForm(partyName)].filter((n) => {
    const ok = n.length >= 3 && !seen.has(n.toLowerCase());
    seen.add(n.toLowerCase());
    return ok;
  });
  for (const cand of candidates) {
    const idx = p.toLowerCase().indexOf(cand.toLowerCase());
    if (idx < 0) continue;
    const remainder = (p.slice(0, idx) + ' ' + p.slice(idx + cand.length))
      .replace(/\s+/g, ' ')
      .replace(SEP_EDGE, '')
      .trim();
    const place = dropEdgeLegalForms(remainder).replace(SEP_EDGE, '').trim();
    if (isMeaningfulPlace(place)) return place;
  }
  return null;
}

function partyName(extracted: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const party = extracted[k];
    if (party && typeof party === 'object') {
      const name = (party as Record<string, unknown>).name;
      if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    }
  }
  return null;
}

/**
 * Очистить поля места от имени связанной стороны. Возвращает НОВЫЙ объект, если
 * что-то изменилось, иначе исходный (как остальные нормализаторы).
 */
export function decontaminatePlaceFields(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  const cleaned: Record<string, string> = {};
  for (const { placeKeys, partyKeys } of GROUPS) {
    const name = partyName(extracted, partyKeys);
    if (!name) continue;
    for (const pk of placeKeys) {
      const val = extracted[pk];
      if (typeof val !== 'string' || val.trim().length === 0) continue;
      const stripped = stripPartyNameFromPlace(val, name);
      if (stripped !== null && stripped !== val.trim()) cleaned[pk] = stripped;
    }
  }

  if (Object.keys(cleaned).length === 0) return extracted;

  const next: Record<string, unknown> = { ...extracted };
  for (const [k, v] of Object.entries(cleaned)) next[k] = v;
  const prevAudit = (extracted._place_decontaminated as Record<string, string>) ?? {};
  next._place_decontaminated = { ...prevAudit, ...cleaned };
  return next;
}
