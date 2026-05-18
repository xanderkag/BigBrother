/**
 * Детектор «модель отказалась смотреть изображение».
 *
 * Background (2026-05-18, real bug на VED-кейсе EWL-AME/180723):
 *   `eac-cert.pdf` — скан-сертификат соответствия без текстового слоя
 *   PDF. pdftoppm выдаёт 4 страницы изображений → vision-LLM по очереди
 *   на каждую вернул «Извините, я не могу просматривать изображения».
 *   raw_text заполнился 4 копиями этого извинения, pipeline принял его
 *   за валидный OCR-результат, classifier нашёл NULL (никакой keyword
 *   не подошёл), и job завершился со статусом `done`, document_type=NULL.
 *
 * Это «тихий провал» — оператор видит «done» в UI, но реально модель
 * вообще не прочитала документ. Детектор разрывает цепочку: если raw_text
 * выглядит как rejection — pipeline маркирует job как `failed` с понятной
 * ошибкой "OCR_REFUSED", и оператор сразу знает что нужен другой OCR
 * движок или ручной разбор.
 *
 * Эвристика: набор паттернов, и если >= 30% от длины текста занято
 * матчем (или текст короткий и хотя бы один паттерн матчит) — считаем
 * отказом. Это покрывает 2 случая:
 *   - короткий вывод модели (single refusal sentence)
 *   - длинный output с повтором отказа N раз
 */

// Паттерны отказа. Регистронечувствительные, многоязычные.
// Источник: реальные ответы Claude / GPT-4 / Qwen-VL / Gemma-vision когда
// они видят пустое изображение, отказываются на text-prompt без image_url,
// или blocked safety policy.
const REFUSAL_PATTERNS = [
  // RU
  /извините,?\s+я\s+не\s+могу\s+просматривать\s+изображения/i,
  /я\s+не\s+могу\s+просматривать\s+изображения/i,
  /я\s+не\s+могу\s+видеть\s+изображени/i,
  /я\s+не\s+могу\s+прочитать\s+изображени/i,
  /я\s+не\s+могу\s+обработать\s+изображени/i,
  /я\s+не\s+могу\s+проанализировать\s+изображени/i,
  /я\s+не\s+вижу\s+(?:никакого\s+)?(?:изображения|картинки|документа)/i,
  /у\s+меня\s+нет\s+возможности\s+(?:просматривать|видеть)/i,
  /пожалуйста,?\s+(?:скопируйте|вставьте)\s+(?:текст|содержимое)/i,
  // EN
  /i\s+(?:cannot|can'?t|am\s+unable\s+to)\s+(?:view|see|read|process|analyze)\s+(?:images?|pictures?|attachments?)/i,
  /i\s+don'?t\s+(?:have\s+the\s+ability|see)\s+(?:to\s+(?:view|see|process)|any\s+image)/i,
  /sorry,?\s+i\s+(?:cannot|can'?t|am\s+unable)/i,
  /i\s+(?:am\s+)?unable\s+to\s+(?:view|see|process|read)/i,
  /(?:please|kindly)\s+(?:copy|paste|provide)\s+(?:the\s+)?text/i,
  // ZH (Qwen иногда сваливается в китайский)
  /我\s*无法\s*查看\s*图(?:像|片)/,
  /抱歉.{0,20}无法\s*(?:查看|处理|分析)/,
];

const TEXT_TOO_SHORT_THRESHOLD = 800; // chars — короткий output (<800) с любым refusal-pattern = отказ
const REFUSAL_COVERAGE_THRESHOLD = 0.3; // 30% длины покрыто refusal-pattern'ами → отказ

export interface RefusalDetectionResult {
  isRefusal: boolean;
  /** Какой паттерн сматчился (для логов) */
  pattern?: string;
  /** Сколько символов покрыто матчами / общая длина */
  coverage?: number;
  /** Preview первого матча (для UI) */
  preview?: string;
}

/**
 * Анализирует OCR-output на признаки отказа модели прочитать изображение.
 *
 * Логика:
 *   1. Если хотя бы один pattern матчит И текст короткий (<800 chars) — отказ.
 *   2. Если patterns занимают суммарно ≥30% длины текста — отказ.
 *   3. Иначе — обычный текст.
 *
 * Не помечает отказом длинные документы где refusal-фраза встретилась
 * один раз в теле (например, договор который упоминает «не можем
 * предоставить изображение оригинала» — это валидный документ, не
 * вывод LLM).
 */
export function detectOcrRefusal(text: string): RefusalDetectionResult {
  if (!text || text.length === 0) {
    return { isRefusal: false };
  }

  // Сборка покрытия + first-match для отчёта
  let totalCovered = 0;
  let firstPattern: string | undefined;
  let firstPreview: string | undefined;

  for (const re of REFUSAL_PATTERNS) {
    // Глобальный обход без флага 'g' — делаем вручную через exec в цикле.
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      totalCovered += m[0].length;
      if (!firstPattern) {
        firstPattern = re.source;
        // Захват с контекстом: ~80 chars вокруг матча
        const start = Math.max(0, m.index - 20);
        const end = Math.min(text.length, m.index + m[0].length + 60);
        firstPreview = text.slice(start, end).trim();
      }
      // Защита от zero-width матчей (хотя patterns такие не используют).
      if (m[0].length === 0) globalRe.lastIndex += 1;
    }
  }

  if (totalCovered === 0) {
    return { isRefusal: false };
  }

  const coverage = totalCovered / text.length;
  const isShortRefusal = text.length < TEXT_TOO_SHORT_THRESHOLD;
  const isHighCoverage = coverage >= REFUSAL_COVERAGE_THRESHOLD;

  if (isShortRefusal || isHighCoverage) {
    return {
      isRefusal: true,
      pattern: firstPattern,
      coverage: Math.round(coverage * 100) / 100,
      preview: firstPreview,
    };
  }

  return { isRefusal: false, coverage: Math.round(coverage * 100) / 100 };
}

/**
 * Кастомная ошибка. Orchestrator должен ловить её и финализировать job
 * со статусом `failed` + понятным error-кодом, чтобы оператор сразу
 * понял что это OCR-отказ, а не общая регрессия.
 */
export class OcrRefusedError extends Error {
  constructor(
    public readonly engine: string,
    public readonly detection: RefusalDetectionResult,
  ) {
    super(
      `OCR engine "${engine}" вернул отказ модели вместо текста ` +
        `(coverage=${(detection.coverage ?? 0) * 100}%). ` +
        `Это типично для скан-PDF без текстового слоя: vision-LLM не смогла прочитать ` +
        `изображение. Попробуйте: загрузить PDF с текстовым слоем, использовать другой OCR ` +
        `(Tesseract / Yandex Vision), или ручной разбор.`,
    );
    this.name = 'OcrRefusedError';
  }
}
