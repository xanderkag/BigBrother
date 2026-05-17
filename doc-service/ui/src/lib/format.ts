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
