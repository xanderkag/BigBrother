/**
 * §FIX-3 (CLASSIFIER-PACKET-V2): спецификация со ссылкой «Invoice no.» →
 * contract_specification, а не commercial_invoice.
 *
 * Симптом (форензик BCTT_EVAL_FIXES): viber_259 — спецификация BCS БЕЗ цен
 * (артикул+кол-во+вес), но в шапке «Invoice no. 8906476747» (ссылка на
 * родительский инвойс) перевесила keyword в сторону инвойса; в extract все
 * ценовые поля null. viber_448 (спец без строки «Invoice no.») → верно.
 *
 * Правило: если классификатор выбрал commercial_invoice, но в шапке (первые
 * ~500 симв.) есть якорь «Specification/Спецификация» И в тексте НЕТ реальных
 * ценовых сигналов (ценовое слово ИЛИ валюта) — это спецификация. Демоут.
 * Детерминированно, только текст — тестируется без прогона.
 */
import type { DocumentTypeSlug } from '../../types/documents.js';

const HEAD_CHARS = 500;

const SPEC_ANCHORS: RegExp[] = [
  /\bspecification\b/i,
  /спецификаци/i,
  /especificaci/i,
  /spezifikation/i,
  /\bspecifikacij/i, // LT/LV
];

// Реальные ценовые сигналы: ценовое слово ИЛИ символ/код валюты. Наличие —
// признак настоящего инвойса (не демоутим). «invoice» намеренно НЕ здесь —
// это ссылка, а не цена.
const PRICE_WORD = /(unit\s*price|цена|стоимост|precio|preis|prix|amount\s*due|к\s*оплате|total\s*amount)/i;
const CURRENCY = /(€|\$|₽|£|\bEUR\b|\bUSD\b|\bRUB\b|\bGBP\b|\bPLN\b)/i;

function hasRealPrices(text: string): boolean {
  return PRICE_WORD.test(text) || CURRENCY.test(text);
}

/**
 * Скорректировать тип: commercial_invoice → contract_specification, если это
 * спецификация без цен. Прочие типы — без изменений (тождественно).
 */
export function correctSpecVsInvoice<T extends DocumentTypeSlug | null>(
  documentType: T,
  text: string,
): T | DocumentTypeSlug {
  if (documentType !== 'commercial_invoice') return documentType;
  const head = text.slice(0, HEAD_CHARS);
  const isSpec = SPEC_ANCHORS.some((re) => re.test(head));
  if (!isSpec) return documentType;
  if (hasRealPrices(text)) return documentType; // настоящий инвойс с ценами
  return 'contract_specification' as DocumentTypeSlug;
}
