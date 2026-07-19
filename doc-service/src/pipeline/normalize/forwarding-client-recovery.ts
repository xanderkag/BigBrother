/**
 * Восстановление заказчика (client) поручения экспедитору из raw-текста —
 * страховка, когда модель не вытянула Клиента. Только для forwarding_order.
 *
 * Замер 2026-07-17: у forwarding_order экспедитор/грузоотправитель/
 * грузополучатель/плечо извлекались 10/10, а client — 0/10, хотя метка
 * «Клиент»/«Заказчик» в тексте есть. Промпт до модели ДОХОДИТ (проверено в
 * last_llm_call), но локальная модель поле не берёт, когда клиент:
 *   (а) в прозе — «…ООО «Ист-Вест Лоджистик» (далее — Клиент)»;
 *   (б) та же компания, что грузополучатель (модель кладёт в consignee, не
 *       дублирует в client).
 * Промптом не лечится — добиваем детерминированно по метке, как ИНН/контейнеры.
 *
 * Контракт (как у recoverPartyInnsFromText):
 *   - Только documentType='forwarding_order', только когда client пуст.
 *   - Кандидат — компания рядом с меткой «Клиент»/«Заказчик» (орг-форма
 *     обязательна: ООО/АО/ИП/… — случайные слова не проходят).
 *   - Роли МОГУТ совпадать: заполняем client, даже если та же компания уже
 *     в consignee/shipper (это и есть частый кейс).
 *   - Pure / идемпотентна. Помечает `_client_recovered` (аудит: добито из
 *     текста, не распознано моделью).
 */

// Орг-форма компании (рус + лат). Кириллическое ООО и латинское OOO — разные.
const ORG = '(?:ООО|АО|ЗАО|ОАО|ПАО|НАО|ИП|OOO|LLC)';
// Компания: орг-форма + название до кавычки-закрытия / перевода строки /
// запятой / скобки. Кавычки (« » " " ' ) по краям опциональны.
// Жадный {2,80} (не ленивый): без якоря после COMPANY ленивый брал бы минимум
// («ООО «МЛР»» → «ООО «МЛ»). Стоп-класс (кавычки/скобки/перевод строки/запятая)
// сам ограничит хвост названием.
const COMPANY = `${ORG}\\s*[«"“']?[^«»"“”'\\n,;()]{2,80}[»"”']?`;

// A: метка ПЕРЕД компанией — «Клиент: ООО …» / «4. Клиент\nООО …».
const LABEL_BEFORE = new RegExp(`(?:клиент|заказчик)\\s*[:.\\-–—]?\\s*\\n?\\s*(${COMPANY})`, 'i');
// B: метка ПОСЛЕ компании — «ООО «…» (далее — Клиент)». Точнее A (компания
// стоит вплотную к своей роли), поэтому пробуем первой.
const LABEL_AFTER = new RegExp(`(${COMPANY})\\s*\\(?\\s*далее[^)]{0,25}?(?:клиент|заказчик)`, 'i');

function cleanName(s: string): string {
  // Схлопываем пробелы, срезаем висячие разделители по краям. Кавычки «…»
  // НЕ трогаем — иначе разбалансируем название («ООО «Ист-Вест»» → корректно).
  return s.replace(/\s+/g, ' ').trim().replace(/[\s,;.]+$/, '');
}

function clientIsEmpty(extracted: Record<string, unknown>): boolean {
  const c = extracted.client;
  if (c == null) return true;
  if (typeof c === 'string') return c.trim().length === 0;
  if (typeof c === 'object') {
    const name = (c as Record<string, unknown>).name;
    return !(typeof name === 'string' && name.trim().length > 0);
  }
  return true;
}

/**
 * Достаёт заказчика из `rawText` по метке и добивает пустой `client`.
 * Возвращает НОВЫЙ объект если добил, иначе — исходный.
 */
export function recoverForwardingClientFromText(
  extracted: Record<string, unknown> | null,
  rawText: string | null | undefined,
  documentType?: string | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (documentType !== 'forwarding_order') return extracted;
  if (!rawText || typeof rawText !== 'string' || rawText.length === 0) return extracted;
  if (!clientIsEmpty(extracted)) return extracted;

  const raw = rawText.match(LABEL_AFTER)?.[1] ?? rawText.match(LABEL_BEFORE)?.[1] ?? null;
  if (!raw) return extracted;
  const name = cleanName(raw);
  // Отсекаем вырожденное (одна орг-форма без названия и т.п.).
  if (name.length < 5) return extracted;

  const existing = extracted.client;
  const clientObj =
    existing && typeof existing === 'object'
      ? { ...(existing as Record<string, unknown>) }
      : {};
  clientObj.name = name;
  return { ...extracted, client: clientObj, _client_recovered: name };
}
