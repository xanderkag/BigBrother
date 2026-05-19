/**
 * Утилиты вытаскивания «топовых» полей из `extracted` для списка job'ов:
 *   - TOTAL (сумма с НДС)
 *   - VAT (собственно НДС)
 *   - CURRENCY (RUB/USD/EUR/CNY)
 *   - ISSUES count
 *
 * Эти поля разные у разных document_type — например УПД использует
 * `total_with_vat`/`vat_amount`, простой счёт может класть в `total`
 * или `amount`. Здесь — минимальный набор fallback-цепочек, чтобы
 * таблица jobs показывала что-то полезное даже на «нестандартных»
 * схемах. Если ничего не найдено — null, UI рисует «—».
 *
 * Никакой нормализации (валюта, сумма-в-копейках) не делаем — берём
 * как есть, форматтер числа дальше разберётся.
 */

const TOTAL_KEYS = [
  'total_with_vat',
  'total_amount',
  'amount_total',
  'total',
  'amount',
  'sum',
] as const;

const VAT_KEYS = [
  'vat_amount',
  'total_vat',
  'sum_vat',
  'vat',
] as const;

const CURRENCY_KEYS = ['currency', 'currency_code'] as const;

function pickNumber(extracted: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = extracted[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      // Деньги могут прийти строкой ("91 647,15" / "12,480.00").
      // Аккуратно нормализуем: убираем пробелы и NBSP, запятую → точку,
      // остаток — только цифры/точка/минус.
      const cleaned = v.replace(/[\s ]/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
      const n = parseFloat(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickString(extracted: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = extracted[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export interface JobAmountSummary {
  total: number | null;
  vat: number | null;
  currency: string | null;
  issuesCount: number;
}

export function extractAmounts(extracted: Record<string, unknown> | null | undefined): JobAmountSummary {
  if (!extracted) {
    return { total: null, vat: null, currency: null, issuesCount: 0 };
  }
  const issues = extracted._issues;
  const issuesCount = Array.isArray(issues) ? issues.length : 0;
  return {
    total: pickNumber(extracted, TOTAL_KEYS),
    vat: pickNumber(extracted, VAT_KEYS),
    currency: pickString(extracted, CURRENCY_KEYS),
    issuesCount,
  };
}
