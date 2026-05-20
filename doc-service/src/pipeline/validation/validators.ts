/**
 * Domain validators — pure functions that check Russian-specific
 * accounting/transport invariants on a single field.
 *
 * Each validator returns either `null` (no issue) or a short Russian
 * message describing what's wrong. The composer collects messages from
 * many validators into `validation_issues[]`; nothing throws.
 *
 * Goal: catch OCR-corrupted data BEFORE it lands in 1С/ERP. A typo in
 * an INN (one digit off) usually fails the checksum, which is invisible
 * to format-level checks like "10 digits". Same for plates, dates that
 * read as 30.02.2026, money totals that don't add up, etc.
 */

const INN_WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_WEIGHTS_12_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_WEIGHTS_12_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

/**
 * Validate an INN with the official checksum from приказ ФНС от
 * 02.11.2004 № САЭ-3-09/16@. 10-digit form is for юрлица, 12-digit for
 * ИП. Format-only validation (length + digits) is a weak filter: an OCR
 * typo on any one digit produces a string that "looks" valid but
 * almost certainly fails the checksum.
 */
export function validateInn(inn: string): string | null {
  if (!/^\d+$/.test(inn)) return `ИНН должен состоять только из цифр: "${inn}"`;
  if (inn.length === 10) return validateInn10(inn);
  if (inn.length === 12) return validateInn12(inn);
  return `ИНН должен быть 10 или 12 цифр, получено ${inn.length}: "${inn}"`;
}

function validateInn10(inn: string): string | null {
  const sum = INN_WEIGHTS_10.reduce((acc, w, i) => acc + w * Number(inn[i]), 0);
  const expected = (sum % 11) % 10;
  const actual = Number(inn[9]);
  return expected === actual ? null : `ИНН ${inn}: контрольная сумма не сходится`;
}

function validateInn12(inn: string): string | null {
  const sum1 = INN_WEIGHTS_12_FIRST.reduce((acc, w, i) => acc + w * Number(inn[i]), 0);
  const sum2 = INN_WEIGHTS_12_SECOND.reduce((acc, w, i) => acc + w * Number(inn[i]), 0);
  const expected1 = (sum1 % 11) % 10;
  const expected2 = (sum2 % 11) % 10;
  if (expected1 !== Number(inn[10]) || expected2 !== Number(inn[11])) {
    return `ИНН ${inn}: контрольная сумма не сходится`;
  }
  return null;
}

/**
 * КПП — 9 символов: NNNNCCNNN, где первые 4 — код налоговой, символы
 * 5-6 — причина постановки (две цифры либо две заглавные латинские
 * буквы), последние 3 — порядковый номер. Без checksum'а.
 */
export function validateKpp(kpp: string): string | null {
  if (!/^\d{4}([A-Z\d]{2})\d{3}$/.test(kpp)) {
    return `КПП ${kpp} имеет некорректный формат (ожидается 9 символов NNNNCCNNN)`;
  }
  return null;
}

/**
 * Russian vehicle plate (legal entity passenger format): one Cyrillic
 * letter + 3 digits + two Cyrillic letters + region code (2 or 3 digits).
 * Allowed letters are Cyrillic letters that look like Latin (ГИБДД rule
 * for international legibility): А, В, Е, К, М, Н, О, Р, С, Т, У, Х.
 *
 * Special plates (taxi, government, trailer, etc.) deliberately not
 * supported here — they're outside the typical TTN/CMR scope.
 */
const PLATE_LETTERS = 'АВЕКМНОРСТУХ';
const PLATE_RE = new RegExp(`^[${PLATE_LETTERS}]\\d{3}[${PLATE_LETTERS}]{2}\\d{2,3}$`);

export function validateVehiclePlate(plate: string): string | null {
  const normalized = plate.replace(/\s/g, '').toUpperCase();
  if (!PLATE_RE.test(normalized)) {
    return `Госномер "${plate}" не похож на стандартный российский (ожидается формат А123БВ77)`;
  }
  return null;
}

/**
 * Дата в формате YYYY-MM-DD должна быть валидной и попадать в разумный
 * диапазон. Документ из 1900 года почти наверняка артефакт OCR; то же
 * для дат сильно в будущем.
 */
const DATE_LOWER = '2010-01-01';
const DATE_UPPER_OFFSET_DAYS = 30; // small tolerance for "tomorrow's docs"

export function validateDate(iso: string, today: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return `Дата ${iso}: ожидается формат YYYY-MM-DD`;
  }
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return `Дата ${iso}: невалидная (например, 30.02 не существует)`;
  }
  // JS Date rolls overflow dates over (2026-02-30 → 2026-03-02) instead of
  // throwing — catch the rollover by round-tripping the components.
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() + 1 !== m ||
    parsed.getUTCDate() !== d
  ) {
    return `Дата ${iso}: невалидная (например, 30.02 не существует)`;
  }
  const lower = new Date(`${DATE_LOWER}T00:00:00Z`);
  const upper = new Date(today.getTime() + DATE_UPPER_OFFSET_DAYS * 86_400_000);
  if (parsed < lower) {
    return `Дата ${iso} раньше ${DATE_LOWER} — вероятно, OCR-ошибка`;
  }
  if (parsed > upper) {
    return `Дата ${iso} в будущем (>${DATE_UPPER_OFFSET_DAYS} дней вперёд)`;
  }
  return null;
}

const MAX_REASONABLE_AMOUNT = 1_000_000_000_000; // 1 трлн ₽

export function validateMoney(value: number, label: string): string | null {
  if (!Number.isFinite(value)) return `${label} не число: ${value}`;
  if (value < 0) return `${label} отрицательный: ${value}`;
  if (value > MAX_REASONABLE_AMOUNT) return `${label} неправдоподобно большой: ${value}`;
  return null;
}

/**
 * VAT consistency: vat должен примерно равняться total × rate / (100 + rate).
 * Допускается копеечное расхождение (вплоть до ±0.51 при типовых суммах).
 */
const VAT_TOLERANCE_ABSOLUTE = 1.0; // ₽
const VAT_TOLERANCE_RELATIVE = 0.005; // 0.5%

export function validateVatConsistency(
  total: number | undefined,
  vat: number | undefined,
  vatRate: number | undefined,
): string | null {
  if (total === undefined || vat === undefined || vatRate === undefined) return null;
  if (vatRate === 0) {
    if (vat !== 0) return `НДС ${vat} при ставке 0% — нестыковка`;
    return null;
  }
  const expected = (total * vatRate) / (100 + vatRate);
  const tolerance = Math.max(VAT_TOLERANCE_ABSOLUTE, total * VAT_TOLERANCE_RELATIVE);
  if (Math.abs(expected - vat) > tolerance) {
    return `НДС ${vat} не сходится с total×rate/(100+rate) ≈ ${expected.toFixed(2)} (допуск ±${tolerance.toFixed(2)})`;
  }
  return null;
}

/**
 * Сумма по позициям должна примерно равняться итоговой сумме. Толерантность
 * больше, чем у НДС, потому что в реальных документах позиции часто
 * округляются по-своему.
 */
const POSITIONS_TOLERANCE_RELATIVE = 0.01; // 1%

export function validatePositionsSum(
  positions: Array<{ total?: number | null }> | undefined,
  total: number | undefined,
): string | null {
  if (!positions || positions.length === 0 || total === undefined) return null;
  let sum = 0;
  let hasMissing = false;
  for (const p of positions) {
    if (typeof p.total === 'number') sum += p.total;
    else hasMissing = true;
  }
  if (hasMissing) return null; // частично известные суммы — не проверяем
  const tolerance = Math.max(1.0, total * POSITIONS_TOLERANCE_RELATIVE);
  if (Math.abs(sum - total) > tolerance) {
    return `Сумма позиций ${sum.toFixed(2)} не сходится с total ${total} (допуск ±${tolerance.toFixed(2)})`;
  }
  return null;
}

/**
 * Один и тот же ИНН у продавца и покупателя — почти всегда OCR-сбой
 * (распознали оба ИНН как одинаковые) или подделка.
 */
export function validatePartiesDiffer(
  sellerInn: string | undefined,
  buyerInn: string | undefined,
): string | null {
  if (!sellerInn || !buyerInn) return null;
  if (sellerInn === buyerInn) {
    return `ИНН продавца и покупателя совпадают (${sellerInn}) — вероятно, OCR-ошибка`;
  }
  return null;
}

/**
 * ISO 3166-1 alpha-2 country code: две заглавные латинские буквы. Не
 * сверяем со списком стран — слишком много пограничных случаев (XK для
 * Косово и т.п.). Достаточно формата.
 */
export function validateCountryCode(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) {
    return `Код страны "${code}": ожидается ISO 3166 alpha-2 (2 заглавные латинские буквы)`;
  }
  return null;
}
