/**
 * Field comparison primitives for the golden-set eval harness.
 *
 * Каждый компаратор:
 *  - принимает expected/actual в произвольной форме (то, что пользователь
 *    положил в JSON ↔ то, что вернул pipeline);
 *  - нормализует обе стороны по одинаковым правилам;
 *  - возвращает один из трёх вердиктов: 'match' | 'mismatch' | 'missing'.
 *
 * Что важно понимать:
 *  - 'missing' — поле было в expected, но в actual оно null/undefined/''.
 *    Это отдельно от 'mismatch', потому что coverage и accuracy — разные
 *    метрики. Мы хотим знать: «не извлекли вообще» vs «извлекли криво».
 *  - 'match' с tolerance — деньги ±0.01, проценты ±0.01, отнормированный
 *    счёт без пробелов. Это не «закрытие глаз»; это нормализация
 *    представления, а не значения.
 *  - Строки — case-fold + trim + сжатие пробелов. Не дальше — иначе
 *    «Иванов И.И.» vs «Иванов И. И.» будет match (что нам и нужно),
 *    а «Иванов» vs «Петров» останется mismatch.
 *
 * Намеренно НЕ делаем fuzzy-match (Левенштейн) — это превращает eval
 * в субъективный. Если строка реально близкая, но не равна — пусть
 * упадёт mismatch и человек посмотрит. Лучше false-negative, чем
 * красивая цифра, скрывающая дрифт.
 */

export type Verdict = 'match' | 'mismatch' | 'missing';

export type ComparatorKind =
  | 'string'
  | 'money'
  | 'percent'
  | 'date'
  | 'inn'
  | 'kpp'
  | 'account'
  | 'plate'
  | 'country'
  | 'integer'
  | 'number';

/** One field comparison result with full context for the report. */
export interface FieldComparison {
  path: string;
  kind: ComparatorKind;
  expected: unknown;
  actual: unknown;
  verdict: Verdict;
  reason?: string;
}

/** Тестируемая «отсутствует ли значение». null, undefined, '', NaN. */
export function isAbsent(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  return false;
}

/** Достать значение по dot-path: 'carrier.inn', 'positions.0.qty'. */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Унификация строк — для имён, адресов, наименований товара. */
export function normalizeString(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[«»"']/g, '')
    .replace(/[.,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compareString(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match'; // expected пусто — actual любое не валит
  const e = normalizeString(String(expected));
  const a = normalizeString(String(actual));
  return e === a ? 'match' : 'mismatch';
}

/** Деньги. Принимаем число, "1234.56", "1 234,56 ₽". Tolerance ±0.01. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const cleaned = v
    .replace(/[\s ]/g, '')
    .replace(/[₽$€£¥]/g, '')
    .replace(/руб\.?/gi, '')
    .replace(/\b(RUB|USD|EUR|GBP|JPY)\b/gi, '')
    .replace(/,/g, '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function compareMoney(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = parseMoney(expected);
  const a = parseMoney(actual);
  if (e === null || a === null) return 'mismatch';
  return Math.abs(e - a) <= 0.01 ? 'match' : 'mismatch';
}

/** Процент: 20, "20", "20%", "0.2" — принимаем все формы, нормализуем в 0-100. */
export function parsePercent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v <= 1 ? v * 100 : v;
  }
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[\s%]/g, '').replace(/,/g, '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

export function comparePercent(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = parsePercent(expected);
  const a = parsePercent(actual);
  if (e === null || a === null) return 'mismatch';
  return Math.abs(e - a) <= 0.01 ? 'match' : 'mismatch';
}

/**
 * Дата. Принимаем ISO 'YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY'.
 * Возвращаем нормализованный ISO 'YYYY-MM-DD' (без времени).
 */
export function parseDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD.MM.YYYY или DD/MM/YYYY
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) {
    const dd = m[1]!.padStart(2, '0');
    const mm = m[2]!.padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  return null;
}

export function compareDate(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = parseDate(String(expected));
  const a = parseDate(String(actual));
  if (e === null || a === null) return 'mismatch';
  return e === a ? 'match' : 'mismatch';
}

/** Только цифры. Для ИНН, КПП, счёта, БИК. */
export function digitsOnly(v: unknown): string | null {
  if (typeof v === 'number') return String(Math.trunc(v));
  if (typeof v !== 'string') return null;
  const d = v.replace(/\D/g, '');
  return d.length > 0 ? d : null;
}

export function compareDigits(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = digitsOnly(expected);
  const a = digitsOnly(actual);
  if (e === null || a === null) return 'mismatch';
  return e === a ? 'match' : 'mismatch';
}

/** Госномер: уберём пробелы, приведём к верхнему регистру. */
export function normalizePlate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.replace(/[\s-]/g, '').toUpperCase() || null;
}

export function comparePlate(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = normalizePlate(String(expected));
  const a = normalizePlate(String(actual));
  if (e === null || a === null) return 'mismatch';
  return e === a ? 'match' : 'mismatch';
}

/** Country: 2 буквы ISO 3166-1 alpha-2, case-insensitive. */
export function compareCountry(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = String(expected).trim().toUpperCase();
  const a = String(actual).trim().toUpperCase();
  return e === a ? 'match' : 'mismatch';
}

export function compareInteger(expected: unknown, actual: unknown): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = parseMoney(expected);
  const a = parseMoney(actual);
  if (e === null || a === null) return 'mismatch';
  return Math.round(e) === Math.round(a) ? 'match' : 'mismatch';
}

export function compareNumber(expected: unknown, actual: unknown, tolerance = 0.01): Verdict {
  if (isAbsent(actual)) return isAbsent(expected) ? 'match' : 'missing';
  if (isAbsent(expected)) return 'match';
  const e = parseMoney(expected);
  const a = parseMoney(actual);
  if (e === null || a === null) return 'mismatch';
  return Math.abs(e - a) <= tolerance ? 'match' : 'mismatch';
}

export function compareByKind(
  kind: ComparatorKind,
  expected: unknown,
  actual: unknown,
): Verdict {
  switch (kind) {
    case 'string':
      return compareString(expected, actual);
    case 'money':
      return compareMoney(expected, actual);
    case 'percent':
      return comparePercent(expected, actual);
    case 'date':
      return compareDate(expected, actual);
    case 'inn':
    case 'kpp':
    case 'account':
      return compareDigits(expected, actual);
    case 'plate':
      return comparePlate(expected, actual);
    case 'country':
      return compareCountry(expected, actual);
    case 'integer':
      return compareInteger(expected, actual);
    case 'number':
      return compareNumber(expected, actual);
  }
}

/**
 * Авто-определение типа компаратора по path. Хорошо работает на нашем
 * наборе полей (inn/kpp/plate в имени) и снижает многословность
 * golden-set JSON. Пользователь может оверрайдить вручную через kind.
 */
export function inferKind(path: string): ComparatorKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.inn') || lower === 'inn') return 'inn';
  if (lower.endsWith('.kpp') || lower === 'kpp') return 'kpp';
  if (lower.includes('account') || lower.endsWith('_account')) return 'account';
  if (lower.includes('plate') || lower.endsWith('_number') && lower.includes('vehicle')) {
    return 'plate';
  }
  if (lower.endsWith('country') || lower.endsWith('_country') || lower.endsWith('_code')) {
    return 'country';
  }
  if (lower.endsWith('_date') || lower === 'date' || lower.endsWith('.date')) return 'date';
  // percent ДО money — иначе vat_rate унаследует 'money' от 'vat'.
  if (lower.includes('rate') || lower.includes('percent')) return 'percent';
  if (
    lower.includes('total') ||
    lower.includes('amount') ||
    lower.includes('price') ||
    lower.includes('sum') ||
    lower.includes('vat') ||
    lower.includes('cost')
  ) {
    return 'money';
  }
  if (lower.includes('weight') || lower.includes('volume') || lower.includes('qty')) {
    return 'number';
  }
  return 'string';
}
