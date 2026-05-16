/**
 * Identifier normalizers — приводят к каноническому виду ключевые поля
 * для матчинга на стороне интеграторов (SLAI / 1С / WMS).
 *
 * Принципиально отличается от validation:
 *   - validators отвечают «правильно ли распознано» (вернёт ошибку для UI/audit)
 *   - normalizers отвечают «как унифицировать форму для exact-match»
 *
 * Возвращают либо нормализованную строку, либо `null` если форма не
 * восстановима. Caller сам решает падать ли в issues или просто отдать
 * оригинал клиенту.
 *
 * Все функции pure, без side-effects.
 */
import { validateInn } from '../validation/validators.js';

/**
 * Нормализация ИНН: убрать всё кроме цифр, проверить длину (10 или 12),
 * проверить чек-сумму. Возвращает чистую строку цифр или null если ИНН
 * нерекоррктный.
 *
 * Документы любят вставлять «ИНН: 7728-168-971», «ИНН/КПП 7728168971/772801001»,
 * «инн : 5024169813» с пробелами и пунктуацией. После normalizeInn matcher
 * SLAI получит везде одинаковый вид и сможет делать `WHERE inn = $1` без танцев.
 */
export function normalizeInn(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 12) return null;
  // Проверяем checksum через существующий валидатор. Если не сходится —
  // это OCR-ошибка, а не «другой формат», и matcher по нему ничего не
  // найдёт. Лучше отдать null чем мусор.
  if (validateInn(digits) !== null) return null;
  return digits;
}

/**
 * Российский госномер ТС, нормализованный к каноническому виду.
 *
 * По ГИБДД допустимо ровно 12 символов из латино-кириллического пересечения:
 *   А В Е К М Н О Р С Т У Х
 * Эти буквы выглядят одинаково в обеих письменностях. OCR / LLM часто
 * путают их (вместо А пишут латинскую A, вместо В — английскую B и т.д.).
 *
 * Дополнительно фиксим типичные OCR-сбои:
 *   - 0 ↔ О    (ноль vs буква О)
 *   - 3 ↔ З    (тройка vs Зэ)
 *   - 8 ↔ В    (если в позиции буквы) — реже, но бывает
 *   - I/1 в позиции цифры → 1
 *
 * Возвращает 8-9 символов в верхнем регистре кириллицы либо null если
 * формат неизвлекаем.
 */
const LAT_TO_CYR: Record<string, string> = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н',
  O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х',
};
const PLATE_LETTERS = 'АВЕКМНОРСТУХ';
const PLATE_RE = new RegExp(`^[${PLATE_LETTERS}]\\d{3}[${PLATE_LETTERS}]{2}\\d{2,3}$`);

export function normalizePlate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // 1. Снимаем пробелы, дефисы, пунктуацию. Верхний регистр.
  let s = String(raw).replace(/[\s\-_.,;:]/g, '').toUpperCase();
  if (s.length < 8 || s.length > 9) return null;

  // 2. Транслит латиница → кириллица для допустимых букв
  s = Array.from(s).map(ch => LAT_TO_CYR[ch] ?? ch).join('');

  // 3. Контекстная коррекция «O/0», «З/3», «I/1» в зависимости от позиции:
  //    позиции 0, 4, 5 — буквы; 1, 2, 3, 6, 7, 8 — цифры
  const out = Array.from(s);
  const letterPositions = [0, 4, 5];
  const digitPositions = s.length === 8 ? [1, 2, 3, 6, 7] : [1, 2, 3, 6, 7, 8];

  for (const i of letterPositions) {
    if (i >= out.length) continue;
    if (out[i] === '0') out[i] = 'О';        // ноль → О
    else if (out[i] === '3') out[i] = 'З';   // 3 → З (хотя З не разрешена в плате — но если так — отвалится regex'ом)
    else if (out[i] === '8') out[i] = 'В';   // 8 → В
    else if (out[i] === '1') out[i] = null!; // 1 не маппится в букву — пусть отвалится
  }
  for (const i of digitPositions) {
    if (i >= out.length) continue;
    if (out[i] === 'О') out[i] = '0';
    else if (out[i] === 'З') out[i] = '3';
    else if (out[i] === 'В' || out[i] === 'I') out[i] = out[i] === 'I' ? '1' : '8';
  }
  const normalized = out.join('');

  // 4. Проверяем что результат — допустимая регистрационная маска
  if (!PLATE_RE.test(normalized)) return null;
  return normalized;
}

/**
 * Расстояние Левенштейна, ограниченное `maxDistance` (для производительности
 * прерываемся, как только текущее значение превысит порог). Используется
 * SLAI-стороной для fuzzy-матчинга номеров водителя, ФИО и т.п. когда
 * normalizePlate вернул null, но шанс что это «почти он» есть.
 */
export function damerauLevenshtein(a: string, b: string, maxDistance = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1; // early exit
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
