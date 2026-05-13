// JSON Schema descriptors for the LLM /extract endpoint, one per document
// type. Hand-written rather than derived from the zod schemas in
// `documents.ts`: the LLM consumes JSON Schema shape, our runtime uses
// zod, and the two have different goals — the JSON Schema is a *prompt*
// (it tells the model what to look for), so it's tuned for clarity over
// strict validation.
//
// All fields are optional: the model is instructed in the prompt to omit
// fields it cannot find rather than guessing. Required fields would force
// the model to invent values.
//
// ── Phase A схемы v2 ────────────────────────────────────────────────────
// Унификация:
//   - Массив строк всегда называется `items[]` (раньше: positions/services/cargo).
//     Старые имена обрабатывает нормализатор normalize-extracted.ts при чтении
//     job'а в API — backward-compat.
//   - Shape строки расширен до 18 полей (см. ITEM_PROPERTIES) под реальный
//     B2B-учёт: code, barcode, hs_code, country, units, веса, разбивка НДС
//     per-line, валюта строки, line_no, заметки.
//   - Шапка получила vat_summary[], currency, exchange_rate, shipper/consignee
//     отдельно от seller/buyer, флаги (is_export, is_advance, vat_agent),
//     incoterms, ссылку на другие документы.

import type { DocumentType } from './documents.js';

const DATE_DESCRIPTION = 'Дата в формате YYYY-MM-DD';
const INN_DESCRIPTION = 'ИНН организации (10 цифр) или ИП (12 цифр)';
const KPP_DESCRIPTION = 'КПП организации (9 цифр)';

const PARTY = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Наименование' },
    inn: { type: 'string', description: INN_DESCRIPTION },
    kpp: { type: 'string', description: KPP_DESCRIPTION },
    address: { type: 'string' },
  },
} as const;

const PARTY_WITH_COUNTRY = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { type: 'string' },
    country: { type: 'string', description: 'Двухбуквенный код ISO 3166 (RU, DE, PL и т.п.)' },
  },
} as const;

const PARTY_BANK = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    inn: { type: 'string', description: INN_DESCRIPTION },
    kpp: { type: 'string', description: KPP_DESCRIPTION },
    account: { type: 'string', description: 'Расчётный счёт (20 цифр)' },
    bank_name: { type: 'string' },
    bic: { type: 'string', description: 'БИК (9 цифр)' },
    correspondent_account: { type: 'string' },
  },
} as const;

/**
 * Канонический shape одной строки items[i]. Все поля опциональны — модель
 * заполняет только то что нашла. Парсеры по builtin-типу используют подмножество;
 * Generic LLM-парсер получает весь шаблон через llm_schema.
 */
const ITEM_PROPERTIES = {
  line_no: { type: 'integer', description: 'Порядковый номер строки в документе' },
  code: { type: 'string', description: 'Внутренний артикул / код товара' },
  barcode: { type: 'string', description: 'Штрих-код (EAN-13, UPC, GTIN)' },
  name: { type: 'string', description: 'Наименование товара/услуги' },
  hs_code: {
    type: 'string',
    description: 'Код ТН ВЭД (10 цифр для РФ/ЕАЭС, 8 цифр для ЕС). Только для импорта/таможни.',
  },
  country_of_origin: { type: 'string', description: 'Страна происхождения, ISO 3166-1 alpha-2' },
  unit: { type: 'string', description: 'Единица измерения (шт, кг, м, л, упак, …)' },
  qty: { type: 'number', description: 'Количество' },
  qty_per_package: { type: 'number', description: 'Количество единиц в упаковке' },
  packages: { type: 'number', description: 'Количество упаковок/мест' },
  weight_net: { type: 'number', description: 'Вес нетто в килограммах' },
  weight_gross: { type: 'number', description: 'Вес брутто в килограммах' },
  price: { type: 'number', description: 'Цена за единицу без НДС' },
  vat_rate: { type: 'number', description: 'Ставка НДС именно этой строки (0, 10, 20)' },
  vat_amount: { type: 'number', description: 'Сумма НДС по строке' },
  total_without_vat: { type: 'number', description: 'Стоимость без НДС' },
  total_with_vat: { type: 'number', description: 'Стоимость с НДС' },
  currency: { type: 'string', description: 'Валюта строки, если отличается от шапки. ISO 4217 (RUB, USD, EUR, CNY)' },
  notes: { type: 'string', description: 'Произвольные комментарии в строке' },
} as const;

const ITEMS_ARRAY = {
  type: 'array',
  description:
    'Список позиций документа. Каждая строка — товар/услуга/груз. ' +
    'Если в документе нет таблицы позиций, оставить пустым массивом.',
  items: { type: 'object', properties: ITEM_PROPERTIES },
} as const;

/**
 * Разбивка НДС по ставкам — для документов где могут быть несколько ставок
 * одновременно (счёт-фактура с НДС 10% и 20% на разные позиции).
 */
const VAT_SUMMARY = {
  type: 'array',
  description: 'Разбивка по ставкам НДС: одна запись на каждую ставку, встречающуюся в документе',
  items: {
    type: 'object',
    properties: {
      rate: { type: 'number', description: 'Ставка в процентах (0, 10, 20)' },
      base: { type: 'number', description: 'Налогооблагаемая база по этой ставке' },
      vat: { type: 'number', description: 'Сумма НДС по этой ставке' },
    },
  },
} as const;

const FLAGS = {
  type: 'object',
  description: 'Булевы признаки документа',
  properties: {
    is_export: { type: 'boolean', description: 'Документ оформлен на экспорт' },
    is_advance: { type: 'boolean', description: 'Аванс / предоплата (счёт-фактура на аванс)' },
    vat_agent: { type: 'boolean', description: 'Покупатель — налоговый агент по НДС' },
    usn: { type: 'boolean', description: 'Продавец на упрощённой системе налогообложения' },
  },
} as const;

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер документа' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    seller: PARTY,
    buyer: PARTY,
    // Грузоотправитель / грузополучатель отличны от продавца/покупателя для
    // трёхсторонних отгрузок. Если совпадают — модели поручено оставить null.
    shipper: { ...PARTY, description: 'Грузоотправитель (если отличается от продавца)' },
    consignee: { ...PARTY, description: 'Грузополучатель (если отличается от покупателя)' },
    currency: { type: 'string', description: 'Валюта документа, ISO 4217 (по умолчанию RUB)' },
    exchange_rate: { type: 'number', description: 'Курс к валюте учёта (если currency ≠ RUB)' },
    total: { type: 'number', description: 'Итоговая сумма к оплате' },
    total_without_vat: { type: 'number', description: 'Итог без НДС' },
    vat: { type: 'number', description: 'Сумма НДС всего' },
    vat_rate: { type: 'number', description: 'Основная ставка НДС в процентах (20, 10, 0)' },
    vat_summary: VAT_SUMMARY,
    flags: FLAGS,
    payment_terms: { type: 'string', description: 'Условия оплаты (например "до 15.12.2025")' },
    items: ITEMS_ARRAY,
  },
} as const;

const TTN_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Грузоотправитель' },
    consignee: { ...PARTY, description: 'Грузополучатель' },
    payer: { ...PARTY, description: 'Плательщик (если отличается от отправителя)' },
    // Был один объект `cargo` — теперь массив items[] (реальная ТТН-1.2 раздел 1
    // содержит таблицу). Сводный cargo оставлен для backward-compat и для случая
    // когда документ описывает один груз одной строкой.
    cargo: {
      type: 'object',
      description: 'Сводная характеристика груза (используется когда в ТТН одна позиция или нужен общий итог)',
      properties: {
        name: { type: 'string' },
        quantity: { type: 'number' },
        weight_gross: { type: 'number', description: 'Масса брутто, кг' },
        weight_nett: { type: 'number', description: 'Масса нетто, кг' },
        places: { type: 'number', description: 'Количество грузовых мест' },
      },
    },
    items: ITEMS_ARRAY,
    vehicle: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'Гос. номер ТС (формат А123БВ77)' },
        trailer_plate: { type: 'string', description: 'Номер прицепа' },
        driver: { type: 'string', description: 'ФИО водителя' },
        driver_license: { type: 'string', description: 'Номер водительского удостоверения' },
      },
    },
    loading_point: { type: 'string', description: 'Адрес погрузки' },
    unloading_point: { type: 'string', description: 'Адрес разгрузки' },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (CMR, счёт-фактура, путевой лист)',
      items: { type: 'string' },
    },
  },
} as const;

const CMR_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    sender: { ...PARTY_WITH_COUNTRY, description: 'Отправитель (ячейка 1)' },
    recipient: { ...PARTY_WITH_COUNTRY, description: 'Получатель (ячейка 2)' },
    carrier: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
      },
      description: 'Перевозчик (ячейка 16)',
    },
    cargo: {
      type: 'object',
      description: 'Сводная характеристика (для разделов 6-12 CMR)',
      properties: {
        description: { type: 'string' },
        packages: { type: 'number', description: 'Количество мест' },
        weight: { type: 'number', description: 'Вес брутто, кг' },
        volume: { type: 'number', description: 'Объём, м³' },
      },
    },
    items: ITEMS_ARRAY,
    loading_place: { type: 'string', description: 'Место погрузки (ячейка 4)' },
    delivery_place: { type: 'string', description: 'Место разгрузки (ячейка 3)' },
    incoterms: {
      type: 'string',
      description: 'Условия поставки Incoterms (EXW, FCA, CIP, DAP, DDP, FOB, CIF, …)',
    },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (invoice, packing_list)',
      items: { type: 'string' },
    },
  },
} as const;

const AKT_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    party_a: { ...PARTY, description: 'Исполнитель' },
    party_b: { ...PARTY, description: 'Заказчик' },
    currency: { type: 'string', description: 'Валюта (ISO 4217, по умолчанию RUB)' },
    total: { type: 'number' },
    total_without_vat: { type: 'number' },
    vat: { type: 'number', description: 'Сумма НДС (0 для УСН)' },
    vat_rate: { type: 'number' },
    vat_summary: VAT_SUMMARY,
    flags: FLAGS,
    period_from: { type: 'string', description: 'Период оказания услуг с (YYYY-MM-DD)' },
    period_to: { type: 'string', description: 'Период оказания услуг по (YYYY-MM-DD)' },
    items: { ...ITEMS_ARRAY, description: 'Перечень оказанных услуг / работ' },
    parent_contract_number: { type: 'string', description: 'Номер договора-основания' },
    parent_contract_date: { type: 'string', description: 'Дата договора-основания' },
  },
} as const;

export const DOCUMENT_JSON_SCHEMAS: Record<DocumentType, Record<string, unknown>> = {
  invoice: INVOICE_SCHEMA,
  factInvoice: INVOICE_SCHEMA,
  UPD: INVOICE_SCHEMA,
  TTN: TTN_SCHEMA,
  CMR: CMR_SCHEMA,
  AKT: AKT_SCHEMA,
};

export const EXPECTED_FIELDS: Record<DocumentType, string[]> = {
  invoice: ['number', 'date', 'seller', 'buyer', 'total', 'items'],
  factInvoice: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'vat_summary', 'items'],
  UPD: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'items'],
  TTN: ['number', 'date', 'shipper', 'consignee', 'cargo', 'vehicle', 'items'],
  CMR: ['number', 'date', 'sender', 'recipient', 'carrier', 'items'],
  AKT: ['number', 'date', 'party_a', 'party_b', 'total', 'items'],
};

/**
 * Re-export shared sub-schemas so DB-stored схемы (миграция 0014) могут
 * ссылаться на них из админ-UI / документации, не дублируя описания.
 *
 * Сейчас они инлайнятся в `llm_schema` в SQL, но если кто-то захочет
 * собрать схему из кусков (например через UI conf-builder) — эти куски
 * доступны как single-source-of-truth.
 */
export const SCHEMA_FRAGMENTS = {
  PARTY,
  PARTY_WITH_COUNTRY,
  PARTY_BANK,
  ITEM_PROPERTIES,
  ITEMS_ARRAY,
  VAT_SUMMARY,
  FLAGS,
} as const;
