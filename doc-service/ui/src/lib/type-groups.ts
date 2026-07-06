/**
 * Статическая группировка слагов типов документов для фильтра
 * «Тип документа» в журнале (JobsList). Ключи — точные слаги из БД,
 * регистр смешанный (AKT, CMR, TTN, UPD, UKD, factInvoice — как есть).
 * Слаг без записи в мапе попадает в «Прочее» — новые типы не пропадают
 * из UI, пока их не разложат по группам здесь.
 */

export const TYPE_GROUPS = [
  'Счета и оплата',
  'Перевозка',
  'Таможня и сертификаты',
  'Договоры и склад',
  'Прочее',
] as const;

export type TypeGroup = (typeof TYPE_GROUPS)[number];

const GROUP_BY_SLUG: Record<string, TypeGroup> = {
  // Счета и оплата
  invoice: 'Счета и оплата',
  factInvoice: 'Счета и оплата',
  UPD: 'Счета и оплата',
  UKD: 'Счета и оплата',
  proforma_invoice: 'Счета и оплата',
  commercial_invoice: 'Счета и оплата',
  payment_order: 'Счета и оплата',
  wire_transfer_application: 'Счета и оплата',
  cash_receipt: 'Счета и оплата',
  // Перевозка
  bill_of_lading: 'Перевозка',
  CMR: 'Перевозка',
  TTN: 'Перевозка',
  smgs: 'Перевозка',
  cim: 'Перевозка',
  awb: 'Перевозка',
  waybill: 'Перевозка',
  transport_invoice: 'Перевозка',
  transport_request: 'Перевозка',
  booking_request: 'Перевозка',
  manifest: 'Перевозка',
  special_permit: 'Перевозка',
  // Таможня и сертификаты
  customs_declaration: 'Таможня и сертификаты',
  export_declaration: 'Таможня и сертификаты',
  packing_list: 'Таможня и сертификаты',
  price_list: 'Таможня и сертификаты',
  cert_of_origin: 'Таможня и сертификаты',
  eac_conformity_certificate: 'Таможня и сертификаты',
  phytosanitary_certificate: 'Таможня и сертификаты',
  veterinary_certificate: 'Таможня и сертификаты',
  quality_certificate: 'Таможня и сертификаты',
  safety_data_sheet: 'Таможня и сертификаты',
  insurance_policy: 'Таможня и сертификаты',
  weighing_act: 'Таможня и сертификаты',
  // Договоры и склад
  contract: 'Договоры и склад',
  contract_addendum: 'Договоры и склад',
  contract_specification: 'Договоры и склад',
  power_of_attorney: 'Договоры и склад',
  AKT: 'Договоры и склад',
  transfer_note: 'Договоры и склад',
  material_requisition: 'Договоры и склад',
  warehouse_receipt: 'Договоры и склад',
  warehouse_return: 'Договоры и склад',
};

export function typeGroupOf(slug: string): TypeGroup {
  return GROUP_BY_SLUG[slug] ?? 'Прочее';
}
