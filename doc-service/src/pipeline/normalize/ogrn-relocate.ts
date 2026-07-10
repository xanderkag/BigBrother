/**
 * ОГРН-в-поле-ИНН — детерминированный перенос (2026-07-10).
 *
 * Проблема: LLM (qwen36 и др.) на российских документах кладёт ОГРН
 * (13 цифр) или ОГРНИП (15) в поле `inn` стороны, потому что читает
 * идентификатор рядом с названием и называет его «inn». Промпт +
 * добавление `ogrn`-поля в схему НЕ помогли — модель игнорирует инструкцию.
 *
 * Реальный кейс: 29 из 54 ГТД уходили в needs_review с
 * «ИНН должен быть 10 или 12 цифр, получено 13: 1147847397906» — при том
 * что 1147847397906 это валидный ОГРН, просто в неправильном поле.
 *
 * Детерминированный фикс надёжнее модели: если `inn` содержит РОВНО 13 или
 * 15 цифр (длина ОГРН/ОГРНИП, невозможная для ИНН) И поле `ogrn` пустое —
 * переносим значение в `ogrn`, чистим `inn`. ИНН физически не бывает 13/15
 * цифр, так что ложных срабатываний нет.
 *
 * Работает по всем сторонам во всех типах документов (не только ГТД) —
 * ошибка модели одинаковая везде, где есть российские юрлица.
 *
 * Pure / идемпотентна. Помечает перенос в `_ogrn_relocated` (аудит-канал).
 */

/** Стороны, у которых может быть российский ОГРН в поле inn. */
const PARTY_KEYS = [
  'seller',
  'buyer',
  'sender',
  'recipient',
  'declarant',
  'consignee',
  'shipper',
  'payer',
  'payee',
  'party_a',
  'party_b',
] as const;

/** ОГРН = 13 цифр (юрлицо), ОГРНИП = 15 (ИП). ИНН таких длин не бывает. */
function isOgrnLength(digits: string): boolean {
  return digits.length === 13 || digits.length === 15;
}

/**
 * Переносит 13/15-значный номер из `inn` в `ogrn` для каждой стороны.
 * Возвращает новый объект если что-то перенесено, иначе исходный (===).
 */
export function relocateOgrnFromInn(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted) return extracted;
  // Поддержка `{ data: {...} }` обёртки.
  const isWrapped =
    typeof extracted.data === 'object' &&
    extracted.data !== null &&
    !Array.isArray(extracted.data);
  const target = (isWrapped ? extracted.data : extracted) as Record<string, unknown>;

  let changed = false;
  const relocated: string[] = [];
  const nextTarget: Record<string, unknown> = { ...target };

  for (const key of PARTY_KEYS) {
    const party = nextTarget[key];
    if (typeof party !== 'object' || party === null || Array.isArray(party)) continue;
    const p = party as Record<string, unknown>;
    const innRaw = p.inn;
    if (innRaw === null || innRaw === undefined) continue;
    const digits = String(innRaw).replace(/\D/g, '');
    if (!isOgrnLength(digits)) continue;
    // ogrn уже заполнен непустым — не перетираем, только чистим inn.
    const ogrnEmpty = p.ogrn === null || p.ogrn === undefined || p.ogrn === '';
    nextTarget[key] = {
      ...p,
      inn: null,
      ...(ogrnEmpty ? { ogrn: digits } : {}),
    };
    changed = true;
    relocated.push(key);
  }

  if (!changed) return extracted;

  if (isWrapped) {
    return {
      ...extracted,
      data: { ...nextTarget, _ogrn_relocated: relocated },
    };
  }
  return { ...nextTarget, _ogrn_relocated: relocated };
}
