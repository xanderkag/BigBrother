/**
 * Форматтеры значений для отображения в JSX. Все — pure functions без
 * локали-зависимости от системы (RU/ru-RU hardcoded), чтобы цифры и
 * даты выглядели одинаково на любом клиенте.
 */

export function formatMoney(v: number | string | null | undefined, currency = ''): string {
  if (v === null || v === undefined || v === '') return '—';
  const num = typeof v === 'string' ? Number(v) : v;
  if (Number.isNaN(num)) return '—';
  return (
    new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      num,
    ) + (currency ? ` ${currency}` : '')
  );
}

/**
 * Money с символом валюты впереди (для не-RUB) или без префикса (RUB).
 * Используется в плотных таблицах, где `91 647,15 RUB` уже не помещается.
 *   RUB → «91 647,15» (без суффикса — он подразумевается)
 *   USD → «$1 240,00»
 *   EUR → «€1 240,00»
 *   CNY → «¥1 240,00»
 *   other → «1 240,00 XYZ»
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  CNY: '¥',
  GBP: '£',
  JPY: '¥',
};

export function formatMoneyCompact(
  v: number | string | null | undefined,
  currency?: string | null,
): string {
  if (v === null || v === undefined || v === '') return '—';
  const num = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(num as number)) return '—';
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num as number);
  const cur = currency?.toUpperCase();
  if (!cur || cur === 'RUB' || cur === 'RUR') return formatted;
  const sym = CURRENCY_SYMBOLS[cur];
  return sym ? `${sym}${formatted}` : `${formatted} ${cur}`;
}

export function formatNumber(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const num = typeof v === 'string' ? Number(v) : v;
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('ru-RU').format(num);
}

export function formatDate(v: string | null | undefined): string {
  if (!v) return '—';
  // ISO dates: показываем как есть (YYYY-MM-DD) — самый предсказуемый
  // формат для деловых документов.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  try {
    return new Date(v).toISOString().slice(0, 10);
  } catch {
    return v;
  }
}

export function formatDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return v;
  }
}

export function formatFileSize(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (Number.isNaN(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return '—';
  return id.length <= len ? id : id.slice(0, len);
}

/**
 * Короткий ID с разделителем для дизайна: `a8f3…91c2`. Берём первые
 * 4 символа и последние 4, между ними — горизонтальное многоточие.
 * Используется в таблицах, где нужна компактная и опознаваемая запись.
 */
export function shortIdSplit(id: string | null | undefined): string {
  if (!id) return '—';
  if (id.length <= 9) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * Relative time с минимальным набором единиц. На UI-таблицах гораздо
 * читаемее полной даты — глаз сразу видит «свежий» / «старый» документ.
 * Для tooltip'а нужен полный formatDateTime отдельно.
 *
 *   <60s    → «<1 мин»
 *   <60min  → «5 мин»
 *   <24h    → «3 ч»
 *   <30d    → «12 д»
 *   ≥30d    → «3 мес»
 *   ≥365d   → «2 г»
 */
export function formatAge(v: string | null | undefined, now: Date = new Date()): string {
  if (!v) return '—';
  let then: Date;
  try {
    then = new Date(v);
    if (Number.isNaN(then.getTime())) return v;
  } catch {
    return v;
  }
  const diffSec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (diffSec < 60) return '<1 мин';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} ч`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD} д`;
  const diffMo = Math.floor(diffD / 30);
  if (diffMo < 12) return `${diffMo} мес`;
  const diffY = Math.floor(diffMo / 12);
  return `${diffY} г`;
}
