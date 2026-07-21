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

/**
 * INBOUND-мап: outbound-форма → историческое имя слага. Строится инверсией
 * `OUTBOUND_SLUG_ALIASES`, чтобы две таблицы не разъезжались.
 */
export const INBOUND_SLUG_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(OUTBOUND_SLUG_ALIASES).map(([historical, outbound]) => [outbound, historical]),
);

/**
 * Приводит слаг к **историческому** имени — тому, которым проиндексированы
 * hardcoded-таблицы в коде (`DOCUMENT_JSON_SCHEMAS`, `EXPECTED_FIELDS`).
 *
 * Зачем. Каталог отдаёт слаги в двух написаниях: исторические (`CMR`, `TTN`,
 * `UPD`, `AKT`, `factInvoice`) и outbound/SLAI-конвенцию (`cmr`, `ttn`, …).
 * Сегментация композитов ставит сегменту outbound-слаг (`multidoc/boundaries.ts`),
 * а одиночный док приходит от keyword-классификатора с историческим (`classifier/
 * keywords.ts`). Обе формы валидны и обе доходят до резолвера.
 *
 * Хардкод-таблицы схем при этом проиндексированы ТОЛЬКО историческим именем.
 * Без канонизации `DOCUMENT_JSON_SCHEMAS['cmr']` → `undefined` → fallback-схема
 * `{}` → в промпт уходит «выводи JSON в формате {}» → модель сочиняет: маршрут
 * не извлекается вообще, `number` принимает мусор («CMR», имя перевозчика).
 * Ровно этот баг нашёл SLAI на корпусе БКТ 2026-07-16 («регистр типа коррелирует
 * с качеством стопроцентно») — см. `docs/BCTT_EXTRACT_FIXES.md` FIX-A.
 *
 * Слаги вне мапы (`waybill`, `commercial_invoice`, …) возвращаются как есть —
 * их таблицы (`EXTENDED_SCHEMAS`) и так в outbound-конвенции.
 *
 * @example
 *   canonicalizeSlugForBuiltins('cmr')          // → 'CMR'
 *   canonicalizeSlugForBuiltins('CMR')          // → 'CMR' (идемпотентно)
 *   canonicalizeSlugForBuiltins('tax_invoice')  // → 'factInvoice'
 *   canonicalizeSlugForBuiltins('waybill')      // → 'waybill' (без изменений)
 */
export function canonicalizeSlugForBuiltins<T extends string | null | undefined>(slug: T): T {
  if (slug === null || slug === undefined) return slug;
  return (INBOUND_SLUG_ALIASES[slug as string] ?? slug) as T;
}

/**
 * Обе формы слага (историческая + outbound) для SQL-фильтров по
 * `jobs.document_type` — в колонке живут ОБЕ: keyword-классификатор пишет
 * исторические (`CMR`), document_hint от клиента сохраняется дословно в
 * outbound (`cmr`). Точный матч по одной форме молча теряет вторую половину
 * документов (и в списке, и в count → таб-счётчиках UI).
 *
 * @example
 *   expandSlugForms('CMR')          // → ['CMR', 'cmr']
 *   expandSlugForms('cmr')          // → ['cmr', 'CMR']
 *   expandSlugForms('factInvoice')  // → ['factInvoice', 'tax_invoice']
 *   expandSlugForms('invoice')      // → ['invoice'] (не алиасный)
 */
export function expandSlugForms(slug: string): string[] {
  return [...new Set([slug, normalizeSlugForApi(slug), canonicalizeSlugForBuiltins(slug)])];
}
