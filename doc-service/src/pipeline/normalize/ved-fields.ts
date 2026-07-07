/**
 * VED-нормализаторы (VANGA-VED-1 §4) — приводят коммерческо-таможенные поля
 * транзитного комплекта к канонической форме для сверки на стороне SLAI.
 *
 * Как и `identifiers.ts` — pure, без side-effects, возвращают либо
 * нормализованное значение, либо `null` если форма не восстановима.
 * Отличие от validation: тут «как унифицировать», а не «правильно ли».
 *
 * Мотивация (из реальных данных БКТ Транзит): без нормализации сверка ловит
 * ЛОЖНЫЕ конфликты — «17 653,02» ≠ «17653.02», «5 т» ≠ «5000 кг»,
 * «1806 32 10» ≠ «1806321000», а главное — транспорт в заявке `С380ТУ60`
 * (кириллица) vs в CMR `9096BC` (латиница) должен читаться как ПЕРЕЦЕП
 * (связка машин), а не как конфликт. Для этого номер ТС несёт `script`-флаг.
 */

/**
 * Вес → килограммы. Принимает число/строку значения и опциональную единицу.
 * Если единица не задана — пытается вытащить её из строки значения
 * («18,528.02 kg», «5 т», «250 г»). Тонна → ×1000, грамм → ÷1000, кг → как есть.
 * Возвращает число в кг или null.
 *
 * Единицы (RU/EN): т|t|тн|tonne|tonnes → тонны; г|g|gr|gram → граммы;
 * кг|kg|kgs|kilogram → килограммы (default, если единица неизвестна но число есть).
 */
const TONNE_RE = /^(т|тн|tonne|tonnes|ton|tons|t)$/i;
const GRAM_RE = /^(г|гр|g|gr|gram|grams)$/i;
const KILO_RE = /^(кг|kg|kgs|kilogram|kilograms|kilo)$/i;

export function normalizeWeightToKg(value: unknown, unit?: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  // Достаём числовую часть (поддержка RU/EU-разделителей: «18 528,02»).
  const raw = String(value).trim();
  let unitStr = unit != null ? String(unit).trim() : '';

  // Если единица не передана — ищем её в хвосте строки значения.
  if (!unitStr) {
    const m = raw.match(/([\d\s.,]+)\s*([a-zA-Zа-яА-Я]+)?\s*$/);
    if (m && m[2]) unitStr = m[2];
  }

  const num = parseNumericLoose(raw);
  if (num === null) return null;

  if (TONNE_RE.test(unitStr)) return round3(num * 1000);
  if (GRAM_RE.test(unitStr)) return round3(num / 1000);
  // кг или неизвестная единица с числом — трактуем как килограммы.
  if (KILO_RE.test(unitStr) || unitStr === '') return round3(num);
  // Явно чужая единица (шт, м3, …) — вес не восстановим.
  return null;
}

/**
 * Число из строки с RU/EU-разделителями. «17 653,02» / «17,653.02» /
 * «17653.02» → 17653.02. Логика: убрать пробелы (в т.ч. NBSP), затем
 * последний из {точка, запятая} считать десятичным, остальные — тысячными.
 * Возвращает number или null.
 */
export function parseNumericLoose(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(/[\s  ]/g, '');
  // Оставляем цифры, точки, запятые, минус.
  s = s.replace(/[^\d.,-]/g, '');
  if (s === '' || s === '-') return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const decPos = Math.max(lastDot, lastComma);
  if (decPos === -1) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const intPart = s.slice(0, decPos).replace(/[.,]/g, '');
  const fracPart = s.slice(decPos + 1).replace(/[.,]/g, '');
  const n = Number(`${intPart}.${fracPart}`);
  return Number.isFinite(n) ? n : null;
}

/**
 * Валюта → ISO 4217. Символы и русские сокращения → трёхбуквенный код.
 * «руб»/«руб.»/«₽»/«RUB» → RUB, «€»/«EUR»/«евро» → EUR, «$»/«USD»/«долл» → USD.
 * Уже валидный ISO-код возвращается как есть (upper). Неизвестное → null.
 */
const CURRENCY_MAP: Record<string, string> = {
  'RUB': 'RUB', 'РУБ': 'RUB', 'РУБ.': 'RUB', 'Р': 'RUB', '₽': 'RUB', 'РУБЛЬ': 'RUB', 'РУБЛЕЙ': 'RUB', 'RUR': 'RUB',
  'EUR': 'EUR', 'ЕВРО': 'EUR', '€': 'EUR',
  'USD': 'USD', 'ДОЛЛ': 'USD', 'ДОЛЛАР': 'USD', '$': 'USD', 'US$': 'USD',
  'CNY': 'CNY', 'ЮАНЬ': 'CNY', '¥': 'CNY', 'RMB': 'CNY',
  'GBP': 'GBP', '£': 'GBP',
  'KZT': 'KZT', 'ТЕНГЕ': 'KZT', '₸': 'KZT',
  'BYN': 'BYN', 'TRY': 'TRY', 'AED': 'AED', 'CHF': 'CHF', 'PLN': 'PLN',
};

export function normalizeCurrency(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toUpperCase().replace(/\.$/, '');
  if (key === '') return null;
  if (CURRENCY_MAP[key]) return CURRENCY_MAP[key];
  // Уже похоже на ISO-код (3 латинские буквы) — принимаем как есть.
  if (/^[A-Z]{3}$/.test(key)) return key;
  return null;
}

/**
 * ТНВЭД / HS-код → чистая строка цифр. «1806 32 10» → «1806321000»?
 * Нет — НЕ дополняем нулями (это меняло бы смысл). Убираем пробелы/точки,
 * оставляем цифры, принимаем длину 6/8/10 (HS-6, HS-8 ЕС, ТНВЭД-10 ЕАЭС).
 * Возвращает очищенную строку или null (длина вне {6,8,10} → null).
 *
 * ВАЖНО: строка, не число — ведущие нули значимы («0402100000»).
 */
export function normalizeHsCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 6 || digits.length === 8 || digits.length === 10) {
    return digits;
  }
  return null;
}

/**
 * Определить письменность строки: 'cyrillic' | 'latin' | 'mixed' | null.
 * Считаем только буквы (цифры/знаки игнорируем). Нет букв → null.
 *
 * Нужно для перецеп-сверки: номер ТС из заявки (кириллица, РФ-тягач) и из
 * CMR (латиница, иностранный тягач) — это СВЯЗКА машин на плече, а не
 * конфликт. SLAI-сторона по флагу понимает, что сверять их надо
 * транслит-осведомлённо, а расхождение письменности само по себе — норма.
 */
export function detectScript(raw: unknown): 'cyrillic' | 'latin' | 'mixed' | null {
  // Только строки: без guard объект/массив/boolean дал бы «[object Object]»/
  // «true» → ложный 'latin' и испортил бы перецеп-сигнал (review VANGA-VED-1).
  if (typeof raw !== 'string' || raw === '') return null;
  const s = raw;
  const hasCyr = /[а-яё]/i.test(s);
  const hasLat = /[a-z]/i.test(s);
  if (hasCyr && hasLat) return 'mixed';
  if (hasCyr) return 'cyrillic';
  if (hasLat) return 'latin';
  return null;
}

/**
 * Номер ТС + метаданные для перецеп-сверки. Сохраняет ОРИГИНАЛ как есть,
 * добавляет `script`-флаг и (для РФ-номеров) нормализованную кириллическую
 * форму через `normalizePlate`. Иностранные номера (латиница, не под маску
 * ГИБДД) остаются с `normalized: null` — сверяются по оригиналу.
 *
 * @returns { original, script, normalized } либо null если пусто.
 */
export function plateWithScript(
  raw: unknown,
  normalizePlate: (v: unknown) => string | null,
): { original: string; script: 'cyrillic' | 'latin' | 'mixed' | null; normalized: string | null } | null {
  if (raw === null || raw === undefined) return null;
  const original = String(raw).trim();
  if (original === '') return null;
  return {
    original,
    script: detectScript(original),
    normalized: normalizePlate(original),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
