/**
 * Outbound slug normalization для согласованности с SLAI и нашим ТЗ.
 *
 * История: исторически в DB у нас слаги уровня документа в UPPERCASE
 * (`TTN`, `UPD`, `CMR`, `AKT`) и camelCase (`factInvoice`). SLAI и
 * другие потребители ожидают единый формат — lowercase snake_case
 * (см. PARSDOCS_REQUIREMENTS_TZ.md §1.1 + SLAI EOD-отчёт 2026-05-17
 * Issue #3).
 *
 * Делаем минимально-инвазивный фикс — **outbound** трансляция в
 * `jobsRepo.toApi()` и в webhook payload. БД и внутренний код
 * продолжают использовать историческое имя слага. Полную миграцию
 * слагов в БД отложили — она ломает provider_settings, document_types,
 * audit_log и тестовые fixture; делать отдельной фазой.
 *
 * Inbound трансляцию (slai_alias → наш слаг) делает
 * `documentTypeResolver.expandSlugCandidates()` (F22, commit 91585c2).
 */

/**
 * Мап от исторического имени слага в outbound (lowercase snake_case).
 * Только для тех слагов, что реально расходятся с конвенцией. Слаги,
 * уже соответствующие SLAI (например `invoice`, `transport_request`,
 * `waybill`, `payment_order`), отсутствуют в мапе — проходят без
 * изменений.
 */
export const OUTBOUND_SLUG_ALIASES: Record<string, string> = {
  TTN: 'ttn',
  UPD: 'upd',
  UKD: 'ukd',
  CMR: 'cmr',
  AKT: 'services_act',
  factInvoice: 'tax_invoice',
};

/**
 * Приводит слаг к outbound-форме. `null` пробрасывается.
 *
 * @example
 *   normalizeSlugForApi('TTN')           // → 'ttn'
 *   normalizeSlugForApi('factInvoice')   // → 'tax_invoice'
 *   normalizeSlugForApi('invoice')       // → 'invoice' (без изменений)
 *   normalizeSlugForApi(null)            // → null
 */
export function normalizeSlugForApi<T extends string | null | undefined>(slug: T): T {
  if (slug === null || slug === undefined) return slug;
  return (OUTBOUND_SLUG_ALIASES[slug as string] ?? slug) as T;
}
