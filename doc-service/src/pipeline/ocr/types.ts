import type { OcrEngineName } from '../../types/documents.js';

export type OcrInput = {
  filePath: string;
  mimeType: string;
  /**
   * Pre-rasterized page PNGs for PDF inputs, produced once by the orchestrator
   * before the engine chain runs. When present, engines skip their own pdftoppm
   * call and operate directly on these files. The orchestrator owns the tmpdir
   * and cleans it up after the chain completes (A5 fix — no double rasterization).
   */
  rasterizedPages?: string[];
  /**
   * F26 (SLAI ТЗ): per-job override Tesseract languages. Если задан —
   * используется вместо `TESSERACT_LANGS` env-default. Формат как у Tesseract
   * (плюс через `+`): `rus+eng+chi_sim`. Допустимые языки определяются
   * установленными в Docker tessdata pack'ами (см. Dockerfile).
   *
   * Use case: SLAI logist шлёт packing list с AliExpress на китайском, в
   * `metadata.tesseract_langs: "rus+eng+chi_sim"`. Без override — Tesseract
   * читает только rus+eng и не справится с китайскими иероглифами.
   */
  tesseractLangsOverride?: string;
  /**
   * Per-job override OCR-модели Yandex recognizeText (`metadata._yandex_ocr_model`).
   * Если задан — побеждает и `YANDEX_OCR_MODEL`, и per-type `tableModel`.
   * Формат как у Yandex: `page` | `table` | `page-column-sort` | `handwritten`.
   * Используется только YandexVisionEngine; остальные движки игнорируют.
   */
  yandexModelOverride?: string;
  /**
   * Slug типа документа (из document_hint / classifier). YandexVisionEngine
   * использует его, чтобы выбрать `tableModel` для типов из
   * `YANDEX_TABLE_MODEL_TYPES`. Остальные движки игнорируют.
   */
  documentType?: string;
};

/**
 * XLSX-FAST: исходная матрица листа (строки × колонки) ДО расплющивания в текст.
 *
 * Зачем: у Excel структура таблицы уже есть — мы её читаем, схлопываем в CSV-текст
 * и потом платим модели 20+ вызовов, чтобы она эту же структуру восстановила
 * (замер 2026-07-24: у проформ/прайсов ~21 вызов, 2-7 минут на документ, при этом
 * само чтение файла — 0.2с). Донеся матрицу до парсера, можно разметить колонки
 * ОДНИМ вызовом и разложить все строки кодом.
 *
 * Заполняет только xlsx-движок; остальные оставляют undefined.
 */
export type OcrTable = {
  sheet: string;
  /** Строки листа; ячейки уже приведены к строкам и обрезаны по краям. */
  rows: string[][];
};

export type OcrResult = {
  engine: OcrEngineName;
  text: string;
  confidence: number; // 0..1
  pages?: Array<{ text: string; confidence: number }>;
  /** XLSX-FAST: структура таблиц (только xlsx). См. OcrTable. */
  tables?: OcrTable[];
  durationMs: number;
};

export interface OcrEngine {
  readonly name: OcrEngineName;

  /** Whether this engine can in principle handle the given input. */
  supports(input: OcrInput): boolean;

  /** Whether this engine is configured (e.g., has API credentials). Disabled engines are skipped. */
  isAvailable(): boolean;

  /**
   * Confidence threshold above which the orchestrator stops trying further engines.
   * Returning a low value forces the orchestrator to keep falling through.
   */
  readonly acceptanceThreshold: number;

  run(input: OcrInput): Promise<OcrResult>;
}
