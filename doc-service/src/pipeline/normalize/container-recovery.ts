/**
 * Восстановление номера контейнера (ISO 6346) из raw OCR-текста — страховка
 * на случай, когда модель не извлекла контейнер, явно стоящий в документе.
 *
 * Зачем отдельный шаг (по образцу inn-recovery F0):
 *   Номер контейнера — строгий формат (ISO 6346: 4 буквы + 7 цифр), а phi4
 *   на крупных схемах (CMR с cargo/items/множеством сторон) возвращает только
 *   «канонические» поля и отбрасывает хвостовые `containers`/`container_number`
 *   — даже когда в тексте стоит явное «Контейнер: TCLU7654321» (подтверждено
 *   живым прогоном Q15: TTN извлекался, CMR — нет, при идентичной строке).
 *   Для строгого формата детерминированный regex надёжнее LLM и не зависит от
 *   капризов модели на конкретном типе.
 *
 * Контракт:
 *   - Срабатывает ТОЛЬКО когда у документа НЕТ валидного контейнера (ни
 *     `container_number`, ни `containers[].number`, ни `items[].container_no`,
 *     проходящего ISO 6346). Извлечённое моделью НИКОГДА не перетираем.
 *   - Кандидат принимается ТОЛЬКО в окне после метки «контейнер»/«container»
 *     (anti-false-positive: случайный токен 4 буквы+7 цифр без метки не берём).
 *   - Найденное кладём в `containers[]` (канонический мульти-контейнерный
 *     путь, который читает collectContainers) + помечаем в
 *     `_container_recovered` (аудит: добито из текста, не распознано моделью).
 *   - Pure / идемпотентна.
 *
 * Порядок: рядом с F0 (recoverPartyInnsFromText), до buildMatchSignals —
 * чтобы добитый контейнер попал в `_match_signals.containers`.
 */

const ISO6346_RE = /^[A-Z]{4}\d{7}$/;

// Метка контейнера. «контейн» покрывает контейнер/контейнера/контейнере/
// контейнерный; «container»/«конт.» — англ. и сокращение.
const LABEL_RE = /(контейн[а-я]*|container|\bконт\.?)/gi;

// Кандидат ISO 6346 внутри окна (case-insensitive, нормализуем к upper).
const CAND_RE = /[A-Za-z]{4}\d{7}/g;

// Окно после метки: номер обычно вплотную («Контейнер: TCLU7654321»). 80
// символов с запасом на разделители/перенос строки, но не дальше — чтобы не
// утащить номер из соседнего блока.
const WINDOW_CHARS = 80;

function hasValidContainer(extracted: Record<string, unknown>): boolean {
  const isIso = (v: unknown): boolean =>
    typeof v === 'string' && ISO6346_RE.test(v.replace(/\s/g, '').toUpperCase());

  if (isIso(extracted.container_number)) return true;

  const cont = extracted.container;
  if (cont && typeof cont === 'object' && isIso((cont as Record<string, unknown>).number)) return true;

  const containers = extracted.containers;
  if (Array.isArray(containers)) {
    for (const c of containers) {
      if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        if (isIso(o.number) || isIso(o.container_number)) return true;
      }
    }
  }

  const items = extracted.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === 'object' && isIso((it as Record<string, unknown>).container_no)) return true;
    }
  }

  return false;
}

/**
 * Достаёт из `rawText` номера контейнеров (по метке) и добивает ими документ,
 * если модель контейнер не вернула. Возвращает НОВЫЙ объект если что-то
 * изменилось, иначе — исходный (как остальные нормализаторы).
 */
export function recoverContainersFromText(
  extracted: Record<string, unknown> | null,
  rawText: string | null | undefined,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (!rawText || typeof rawText !== 'string' || rawText.length === 0) return extracted;
  // Модель уже дала валидный контейнер — не вмешиваемся.
  if (hasValidContainer(extracted)) return extracted;

  const found: string[] = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(rawText)) !== null) {
    const windowStart = m.index + m[0].length;
    const window = rawText.slice(windowStart, windowStart + WINDOW_CHARS);
    CAND_RE.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = CAND_RE.exec(window)) !== null) {
      const norm = c[0].toUpperCase();
      if (ISO6346_RE.test(norm) && !found.includes(norm)) found.push(norm);
    }
  }

  if (found.length === 0) return extracted;

  const next: Record<string, unknown> = {
    ...extracted,
    containers: found.map((number) => ({ number })),
  };
  const prevAudit = Array.isArray(extracted._container_recovered)
    ? (extracted._container_recovered as string[])
    : [];
  next._container_recovered = [...new Set([...prevAudit, ...found])];
  return next;
}
