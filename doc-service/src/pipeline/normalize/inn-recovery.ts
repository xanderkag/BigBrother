/**
 * Восстановление ИНН сторон из raw OCR-текста — страховка на случай, когда
 * модель не извлекла ИНН, который в документе стоит явно.
 *
 * Зачем отдельный шаг (а не F1 normalizeExtractedFields):
 *   F1 канонизирует то, что **дала модель**. Когда модель вернула
 *   placeholder («не указан») или вовсе пропустила поле — F1 бессилен:
 *   normalizeInn('не указан') → null, нормализовать нечего. Но в первичке
 *   РФ ИНН всегда стоит рядом с меткой стороны:
 *     «Поставщик: OОО «…», ИНН 7722753969, КПП 997750001»
 *     «Покупатель: … ИНН 7811472920, КПП 784201001»
 *   так что детерминированно достать его из текста надёжно и обще — это не
 *   подгонка под один файл, а доменно-корректный fallback на флапы LLM.
 *   (Реальный кейс: счёт с QR-баннером «оплати в один клик» в начале —
 *   mistral теряется в преамбуле и пишет seller/buyer.inn = «не указан».)
 *
 * Контракт:
 *   - Срабатывает ТОЛЬКО когда текущее значение пути не является валидным
 *     ИНН (normalizeInn → null): undefined / '' / 'не указан' / мусор.
 *     Валидный ИНН от модели НИКОГДА не перетираем.
 *   - Кандидат из текста принимается ТОЛЬКО если прошёл checksum
 *     (normalizeInn). Это отсекает КПП, номера счетов и OCR-мусор.
 *   - Поиск идёт в окне метки стороны (от метки до следующей метки),
 *     чтобы ИНН поставщика не утёк в покупателя и наоборот.
 *   - Pure / идемпотентна. Найденное помечается в `_inn_recovered`
 *     (отдельный аудит-канал: оператор видит, что значение добито из текста,
 *     а не распознано моделью).
 *
 * Порядок: запускается ПЕРВЫМ (F0), до F1 — тогда F1 подхватит добитый ИНН
 * в `_normalized_fields` как обычный.
 */
import { normalizeInn } from './identifiers.js';

/**
 * Метка стороны → ключ объекта в `extracted`, у которого правим `.inn`.
 * Порядок не важен (окна считаем по позициям всех меток сразу), но список
 * покрывает стандартные стороны первички. Бара «Получатель»/«Плательщик»
 * без уточнения намеренно осторожны — они часто встречаются в блоке банка.
 */
const LABEL_TO_PARTY: ReadonlyArray<readonly [string, string]> = [
  ['поставщик', 'seller'],
  ['продавец', 'seller'],
  ['покупатель', 'buyer'],
  ['заказчик', 'buyer'],
  ['грузоотправитель', 'shipper'],
  ['грузополучатель', 'consignee'],
  ['перевозчик', 'carrier'],
  ['плательщик', 'payer'],
];

// Combined label regex. Длинные альтернативы раньше коротких неактуально
// (пересечений по подстроке между метками нет: «грузополучатель» не ловится
// как «получатель», т.к. бары «получатель» в списке нет).
const LABEL_RE = new RegExp(
  `(${LABEL_TO_PARTY.map(([l]) => l).join('|')})\\s*:?`,
  'gi',
);

// ИНН рядом с (опциональным) «/КПП». Charclass между «инн» и цифрами не
// содержит букв, поэтому «ИНН 7722753969, КПП 997750001» возьмёт ровно
// 10 цифр ИНН, а не склеит с КПП. (?!\\d) не даёт обрезать 12-значный ИНН
// до 10. 12-значная альтернатива раньше 10-значной.
const INN_NEAR_RE = /инн(?:\s*\/?\s*кпп)?[\s:№#\/]*(\d{12}|\d{10})(?!\d)/i;

// Сколько символов после метки сканировать, если следующей метки нет рядом.
const WINDOW_CHARS = 400;

/**
 * FIX-B (находки SLAI 2026-07-16, docs/BCTT_EXTRACT_FIXES.md).
 *
 * Маркеры банковского блока. ИНН внутри платёжных реквизитов принадлежит
 * БАНКУ, а не стороне: «Банк получателя: ПАО СБЕРБАНК · ИНН 7707083893 ·
 * БИК 044525225 · Сч. № …». Такой ИНН настоящий и проходит checksum, поэтому
 * прежний «первый ИНН в окне» его молча принимал.
 *
 * Реальный кейс (заказ #5 БКТ): `inv_1.jpeg` + `pac_1.jpeg` → seller.inn =
 * 7707083893 = ИНН ПАО «Сбербанк», при том что продавец — SIA BALTEREX
 * (Латвия), у которой российского ИНН быть не может в принципе.
 *
 * Почему это дороже явного промаха: ОБА документа дают ОДНО И ТО ЖЕ значение,
 * поэтому кросс-документная сверка на стороне SLAI считает поле «сошедшимся» и
 * красит зелёным. Контрольная сумма проходит, ЕГРЮЛ проходит — ИНН реальный,
 * просто ЧУЖОЙ. Систематическая ошибка выглядит как подтверждённая истина.
 */
const BANK_MARKER_RE = /банк|бик\b|к\/с|кор(?:р|\.)\s*сч|корсчет|корреспондент|сч\.\s*№|р\/с/i;

/** Страна стороны, при которой российский ИНН невозможен. */
function partyIsForeign(extracted: Record<string, unknown>, party: string): boolean {
  const obj = extracted[party];
  if (!obj || typeof obj !== 'object') return false;
  const country = (obj as Record<string, unknown>).country;
  if (typeof country !== 'string' || country.trim().length === 0) return false;
  const c = country.trim().toUpperCase();
  // Пусто/RU/РФ/Россия — «наша» сторона, ИНН допустим. Всё остальное —
  // иностранец: росс. ИНН ему не подставляем (просьба SLAI).
  return !['RU', 'РФ', 'RUS', 'РОССИЯ', 'RUSSIA'].includes(c);
}

function partyInnIsValid(extracted: Record<string, unknown>, party: string): boolean {
  const obj = extracted[party];
  if (!obj || typeof obj !== 'object') return false;
  const inn = (obj as Record<string, unknown>).inn;
  return normalizeInn(inn) !== null;
}

/**
 * Достаёт из `rawText` ИНН сторон и добивает им пустые/placeholder-поля в
 * `extracted`. Возвращает НОВЫЙ объект если что-то изменилось, иначе —
 * исходный (как остальные нормализаторы).
 */
export function recoverPartyInnsFromText(
  extracted: Record<string, unknown> | null,
  rawText: string | null | undefined,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (!rawText || typeof rawText !== 'string' || rawText.length === 0) return extracted;

  // Все вхождения меток сторон с позициями (для оконных границ).
  const labels: Array<{ index: number; end: number; party: string }> = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(rawText)) !== null) {
    const word = m[1]!.toLowerCase();
    const pair = LABEL_TO_PARTY.find(([l]) => l === word);
    if (pair) labels.push({ index: m.index, end: m.index + m[0].length, party: pair[1] });
  }
  if (labels.length === 0) return extracted;

  // Границы окна метки — до начала следующей метки (по позиции в тексте),
  // но не дальше WINDOW_CHARS. Так ИНН поставщика не утечёт в покупателя.
  const sortedStarts = labels.map((l) => l.index).sort((a, b) => a - b);

  const recovered: Record<string, string> = {};
  for (const lbl of labels) {
    // Уже валидный ИНН (от модели или добитый ранее в этом цикле) не трогаем.
    if (partyInnIsValid(extracted, lbl.party) || recovered[`${lbl.party}.inn`]) continue;
    // FIX-B: иностранной стороне российский ИНН не подставляем.
    if (partyIsForeign(extracted, lbl.party)) continue;

    const nextStart = sortedStarts.find((s) => s > lbl.index);
    const windowEnd = Math.min(
      nextStart ?? rawText.length,
      lbl.end + WINDOW_CHARS,
      rawText.length,
    );
    const fullWindow = rawText.slice(lbl.end, windowEnd);
    // FIX-B: обрезаем окно на первом банковском маркере. Собственный ИНН
    // стороны стоит рядом с её названием — ДО платёжного блока; всё, что после
    // «Банк получателя:» / «БИК» / «Сч. №», принадлежит банку. Прежний «первый
    // ИНН в окне» захватывал ИНН Сбербанка и выдавал его за продавца.
    //
    // Осознанный компромисс: если в НАЗВАНИИ стороны есть слово «банк»
    // («ООО Банк-Сервис»), окно схлопнется и ИНН не добьётся. Это безопасный
    // недобор — функция и так best-effort fallback на флапы LLM, а промах в
    // другую сторону (чужой ИНН) даёт ложно-зелёную сверку у потребителя.
    const bankAt = fullWindow.search(BANK_MARKER_RE);
    const window = bankAt >= 0 ? fullWindow.slice(0, bankAt) : fullWindow;
    const found = window.match(INN_NEAR_RE);
    if (!found) continue;
    const canonical = normalizeInn(found[1]);
    if (canonical === null) continue; // не прошёл checksum → не ИНН
    recovered[`${lbl.party}.inn`] = canonical;
  }

  if (Object.keys(recovered).length === 0) return extracted;

  // Иммутабельно: клонируем верх + только затронутые party-объекты.
  const next: Record<string, unknown> = { ...extracted };
  for (const [path, inn] of Object.entries(recovered)) {
    const party = path.split('.')[0]!;
    const existing = next[party];
    const partyObj =
      existing && typeof existing === 'object'
        ? { ...(existing as Record<string, unknown>) }
        : {};
    partyObj.inn = inn;
    next[party] = partyObj;
  }
  const prevAudit = (extracted._inn_recovered as Record<string, string>) ?? {};
  next._inn_recovered = { ...prevAudit, ...recovered };
  return next;
}
