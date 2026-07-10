/**
 * Quality assessment — детектор «странного» разбора (2026-07-10).
 *
 * Задача: после extract'а автоматически понять, выглядит ли разбор
 * подозрительно, ДО того как отдать его как готовый. Если да —
 * orchestrator запускает авто-переразбор через другой провайдер (1 попытка),
 * и только если и это не помогло — уводит в needs_review для человека.
 *
 * Мотивация (реальные кейсы боевого потока SLAI):
 *   - qwen3-vl:32b на длинных JSON-схемах тратит output-бюджет на «thinking»
 *     и возвращает 0 бизнес-полей при высоком classify-confidence;
 *   - OCR (tesseract rus+eng) на смешанных лат/кир сканах даёт мусор
 *     (`FESCO` → `РЕЗСО`), extract потом сыпется;
 *   - контекст 8k у vLLM обрезал крупные ГТД → truncated JSON.
 *
 * Каждый фактор — булев сигнал + вес. Сумма весов сработавших факторов =
 * strangeness score. Порог REQUALITY_THRESHOLD решает «переразобрать».
 * Веса подобраны так, чтобы ОДИН тяжёлый фактор (empty extract, truncation)
 * уже перекрывал порог, а слабые (мало полей) — только в сумме.
 */

export type QualityFactor = {
  /** Машинный код фактора — для метрик и логов. */
  code: string;
  /** Человекочитаемое описание — для issue в UI и needs_review. */
  message: string;
  /** Вес вклада в strangeness score. */
  weight: number;
};

export type QualityAssessment = {
  /** Суммарный score странности (0 = чисто, выше = подозрительнее). */
  score: number;
  /** Сработавшие факторы. */
  factors: QualityFactor[];
  /** score >= REQUALITY_THRESHOLD — рекомендуется авто-переразбор. */
  shouldRequality: boolean;
};

/**
 * Порог, при котором рекомендуем авто-переразбор. Откалиброван так, что
 * один «тяжёлый» фактор (вес ≥1.0) уже пробивает, а лёгкие копятся.
 */
export const REQUALITY_THRESHOLD = 1.0;

export type QualityInput = {
  /** Извлечённые данные (уже без служебных `_*` ключей на верхнем уровне). */
  extracted: Record<string, unknown>;
  /** Ожидаемые поля типа (document_types.expected_fields). */
  expectedFields: string[];
  /** Список НЕзаполненных ожидаемых полей (parser.missing). */
  missing: string[];
  /** Итоговый (combined) confidence. */
  confidence: number;
  /** Сырой ответ модели — для детекта reasoning-bleed / отказа. */
  rawResponse?: string | null;
  /** OCR-текст — для детекта мусорного распознавания. */
  ocrText?: string | null;
};

/** Считает заполненные бизнес-поля верхнего уровня (без служебных `_*`). */
function countBusinessFields(extracted: Record<string, unknown>): number {
  let n = 0;
  for (const key of Object.keys(extracted)) {
    if (key.startsWith('_')) continue;
    const v = extracted[key];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n += 1;
  }
  return n;
}

/**
 * Детект «мусорного OCR» на латинско-кириллических сканах: tesseract
 * распознаёт латиницу как визуально похожую кириллицу (`W`→`Ш`, `E`→`Е`).
 * Признак — высокая доля кириллических букв внутри слов, где рядом стоят
 * латинские (типичный лат-документ с кириллическими «вкраплениями» —
 * артефакт). Грубая эвристика, но ловит худшие случаи.
 *
 * Возвращает долю «подозрительных» смешанных токенов [0..1].
 */
function garbledOcrRatio(text: string): number {
  if (!text || text.length < 50) return 0;
  const tokens = text.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return 0;
  let mixed = 0;
  for (const tok of tokens) {
    const hasLatin = /[A-Za-z]/.test(tok);
    const hasCyr = /[А-Яа-яЁё]/.test(tok);
    // Один токен содержит И латиницу И кириллицу = почти всегда OCR-мусор
    // (реальные слова не смешивают алфавиты внутри слова).
    if (hasLatin && hasCyr) mixed += 1;
  }
  return mixed / tokens.length;
}

/**
 * Детект reasoning-bleed: модель начала ответ с «размышления» вместо JSON.
 * Признак — до первой `{` идёт заметный текст с маркерами рассуждения.
 */
function hasReasoningBleed(raw: string): boolean {
  if (!raw) return false;
  const firstBrace = raw.indexOf('{');
  const prefix = (firstBrace === -1 ? raw : raw.slice(0, firstBrace)).toLowerCase();
  if (prefix.length < 40) return false;
  return /(here'?s|let me|thinking|reasoning|i'?ll|first,|okay,|давайте|разбер|подума)/i.test(prefix);
}

/**
 * Детект обрыва JSON: ответ выглядит как незакрытый объект (модель уперлась
 * в max_tokens посреди генерации). Признак — есть `{`, но нет балансной `}`.
 */
function looksTruncated(raw: string): boolean {
  if (!raw) return false;
  const opens = (raw.match(/\{/g) ?? []).length;
  const closes = (raw.match(/\}/g) ?? []).length;
  return opens > 0 && closes < opens;
}

/**
 * Оценивает разбор по набору факторов «странности». Чистый разбор → score 0,
 * пустой массив factors. Подозрительный → score > 0 + список причин.
 */
export function assessQuality(input: QualityInput): QualityAssessment {
  const factors: QualityFactor[] = [];
  const businessFields = countBusinessFields(input.extracted);
  const expectedCount = input.expectedFields.length;

  // ── Фактор 1: пустое извлечение (вес 1.5 — самый тяжёлый) ──────────
  if (businessFields === 0) {
    factors.push({
      code: 'empty_extract',
      message: 'модель вернула 0 бизнес-полей',
      weight: 1.5,
    });
  }

  // ── Фактор 2: высокий confidence + мало полей ─────────────────────
  // Модель «уверена», но заполнила < 30% ожидаемых. Часто — обрыв или
  // частичный ответ, который прошёл по confidence classify-этапа.
  if (
    expectedCount >= 4 &&
    businessFields > 0 &&
    input.confidence >= 0.8 &&
    input.missing.length > expectedCount * 0.7
  ) {
    factors.push({
      code: 'confident_sparse',
      message: `уверенность ${input.confidence.toFixed(2)} при заполнено ${businessFields}/${expectedCount} полей`,
      weight: 0.6,
    });
  }

  // ── Фактор 3: обрыв JSON по контексту (вес 1.0) ───────────────────
  if (input.rawResponse && looksTruncated(input.rawResponse)) {
    factors.push({
      code: 'truncated_json',
      message: 'ответ модели оборван (несбалансированные скобки — упор в лимит токенов)',
      weight: 1.0,
    });
  }

  // ── Фактор 4: reasoning-bleed (вес 1.0) ───────────────────────────
  if (input.rawResponse && hasReasoningBleed(input.rawResponse)) {
    factors.push({
      code: 'reasoning_bleed',
      message: 'модель выдала «размышления» вместо чистого JSON',
      weight: 1.0,
    });
  }

  // ── Фактор 5: мусорный OCR (вес 0.7) ──────────────────────────────
  if (input.ocrText) {
    const garbled = garbledOcrRatio(input.ocrText);
    if (garbled > 0.15) {
      factors.push({
        code: 'garbled_ocr',
        message: `OCR подозрителен: ${Math.round(garbled * 100)}% токенов смешивают лат/кириллицу`,
        weight: 0.7,
      });
    }
  }

  const score = factors.reduce((sum, f) => sum + f.weight, 0);
  return {
    score,
    factors,
    shouldRequality: score >= REQUALITY_THRESHOLD,
  };
}
