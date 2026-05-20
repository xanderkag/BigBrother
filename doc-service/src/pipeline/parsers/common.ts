// Shared regex helpers reused by Phase 1 parsers (invoice, UPD).

const MONTHS_RU: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

export function findInn(text: string): string | undefined {
  // INN is 10 (legal entity) or 12 (individual) digits, near the literal "ИНН".
  // 12 (individual / ИП) must be tried before 10 (legal entity), and a
  // trailing digit-boundary stops \d{10} from clipping a 12-digit INN.
  const m = text.match(/ИНН[\s:№]*?(\d{12}|\d{10})(?!\d)/i);
  return m?.[1];
}

export function findKpp(text: string): string | undefined {
  const m = text.match(/КПП[\s:№]*?(\d{9})/i);
  return m?.[1];
}

export function findDocNumber(text: string, kindWords: string): string | undefined {
  // e.g. "Счёт № 123 от ...", "УПД № 456 от ..."
  const re = new RegExp(`(?:${kindWords})\\s*№?\\s*([A-ZА-Яa-zа-я0-9\\-\\/]+)`, 'i');
  const m = text.match(re);
  return m?.[1];
}

export function findDate(text: string): string | undefined {
  // Try numeric date first: dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy
  const num = text.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (num) {
    const [, d, m, y] = num;
    const year = y!.length === 2 ? 2000 + Number(y) : Number(y);
    return iso(year, Number(m), Number(d));
  }

  // Russian-style: "15 января 2026" / "15 января 2026 г."
  const ru = text.match(/(\d{1,2})\s+([а-я]+)\s+(\d{4})/i);
  if (ru) {
    const [, d, monthRaw, y] = ru;
    const month = MONTHS_RU[(monthRaw ?? '').toLowerCase()];
    if (month) return iso(Number(y), month, Number(d));
  }
  return undefined;
}

export function findMoney(text: string, ...labels: string[]): number | undefined {
  for (const label of labels) {
    // `g` so we can skip percentage hits (e.g. a "20%" rate) and keep
    // scanning for the actual ruble amount on a later occurrence.
    const re = new RegExp(`${label}[^\\d-]{0,20}([0-9][0-9\\s.,]*)(\\s*%)?`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[2]) continue; // trailing "%" → this is a rate, not money
      const num = parseAmount(m[1] ?? '');
      if (num !== undefined) return num;
    }
  }
  return undefined;
}

export function parseAmount(raw: string): number | undefined {
  // "15 000,50" / "15,000.50" / "15000.50" → 15000.5
  const cleaned = raw.replace(/\s/g, '').replace(/,/g, '.');
  // If multiple dots (thousand separators), keep only the last one as decimal.
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastDot !== -1 && cleaned.indexOf('.') !== lastDot) {
    normalized = cleaned.slice(0, lastDot).replace(/\./g, '') + '.' + cleaned.slice(lastDot + 1);
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

export function findVatRate(text: string): number | undefined {
  const m = text.match(/НДС[^%\d]{0,10}(\d{1,2})\s*%/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Сумма НДС (₽), а не ставка. Идём построчно: берём первую строку с "НДС",
 * исключаем подытоги ("без НДС", "кроме НДС", "НДС не облагается") и
 * вырезаем inline-ставку ("НДС 20%: 4 583,33" → сумма 4 583,33, не 20).
 */
export function findVat(text: string): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!/НДС/i.test(line)) continue;
    if (/без\s+НДС|кроме\s+НДС|НДС\s+не\s+облага/i.test(line)) continue;
    const cleaned = line.replace(/\d{1,2}\s*%/, ' '); // drop the rate token
    const m = cleaned.match(/([0-9][0-9\s.,]*)/);
    if (!m) continue;
    const v = parseAmount(m[1] ?? '');
    if (v !== undefined && v > 0) return v;
  }
  return undefined;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Score how many expected fields the parser found. Each field weighted
 * equally; missing the document number/date is the strongest signal of
 * a bad extraction.
 */
export function scoreCompleteness(
  found: Record<string, unknown>,
  expected: readonly string[],
): {
  confidence: number;
  missing: string[];
} {
  const missing: string[] = [];
  let hits = 0;
  for (const field of expected) {
    const v = found[field];
    if (v === undefined || v === null || v === '') {
      missing.push(field);
    } else {
      hits += 1;
    }
  }
  return { confidence: expected.length === 0 ? 1 : hits / expected.length, missing };
}
