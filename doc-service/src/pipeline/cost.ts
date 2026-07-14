/**
 * Оценка стоимости разбора документа в ₽ (owner-запрос 2026-07-13, триггер:
 * ~600₽ на eval-прогонах БКТ). Считает по фактическому расходу задачи:
 *   - LLM (Yandex AI Studio): входные/выходные токены × ставка ₽/1k;
 *   - OCR (Yandex Vision): число страниц × ставка ₽/стр (таблица дороже).
 *
 * Ставки — из config (факты в docs/INFERENCE_COST_ANALYSIS_ASHA.md). Локальные
 * движки (tesseract/pdf-text/ollama/vLLM) per-doc НЕ стоят (фикс. аренда GPU),
 * поэтому OCR-стоимость считаем только для yandex-движка.
 *
 * `estimate=true` → сумма НЕПОЛНА (нижняя граница): часть LLM-вызовов не вернула
 * usage (`calls_without_usage>0`) ИЛИ yandex-OCR без известного числа страниц.
 * UI показывает такую цифру как «≥».
 */
export interface CostRates {
  /** Yandex Vision, печатный текст — ₽/страница. */
  ocrPageRub: number;
  /** Yandex Vision, табличная модель (счёт/УПД) — ₽/страница. */
  ocrTableRub: number;
  /** AI Studio, входные токены — ₽/1000. */
  llmInputPer1kRub: number;
  /** AI Studio, выходные токены — ₽/1000. */
  llmOutputPer1kRub: number;
}

export interface JobUsageForCost {
  prompt_tokens: number;
  output_tokens: number;
  calls_without_usage: number;
}

export interface JobCostInput {
  llmUsage: JobUsageForCost | null;
  ocrEngine: string | null;
  ocrPages: number | null;
  documentType: string | null;
}

export interface JobCost {
  /** Итог ₽ (округл. до копеек). */
  rub: number;
  /** Оценка неполна (нижняя граница) → показывать как «≥». */
  estimate: boolean;
  breakdown: { llm: number; ocr: number };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Посчитать стоимость задачи. `tableTypes` — slug'и (UPPER-case), идущие через
 * табличную OCR-модель (config.yandex.tableModelTypes).
 */
export function computeJobCost(
  input: JobCostInput,
  rates: CostRates,
  tableTypes: ReadonlySet<string>,
): JobCost {
  let estimate = false;

  // LLM: платим только когда есть учтённые токены. Неполный usage → нижняя граница.
  let llm = 0;
  if (input.llmUsage) {
    llm =
      (input.llmUsage.prompt_tokens / 1000) * rates.llmInputPer1kRub +
      (input.llmUsage.output_tokens / 1000) * rates.llmOutputPer1kRub;
    if (input.llmUsage.calls_without_usage > 0) estimate = true;
  }

  // OCR: только облачный Yandex Vision (локальный OCR per-doc не стоит).
  let ocr = 0;
  if (input.ocrEngine === 'yandex') {
    if (input.ocrPages != null && input.ocrPages > 0) {
      const isTable =
        input.documentType != null && tableTypes.has(input.documentType.toUpperCase());
      ocr = input.ocrPages * (isTable ? rates.ocrTableRub : rates.ocrPageRub);
    } else {
      estimate = true; // yandex OCR, но число страниц неизвестно
    }
  }

  return { rub: round2(llm + ocr), estimate, breakdown: { llm: round2(llm), ocr: round2(ocr) } };
}
