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

/**
 * Порог «обрати внимание» для компактного превью полей в очереди проверки —
 * строже палитры (medium=0.6), потому что в превью оператор хочет ловить даже
 * умеренно неуверенные поля. Ниже него поле в превью подсвечивается жёлтым и
 * показывает свой %.
 */
export const PREVIEW_ATTENTION_THRESHOLD = 0.7;

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

/**
 * Класс заливки полоски (bar fill) под уровень — для ConfidenceBar и
 * per-field баров на детальной. 'none' тут практически не встречается
 * (значение всегда clamp'ится в [0,1]), но даём нейтральный фолбэк.
 */
export function confidenceBarClass(v: number | null | undefined): string {
  switch (confidenceLevel(v)) {
    case 'high':
      return 'bg-emerald-500 dark:bg-emerald-400';
    case 'medium':
      return 'bg-amber-500 dark:bg-amber-400';
    case 'low':
      return 'bg-rose-500 dark:bg-rose-400';
    default:
      return 'bg-slate-300 dark:bg-slate-600';
  }
}

/** Класс цвета ТЕКСТА-метки (%) под уровень — пара к confidenceBarClass. */
export function confidenceTextClass(v: number | null | undefined): string {
  switch (confidenceLevel(v)) {
    case 'high':
      return 'text-emerald-700 dark:text-emerald-300';
    case 'medium':
      return 'text-amber-700 dark:text-amber-300';
    case 'low':
      return 'text-rose-700 dark:text-rose-300';
    default:
      return 'text-slate-400 dark:text-slate-500';
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
