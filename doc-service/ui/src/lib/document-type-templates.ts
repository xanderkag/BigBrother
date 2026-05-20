/**
 * Шаблоны категорий для быстрого создания типа документа.
 *
 * Каждый шаблон — стартовая точка: prefill для expected_fields / validators /
 * parser_kind. Admin дальше правит slug / display_name / keywords и сохраняет.
 * Имена валидаторов сверены с pipeline/validation/registry.ts
 * (inn_checksum, vat_consistency, date_range, parties_differ, vehicle_plate).
 */
import type { ParserKind } from '@/queries/documentTypes';

export interface DocumentTypeTemplate {
  id: string;
  label: string;
  emoji: string;
  parser_kind: ParserKind | null;
  expected_fields: string[];
  validators: string[];
}

export const DOCUMENT_TYPE_TEMPLATES: DocumentTypeTemplate[] = [
  {
    id: 'financial',
    label: 'Финансовый',
    emoji: '💰',
    parser_kind: 'llm_extract',
    expected_fields: ['number', 'date', 'seller', 'buyer', 'total', 'vat'],
    validators: [
      'inn_checksum:seller.inn',
      'inn_checksum:buyer.inn',
      'vat_consistency',
      'date_range',
      'parties_differ:seller.inn,buyer.inn',
    ],
  },
  {
    id: 'transport',
    label: 'Транспортный',
    emoji: '🚚',
    parser_kind: 'llm_extract',
    expected_fields: ['number', 'date', 'shipper', 'consignee', 'cargo', 'vehicle'],
    validators: [
      'inn_checksum:shipper.inn',
      'inn_checksum:consignee.inn',
      'vehicle_plate:vehicle.plate',
      'date_range',
    ],
  },
  {
    id: 'customs',
    label: 'ВЭД/таможня',
    emoji: '🌍',
    parser_kind: 'llm_extract',
    expected_fields: ['number', 'date', 'sender', 'recipient', 'goods', 'country_origin', 'customs_value'],
    validators: ['date_range'],
  },
  {
    id: 'contract',
    label: 'Договорной',
    emoji: '🤝',
    parser_kind: 'llm_extract',
    expected_fields: ['number', 'date', 'party_a', 'party_b', 'subject', 'total'],
    validators: ['date_range', 'parties_differ:party_a.inn,party_b.inn'],
  },
  {
    id: 'warehouse',
    label: 'Складской',
    emoji: '📦',
    parser_kind: 'llm_extract',
    expected_fields: ['number', 'date', 'warehouse', 'positions'],
    validators: ['date_range'],
  },
  {
    id: 'blank',
    label: 'Пустой',
    emoji: '✏️',
    parser_kind: null,
    expected_fields: [],
    validators: [],
  },
];
