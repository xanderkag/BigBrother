/**
 * Карта internal→outbound слагов типов документов — КОПИЯ
 * `src/types/slug-normalize.ts` бэкенда (UI не может импортировать из src/).
 * Держать в синхроне с OUTBOUND_SLUG_ALIASES: каталог отдаёт исторические
 * слаги ('CMR', 'factInvoice'), а jobs.toApi всегда нормализует
 * job.document_type в outbound-форму ('cmr', 'tax_invoice') — любые
 * Map-лукапы «тип джобы → атрибут каталога» обязаны ключеваться ОБЕИМИ
 * формами, иначе алиасные builtin-типы молча выпадают (баг tier-бейджа).
 */
export const OUTBOUND_SLUG_ALIASES: Record<string, string> = {
  TTN: 'ttn',
  UPD: 'upd',
  UKD: 'ukd',
  CMR: 'cmr',
  AKT: 'services_act',
  factInvoice: 'tax_invoice',
};

/** Слаг в outbound-форме (как в job.document_type из API). */
export function normalizeSlugForApi(slug: string): string {
  return OUTBOUND_SLUG_ALIASES[slug] ?? slug;
}
