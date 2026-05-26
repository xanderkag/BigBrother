/**
 * Hybrid extraction routing (SLAI backlog Sequencing #3).
 *
 * После OCR + classify, перед extract, выбираем PATH per-job:
 *   - text  → быстрый text-провайдер (phi4), в SLA, без картинки;
 *   - vision → designated vision-провайдер (Qwen-VL) + картинка первой страницы.
 *
 * Решение строится на «дешёвых» сигналах, уже посчитанных к этому моменту
 * (OCR-результат + per-type/per-job флаги) — никаких новых тяжёлых вызовов.
 *
 * Гейтится `HYBRID_ROUTING_ENABLED`. При выключенном флаге роутер НЕ
 * вмешивается — orchestrator идёт по старому пути (provider.vision +
 * metadata._extract_from_image работают как раньше).
 *
 * Модуль чистый/синхронный для decideExtractPath() (легко тестировать без
 * БД); резолв конкретного vision-провайдера — отдельная async-функция,
 * которая ходит в provider_settings и fail-soft возвращает null.
 */

import type { Logger } from 'pino';
import type { OcrEngineName } from '../types/documents.js';
import { providerSettingsRepo } from '../storage/provider-settings.js';

/** Какой extract-путь выбран и почему (пишется в pipeline step). */
export type ExtractMode = 'text' | 'vision';

export type RouteReason =
  | 'forced_image' // metadata._extract_from_image=true
  | 'forced_text' // metadata._extract_from_text=true
  | 'prefer_vision' // document_types.prefer_vision=true
  | 'low_ocr_conf' // OCR confidence ниже порога
  | 'scan_engine' // победил scan-движок (tesseract/vision-llm) или вход — image
  | 'short_text' // подозрительно мало текста на число страниц
  | 'clean_text'; // чистый текстовый слой → быстрый text-путь

export type RouteDecision = {
  mode: ExtractMode;
  reason: RouteReason;
};

/**
 * Сигналы для решения. Всё уже доступно после OCR/classify — роутер ничего
 * не вычисляет заново.
 */
export type RouteSignals = {
  /** Победивший OCR-движок. */
  ocrEngine: OcrEngineName;
  /** OCR confidence 0..1. */
  ocrConfidence: number;
  /** Длина извлечённого текста (после sanitize), символов. */
  textLength: number;
  /** Число страниц/листов (если известно). */
  pageCount: number;
  /** Был ли вход уже изображением (image/* MIME). */
  isImageInput: boolean;
  /** Per-type prefer_vision из document_types (ResolvedTypeConfig). */
  preferVision: boolean;
  /** metadata._extract_from_image=true. */
  forceImage: boolean;
  /** metadata._extract_from_text=true. */
  forceText: boolean;
};

export type RouteConfig = {
  /** OCR confidence ниже этого порога → нужен vision. */
  visionConfThreshold: number;
};

/**
 * Движки, которые означают «текстового слоя не было» — документ растеризовался
 * и распознавался по картинке. pdf-text/xlsx/docx — наоборот, нативный текст.
 */
const SCAN_ENGINES: ReadonlySet<OcrEngineName> = new Set<OcrEngineName>([
  'tesseract',
  'vision-llm',
  'yandex',
]);

/** Эвристика «подозрительно мало текста»: < этого числа символов на страницу. */
const MIN_CHARS_PER_PAGE = 80;

/**
 * Чистое решение по сигналам. Приоритет (от старшего к младшему):
 *   1. forceText  → text  (явный per-job override, побеждает всё);
 *   2. forceImage → vision (явный per-job override);
 *   3. preferVision (per-type) → vision;
 *   4. scan-движок / image-вход → vision;
 *   5. низкая OCR-уверенность → vision;
 *   6. подозрительно короткий текст → vision;
 *   7. иначе → text (clean_text).
 */
export function decideExtractPath(signals: RouteSignals, cfg: RouteConfig): RouteDecision {
  // forceText старше forceImage: если оператор явно просил text, уважаем это
  // даже при противоречивом forceImage (детерминированность > удобство).
  if (signals.forceText) return { mode: 'text', reason: 'forced_text' };
  if (signals.forceImage) return { mode: 'vision', reason: 'forced_image' };
  if (signals.preferVision) return { mode: 'vision', reason: 'prefer_vision' };
  if (signals.isImageInput || SCAN_ENGINES.has(signals.ocrEngine)) {
    return { mode: 'vision', reason: 'scan_engine' };
  }
  if (signals.ocrConfidence < cfg.visionConfThreshold) {
    return { mode: 'vision', reason: 'low_ocr_conf' };
  }
  const pages = Math.max(1, signals.pageCount);
  if (signals.textLength < pages * MIN_CHARS_PER_PAGE) {
    return { mode: 'vision', reason: 'short_text' };
  }
  return { mode: 'text', reason: 'clean_text' };
}

/**
 * Резолв id designated vision-провайдера. Сначала явный
 * `HYBRID_VISION_PROVIDER_ID` (если строка существует, активна и vision),
 * иначе автоподбор активной vision-строки. Fail-soft: любая ошибка/отсутствие
 * → null, caller откатывается на text-путь (job не падает).
 *
 * Возвращаем id (а не client), чтобы orchestrator переиспользовал готовый
 * `dynamicLlm.withForceProvider(id, ...)` ALS-механизм.
 */
export async function resolveVisionProviderId(
  explicitId: string | undefined,
  log: Logger,
): Promise<string | null> {
  try {
    if (explicitId && explicitId.length > 0) {
      const row = await providerSettingsRepo.findById(explicitId);
      if (row && row.kind === 'llm' && row.is_active && row.vision) {
        return row.id;
      }
      log.warn(
        { hybrid_vision_provider_id: explicitId },
        'HYBRID_VISION_PROVIDER_ID не найден / не активен / не vision — пробуем автоподбор',
      );
    }
    const auto = await providerSettingsRepo.findActiveVision();
    return auto?.id ?? null;
  } catch (err) {
    log.warn({ err }, 'resolveVisionProviderId failed (fail-soft → text path)');
    return null;
  }
}
