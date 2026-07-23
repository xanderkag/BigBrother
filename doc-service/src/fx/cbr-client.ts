/**
 * FX-1: клиент официального курса ЦБ РФ (cbr.ru/scripts/XML_daily.asp).
 *
 * ЦБ отдаёт дневной курс всех валют одним XML-документом (обновляется раз в
 * рабочий день ~11:30 МСК; в выходные — курс последнего рабочего дня). Ключей
 * не требует. Кодировка ответа — windows-1251, но нам нужны только ASCII-поля
 * (CharCode/Nominal/Value/Date), поэтому декодируем как текст без спец-обработки
 * (кириллический <Name> не используется).
 *
 * Формат Valute (без пробелов между тегами):
 *   <Valute ID="R01235"><CharCode>USD</CharCode><Nominal>1</Nominal>
 *     <Value>78,4049</Value><VunitRate>78,4049</VunitRate></Valute>
 *   <Valute ID="R01820"><CharCode>JPY</CharCode><Nominal>100</Nominal>
 *     <Value>48,0835</Value></Valute>
 *
 * Value — цена за `Nominal` единиц с ЗАПЯТОЙ как десятичным разделителем.
 * Курс за 1 единицу = parse(Value) / Nominal.
 */

export type CbrRate = {
  /** ISO буквенный код (CharCode): 'USD', 'EUR', 'CNY', ... */
  currency_code: string;
  /** рублей за 1 единицу валюты = Value / Nominal */
  rate_rub: number;
  /** номинал ЦБ (1 | 10 | 100) — сохраняем для прозрачности */
  nominal: number;
  /** дата курса по ЦБ, 'YYYY-MM-DD' (из атрибута ValCurs Date) */
  cbr_date: string;
};

const CBR_DAILY_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';

function readTag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  const v = m?.[1];
  return v !== undefined ? v.trim() : null;
}

/**
 * Чистый парсер XML ЦБ → массив курсов. Без сети — тестируется на фикстуре.
 * Терпим к мусору: валюты без CharCode/Value или с непарсируемым Value
 * молча пропускаются (кривая строка не роняет весь разбор). Пустой/битый
 * документ (нет Date) → []. Вызывающий трактует [] как «не удалось».
 */
export function parseCbrDailyXml(xml: string): CbrRate[] {
  // Date="dd.mm.yyyy" в открывающем теге ValCurs.
  const d = xml.match(/<ValCurs\b[^>]*\bDate="(\d{2})\.(\d{2})\.(\d{4})"/);
  const [, dd, mm, yyyy] = d ?? [];
  if (!dd || !mm || !yyyy) return [];
  const cbrDate = `${yyyy}-${mm}-${dd}`; // → YYYY-MM-DD

  const out: CbrRate[] = [];
  const valuteRe = /<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g;
  let m: RegExpExecArray | null;
  while ((m = valuteRe.exec(xml)) !== null) {
    const block = m[1];
    if (block === undefined) continue;
    const code = readTag(block, 'CharCode');
    const valueRaw = readTag(block, 'Value');
    if (!code || !valueRaw) continue;
    const nominal = Number.parseInt(readTag(block, 'Nominal') ?? '1', 10) || 1;
    // «78,4049» → 78.4049; на всякий случай выкидываем пробелы-разделители тысяч.
    const value = Number.parseFloat(valueRaw.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      currency_code: code.trim().toUpperCase(),
      rate_rub: value / nominal,
      nominal,
      cbr_date: cbrDate,
    });
  }
  return out;
}

/**
 * Тянет и парсит дневной курс ЦБ. `fetchImpl` инъектируется для тестов.
 * Бросает при сетевой ошибке / не-2xx / пустом разборе — вызывающий
 * (обновлятор) ловит и fail-soft'ит (оставляет прошлый кэш).
 */
export async function fetchCbrDailyRates(opts?: {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CbrRate[]> {
  const url = opts?.url ?? CBR_DAILY_URL;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`cbr fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  const rates = parseCbrDailyXml(xml);
  if (rates.length === 0) throw new Error('cbr parse: 0 rates (empty or malformed XML)');
  return rates;
}
