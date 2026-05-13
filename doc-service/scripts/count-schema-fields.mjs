#!/usr/bin/env node
// Считает количество полей в JSON-схемах document_types из:
//  (a) builtin TS-схем (document-json-schemas.ts) для invoice/UPD/TTN/CMR/AKT
//  (b) DB-seed миграций для остальных 9 типов
//
// Output: маркдаун-таблица. Удобно для документации и аудита покрытия.

import fs from 'node:fs';

// ── (a) Builtin TS схемы ────────────────────────────────────────────────────
// TS-файл содержит `as const` + helper-references (PARTY, ITEMS_ARRAY, …),
// которые не парсятся через простой eval. Захардкодены здесь — должны
// совпадать с document-json-schemas.ts. При расхождении обновлять обе стороны.
const PARTY = { type: 'object', properties: { name: {}, inn: {}, kpp: {}, address: {} } };
const PARTY_WITH_COUNTRY = { type: 'object', properties: { name: {}, address: {}, country: {} } };
const ITEM_PROPS = {
  line_no: {}, code: {}, barcode: {}, name: {}, hs_code: {}, country_of_origin: {},
  unit: {}, qty: {}, qty_per_package: {}, packages: {}, weight_net: {}, weight_gross: {},
  price: {}, vat_rate: {}, vat_amount: {}, total_without_vat: {}, total_with_vat: {},
  currency: {}, notes: {},
};
const ITEMS_ARRAY = { type: 'array', items: { type: 'object', properties: ITEM_PROPS } };
const VAT_SUMMARY = { type: 'array', items: { type: 'object', properties: { rate: {}, base: {}, vat: {} } } };
const FLAGS = { type: 'object', properties: { is_export: {}, is_advance: {}, vat_agent: {}, usn: {} } };

const INVOICE = {
  type: 'object',
  properties: {
    number: {}, date: {}, seller: PARTY, buyer: PARTY, shipper: PARTY, consignee: PARTY,
    currency: {}, exchange_rate: {}, total: {}, total_without_vat: {},
    vat: {}, vat_rate: {}, vat_summary: VAT_SUMMARY, flags: FLAGS,
    payment_terms: {}, items: ITEMS_ARRAY,
  },
};
const TTN = {
  type: 'object',
  properties: {
    number: {}, date: {}, shipper: PARTY, consignee: PARTY, payer: PARTY,
    cargo: { type: 'object', properties: { name: {}, quantity: {}, weight_gross: {}, weight_nett: {}, places: {} } },
    items: ITEMS_ARRAY,
    vehicle: { type: 'object', properties: { plate: {}, trailer_plate: {}, driver: {}, driver_license: {} } },
    loading_point: {}, unloading_point: {}, transport_docs: { type: 'array' },
  },
};
const CMR = {
  type: 'object',
  properties: {
    number: {}, date: {}, sender: PARTY_WITH_COUNTRY, recipient: PARTY_WITH_COUNTRY,
    carrier: { type: 'object', properties: { name: {}, address: {} } },
    cargo: { type: 'object', properties: { description: {}, packages: {}, weight: {}, volume: {} } },
    items: ITEMS_ARRAY,
    loading_place: {}, delivery_place: {}, incoterms: {}, transport_docs: { type: 'array' },
  },
};
const AKT = {
  type: 'object',
  properties: {
    number: {}, date: {}, party_a: PARTY, party_b: PARTY,
    currency: {}, total: {}, total_without_vat: {}, vat: {}, vat_rate: {},
    vat_summary: VAT_SUMMARY, flags: FLAGS,
    period_from: {}, period_to: {}, items: ITEMS_ARRAY,
    parent_contract_number: {}, parent_contract_date: {},
  },
};

// ── (b) DB-seed схемы из миграций ───────────────────────────────────────────
// Каждая VALUES-запись: (slug, display, desc, ..., llm_schema, llm_prompt)
// llm_schema идёт между двумя `NULL, NULL,` (пустые thresholds) и финальным значением.
// Парсим по «положению» — извлекаем JSON между маркерами.
function extractDbSchemas(filePath) {
  const txt = fs.readFileSync(filePath, 'utf-8');
  // Найти каждый блок ( … ),  потом из него — slug (первый '...') и JSON (предпоследний '{...}').
  const tuples = txt.split(/^\(/m).slice(1); // первая часть — заголовок
  const results = [];
  for (const t of tuples) {
    const slugMatch = t.match(/^\s*'([a-z_]+)'/);
    if (!slugMatch) continue;
    const slug = slugMatch[1];
    // Находим все { ... } блоки в кавычках. JSON всегда самый большой
    // и предпоследний (последний — llm_prompt либо NULL).
    const jsonBlocks = [];
    const re = /'(\{[\s\S]+?\})'/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      jsonBlocks.push(m[1]);
    }
    if (jsonBlocks.length === 0) continue;
    // Берём наибольший — это llm_schema (содержит "properties").
    const schemaStr = jsonBlocks
      .filter((s) => s.includes('"properties"'))
      .sort((a, b) => b.length - a.length)[0];
    if (!schemaStr) continue;
    try {
      results.push({ slug, schema: JSON.parse(schemaStr) });
    } catch (e) {
      // skip
    }
  }
  return results;
}

const fromDb = [
  ...extractDbSchemas('migrations/20260514000005_extended_document_types.sql'),
  ...extractDbSchemas('migrations/20260515000006_contracts_and_addendums.sql'),
];

// ── Подсчёт полей ───────────────────────────────────────────────────────────
function countFields(schema) {
  if (!schema || !schema.properties) return { top: 0, leafs: 0, itemsKey: null, perItem: 0 };
  const props = schema.properties;
  const top = Object.keys(props).length;
  let leafs = 0;
  // Считаем ВСЕ leaf-поля (включая вложенные в объекты), не считая отдельно
  // properties внутри items[] — для них отдельная колонка.
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      for (const v of Object.values(node.properties)) walk(v);
    } else if (node.type === 'array') {
      // массивы как одно «поле» — не разворачиваем items[]
      leafs += 1;
    } else {
      leafs += 1;
    }
  }
  for (const v of Object.values(props)) walk(v);

  // Items array — где первый из items|positions|services|goods найдётся
  const itemsKey = ['items', 'positions', 'services', 'goods', 'product_items'].find(
    (k) => props[k] && props[k].type === 'array',
  );
  const perItem = itemsKey ? Object.keys(props[itemsKey].items?.properties || {}).length : 0;
  return { top, leafs, itemsKey, perItem };
}

const allTypes = [
  { slug: 'invoice', name: 'Счёт на оплату', source: 'builtin TS', schema: INVOICE },
  { slug: 'factInvoice', name: 'Счёт-фактура', source: 'builtin TS', schema: INVOICE },
  { slug: 'UPD', name: 'УПД', source: 'builtin TS', schema: INVOICE },
  { slug: 'TTN', name: 'ТТН-1.2', source: 'builtin TS', schema: TTN },
  { slug: 'CMR', name: 'CMR (международная)', source: 'builtin TS', schema: CMR },
  { slug: 'AKT', name: 'Акт выполненных работ', source: 'builtin TS', schema: AKT },
  ...fromDb.map((r) => ({ slug: r.slug, name: '', source: 'DB seed', schema: r.schema })),
];

// Печать в маркдаун
console.log('| slug | top-level | все «листья» | items-массив | полей на строку |');
console.log('|------|-----------|--------------|--------------|-----------------|');
for (const t of allTypes) {
  const c = countFields(t.schema);
  const itemsCell = c.itemsKey ? `\`${c.itemsKey}[]\`` : '—';
  console.log(`| **${t.slug}** | ${c.top} | ${c.leafs} | ${itemsCell} | ${c.perItem || '—'} |`);
}
