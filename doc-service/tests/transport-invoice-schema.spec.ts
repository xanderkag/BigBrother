/**
 * F17: транспортная накладная формы 2013 — schema + classifier.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENDED_SCHEMAS, EXTENDED_EXPECTED_FIELDS } from '../src/types/document-json-schemas.js';

describe('F17 transport_invoice schema', () => {
  it('зарегистрирован в EXTENDED_SCHEMAS', () => {
    expect(EXTENDED_SCHEMAS.transport_invoice).toBeDefined();
    expect(EXTENDED_SCHEMAS.transport_invoice?.type).toBe('object');
  });

  it('содержит ключевые блоки формы 2013', () => {
    const schema = EXTENDED_SCHEMAS.transport_invoice as Record<string, any>;
    const props = schema.properties as Record<string, unknown>;

    // Шапка + 3 стороны (графы 1, 2, 10) + плательщик
    expect(props.number).toBeDefined();
    expect(props.date).toBeDefined();
    expect(props.shipper).toBeDefined();
    expect(props.consignee).toBeDefined();
    expect(props.carrier).toBeDefined();
    expect(props.payer).toBeDefined();

    // Графа 3 — текст, графа 4 — сводка груза
    expect(props.cargo_description).toBeDefined();
    expect(props.cargo_summary).toBeDefined();

    // Графа 8 «Условия перевозки» — отличие от ТТН
    expect(props.conditions).toBeDefined();

    // Графы 6/7 «Сроки доставки»
    expect(props.delivery_terms).toBeDefined();

    // Графа 15 «Стоимость услуг перевозки»
    expect(props.service_cost).toBeDefined();

    // ТС + водитель
    expect(props.vehicle).toBeDefined();
    expect(props.driver).toBeDefined();

    // Точки погрузки/разгрузки (графы 6/7)
    expect(props.loading_point).toBeDefined();
    expect(props.unloading_point).toBeDefined();
  });

  it('vehicle содержит plate, trailer_plate и weight_unladen', () => {
    const schema = EXTENDED_SCHEMAS.transport_invoice as any;
    expect(schema.properties.vehicle.properties.plate).toBeDefined();
    expect(schema.properties.vehicle.properties.trailer_plate).toBeDefined();
    expect(schema.properties.vehicle.properties.weight_unladen).toBeDefined();
  });

  it('service_cost содержит НДС-блок', () => {
    const schema = EXTENDED_SCHEMAS.transport_invoice as any;
    expect(schema.properties.service_cost.properties.amount).toBeDefined();
    expect(schema.properties.service_cost.properties.vat_rate).toBeDefined();
    expect(schema.properties.service_cost.properties.amount_with_vat).toBeDefined();
  });

  it('EXTENDED_EXPECTED_FIELDS transport_invoice содержит критичные поля', () => {
    const fields = EXTENDED_EXPECTED_FIELDS.transport_invoice;
    expect(fields).toBeDefined();
    expect(fields).toContain('number');
    expect(fields).toContain('shipper');
    expect(fields).toContain('consignee');
    expect(fields).toContain('carrier');
    expect(fields).toContain('vehicle');
    expect(fields).toContain('cargo_summary');
  });
});

describe('F17 transport_invoice classifier-rules', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rulesPath = resolve(__dirname, '../../shared/classifier-rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf-8')) as Array<{
    slug: string;
    pattern: string;
    weight: number;
  }>;
  const tiRule = rules.find((r) => r.slug === 'transport_invoice');

  it('правило для transport_invoice добавлено', () => {
    expect(tiRule).toBeDefined();
  });

  it('матчит ссылку на Постановление № 272', () => {
    const re = new RegExp(tiRule!.pattern, 'is');
    expect(re.test('Постановлением Правительства РФ от 15.04.2011 № 272')).toBe(true);
    expect(re.test('Постановление Правительства РФ № 272')).toBe(true);
  });

  it('матчит "приложение № 4 к Правилам перевозок"', () => {
    const re = new RegExp(tiRule!.pattern, 'is');
    expect(re.test('Приложение № 4 к Правилам перевозок грузов автомобильным транспортом')).toBe(true);
  });

  it('weight 1.1 выше TTN (1.0) — при двойном совпадении побеждает', () => {
    const ttnRule = rules.find((r) => r.slug === 'TTN');
    expect(tiRule!.weight).toBeGreaterThan(ttnRule!.weight);
  });

  it('НЕ матчит обычную ТТН без ссылки на 272', () => {
    const re = new RegExp(tiRule!.pattern, 'is');
    expect(re.test('Товарно-транспортная накладная № 100 от 15.05.2026')).toBe(false);
    expect(re.test('Грузоотправитель: ООО Рога. Грузополучатель: ООО Копыта.')).toBe(false);
  });
});
