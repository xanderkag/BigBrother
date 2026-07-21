/**
 * F0g (аудит пустых доков 2026-07-21): guard «письмо, попавшее в invoice».
 *
 * Паттерн: письмо (о назначении, гарантийное), классифицированное как
 * invoice, получало number/date ЧУЖОГО инвойса (реквизиты референса из
 * текста письма) и ВЫДУМАННУЮ валюту (схема просит currency, сумм в письме
 * нет — модель подставляет RUB) → загрязнение реестра счетов downstream.
 *
 * Корень закрыт типом info_letter (мигр. 20260721000002); этот гард —
 * детерминированная страховка: у invoice БЕЗ единой позиции и БЕЗ итоговой
 * суммы валюте неоткуда взяться — зануляем её и ставим флаг подозрения
 * `_suspect_letter` (виден в UI/webhook; сигнал «проверь глазами»).
 * Реквизиты (number/date) НЕ трогаем — при живом документе-обрывке они
 * могут быть настоящими; решает оператор.
 */

const INVOICE_TYPES = new Set(['invoice', 'factInvoice', 'tax_invoice']);

function isEmptyish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return v === 0;
  if (typeof v === 'string') return v.trim() === '' || Number(v.replace(',', '.')) === 0;
  return false;
}

export function guardInvoiceLetter(
  documentType: string | null | undefined,
  extracted: Record<string, unknown>,
): { changed: boolean; reason?: string } {
  if (!documentType || !INVOICE_TYPES.has(documentType)) return { changed: false };

  const positions = extracted['positions'] ?? extracted['items'];
  const hasPositions = Array.isArray(positions) && positions.length > 0;
  const hasTotal = !isEmptyish(extracted['total']) || !isEmptyish(extracted['total_with_vat']);
  if (hasPositions || hasTotal) return { changed: false };

  let changed = false;
  if (extracted['currency'] !== null && extracted['currency'] !== undefined) {
    extracted['currency'] = null;
    changed = true;
  }
  // Флаг подозрения — служебное поле (не бизнес-данные), уходит в UI/webhook.
  if (extracted['_suspect_letter'] !== true) {
    extracted['_suspect_letter'] = true;
    changed = true;
  }
  return {
    changed,
    reason: 'invoice без позиций и итога — похоже на письмо/обрывок, валюта занулена',
  };
}
