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

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер документа' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    seller: PARTY,
    buyer: PARTY,
    total: { type: 'number', description: 'Итоговая сумма к оплате' },
    vat: { type: 'number', description: 'Сумма НДС' },
    vat_rate: { type: 'number', description: 'Ставка НДС в процентах (20, 10, 0)' },
    positions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Наименование товара/услуги' },
          qty: { type: 'number' },
          price: { type: 'number', description: 'Цена за единицу' },
          total: { type: 'number', description: 'Сумма по позиции' },
          vat: { type: 'number' },
        },
      },
    },
  },
} as const;

const TTN_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Грузоотправитель' },
    consignee: { ...PARTY, description: 'Грузополучатель' },
    cargo: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Наименование груза' },
        quantity: { type: 'number' },
        weight_gross: { type: 'number', description: 'Масса брутто в килограммах' },
        weight_nett: { type: 'number', description: 'Масса нетто в килограммах' },
        places: { type: 'number', description: 'Количество грузовых мест' },
      },
    },
    vehicle: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'Государственный номер ТС (формат А123БВ77)' },
        driver: { type: 'string', description: 'ФИО водителя' },
      },
    },
    loading_point: { type: 'string', description: 'Адрес погрузки' },
    unloading_point: { type: 'string', description: 'Адрес разгрузки' },
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
      properties: {
        description: { type: 'string', description: 'Описание груза' },
        packages: { type: 'number', description: 'Количество мест' },
        weight: { type: 'number', description: 'Вес брутто в килограммах' },
      },
    },
    loading_place: { type: 'string', description: 'Место погрузки (ячейка 4)' },
    delivery_place: { type: 'string', description: 'Место разгрузки (ячейка 3)' },
  },
} as const;

const AKT_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    party_a: { ...PARTY, description: 'Исполнитель' },
    party_b: { ...PARTY, description: 'Заказчик' },
    total: { type: 'number' },
    vat: { type: 'number', description: 'Сумма НДС (0 для УСН)' },
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Наименование услуги/работы' },
          qty: { type: 'number' },
          price: { type: 'number', description: 'Стоимость' },
        },
      },
    },
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
  invoice: ['number', 'date', 'seller', 'buyer', 'total'],
  factInvoice: ['number', 'date', 'seller', 'buyer', 'total', 'vat'],
  UPD: ['number', 'date', 'seller', 'buyer', 'total'],
  TTN: ['number', 'date', 'shipper', 'consignee', 'cargo', 'vehicle'],
  CMR: ['number', 'date', 'sender', 'recipient', 'carrier'],
  AKT: ['number', 'date', 'party_a', 'party_b', 'total'],
};
