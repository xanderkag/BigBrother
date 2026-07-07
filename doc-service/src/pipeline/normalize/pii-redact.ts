/**
 * PII redaction для extracted JSON.
 *
 * Зачем: при отправке распарсенных документов внешним интеграторам
 * (SLAI matcher, аналитика, training set для LLM) часть полей содержит
 * персональные данные — ФИО водителя, контакт-персона, паспортные данные.
 *
 * **Что редактируем (PII):**
 *   - `vehicle.driver` — ФИО водителя
 *   - `vehicle.driver_phone` / `vehicle.driver_phone2`
 *   - `seller.contact_person` / `buyer.contact_person`
 *   - `signatory_name` (любой подписант)
 *   - Паспортные данные / водительское удостоверение из свободного текста
 *   - Email / phone в свободных полях (basic regex)
 *
 * **Что НЕ редактируем (публичная информация):**
 *   - ИНН юрлиц и ИП (по 14-ФЗ — публичный реестр ЕГРЮЛ/ЕГРИП)
 *   - Названия компаний
 *   - Адреса юрлиц (юр.адрес — публичная информация)
 *   - Госномера ТС (идентификатор объекта, не персональные)
 *   - КПП, ОГРН, БИК
 *
 * Контракт:
 *   - Идемпотентно (повторный вызов на уже редактированном `[REDACTED]` ничего не меняет)
 *   - Помечает редактированные поля в `_redacted_fields: string[]` для аудита
 *   - Не падает на пустых / null значениях
 */

const REDACTED = '[REDACTED]';

// Регулярки для свободного текста (применяем к строковым полям).
// Преднамеренно консервативные — лучше пропустить PII чем редактировать
// ИНН/ОГРН по совпадению длины. Паспорт/ВУ ловим только когда явно есть
// контекст-слово рядом ("паспорт ...", "вод. удост ...") — без контекста
// 10 цифр невозможно отличить от ИНН.
const PII_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; replace: string }> = [
  {
    name: 'passport_rf',
    // «паспорт … 4501 №123456» — требуем контекст «паспорт»/«серия» рядом
    re: /(паспорт|серия)[^\d\n]{0,15}\d{2}\s?\d{2}\s?№?\s?\d{6}\b/gi,
    replace: '$1 [REDACTED]',
  },
  {
    name: 'driver_license',
    // «вод. удост. … XX XX 123456» — требуем контекст
    re: /(вод(\.|ительск)?(\s|\.)*удост\w*)[^\d\n]{0,15}[А-ЯA-Z\d]{2}\s?[А-ЯA-Z\d]{2}\s?\d{6}\b/gi,
    replace: '$1 [REDACTED]',
  },
  {
    name: 'phone_ru',
    // +7 или 8 + 10 цифр в типичных форматах. Требуем явный prefix чтобы
    // не задеть ИНН/счёт. Разделители между группами: пробел, дефис или ничего.
    re: /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g,
    replace: REDACTED,
  },
  {
    name: 'email',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: REDACTED,
  },
];

// Имена полей где ФИО / контактные данные стоят целиком — не пытаемся
// применять regex, просто заменяем значение. Список расширяемый.
const PII_FIELD_PATHS: ReadonlyArray<readonly string[]> = [
  ['vehicle', 'driver'],
  ['vehicle', 'driver_name'],
  ['vehicle', 'driver_phone'],
  ['vehicle', 'driver_phone2'],
  ['vehicle', 'driver_passport'],
  ['vehicle', 'driver_license'],
  ['seller', 'contact_person'],
  ['buyer', 'contact_person'],
  ['shipper', 'contact_person'],
  ['consignee', 'contact_person'],
  ['carrier', 'contact_person'],
  ['signatory'],
  ['signatory_name'],
  ['executor_name'],
  ['recipient_name_individual'],
];

function setByPath(obj: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
  if (path.length === 0) return false;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object') return false;
    cur = next as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  if (!(lastKey in cur)) return false;
  if (cur[lastKey] === null || cur[lastKey] === undefined) return false;
  if (cur[lastKey] === REDACTED) return false; // уже редактировано
  cur[lastKey] = value;
  return true;
}

function redactStringFields(obj: unknown, redacted: string[]): unknown {
  if (typeof obj === 'string') {
    let result = obj;
    let changed = false;
    for (const { re, replace } of PII_PATTERNS) {
      if (re.test(result)) {
        // .test может сдвинуть lastIndex для глобальных регулярок — сбрасываем
        re.lastIndex = 0;
        result = result.replace(re, replace);
        changed = true;
      } else {
        re.lastIndex = 0;
      }
    }
    if (changed) redacted.push('regex_match');
    return result;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactStringFields(item, redacted));
  }
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = redactStringFields(v, redacted);
    }
    return out;
  }
  return obj;
}

export function redactPii(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  // 1. Глубокая копия (чтобы не мутировать вход)
  const copy = JSON.parse(JSON.stringify(extracted)) as Record<string, unknown>;
  const redacted: string[] = [];

  // 2. Очистка известных PII-путей
  for (const path of PII_FIELD_PATHS) {
    if (setByPath(copy, path, REDACTED)) {
      redacted.push(path.join('.'));
    }
  }

  // 3. Regex-чистка строк во всех полях (паспорт, телефон, email)
  // Не трогаем _normalized_fields — там canonical-значения для матчинга
  // (ИНН, госномер, валюта-ISO, ТНВЭД, script-флаги cyrillic|latin), все
  // non-PII. Исключаем из regex-чистки, восстанавливаем verbatim.
  const normalized = copy._normalized_fields;
  delete copy._normalized_fields;
  const cleaned = redactStringFields(copy, redacted) as Record<string, unknown>;
  if (normalized !== undefined) cleaned._normalized_fields = normalized;

  if (redacted.length > 0) {
    cleaned._redacted_fields = Array.from(new Set(redacted));
  }
  return cleaned;
}
