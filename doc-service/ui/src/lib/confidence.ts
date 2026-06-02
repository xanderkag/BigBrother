/**
 * Единый источник порогов уверенности (§9 «мелочь»: пороги дублировались в
 * ReviewQueue / ExtractedDataPanel / ConfidenceBar). Здесь — канонические
 * значения и хелперы под палитру. F2-редактор использует именно их, чтобы
 * подсветка полей совпадала с остальным UI.
 *
 * Палитра (trichromacy-friendly, как в ConfidenceBar):
 *   ≥ 0.85  emerald — норма;
 *   ≥ 0.60  amber   — стоит проверить глазами;
 *   <  0.60 rose    — вероятно мусор.
 *
 * Ручная правка поля = «проверено человеком» → уверенность 1.0 (HUMAN_VERIFIED).
 */
export const CONFIDENCE_THRESHOLDS = {
  /** Не ниже — «норма» (зелёный). */
  high: 0.85,
  /** Не ниже — «проверить» (жёлтый); ниже — «мусор» (красный). */
  medium: 0.6,
} as const;

/** Значение уверенности, которое выставляется при ручной правке поля. */
export const HUMAN_VERIFIED = 1.0;

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export function confidenceLevel(v: number | null | undefined): ConfidenceLevel {
  if (v === null || v === undefined || Number.isNaN(v)) return 'none';
  if (v >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (v >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/** Классы для подсветки ЗНАЧЕНИЯ поля (фон + текст). 'high'/'none' — без фона. */
export function confidenceValueClass(v: number | null | undefined): string {
  switch (confidenceLevel(v)) {
    case 'medium':
      return 'rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-500/10 dark:text-amber-200';
    case 'low':
      return 'rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-900 dark:bg-rose-500/10 dark:text-rose-200';
    default:
      return '';
  }
}

/** Класс цвета границы input'а под уровень уверенности (для F2-редактора). */
export function confidenceBorderClass(v: number | null | undefined): string {
  switch (confidenceLevel(v)) {
    case 'high':
      return 'border-emerald-300 dark:border-emerald-700';
    case 'medium':
      return 'border-amber-400 dark:border-amber-600';
    case 'low':
      return 'border-rose-400 dark:border-rose-600';
    default:
      return 'border-slate-300 dark:border-slate-700';
  }
}
