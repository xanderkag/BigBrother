/**
 * F16: заявка на перевозку — schema + classifier.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENDED_SCHEMAS, EXTENDED_EXPECTED_FIELDS } from '../src/types/document-json-schemas.js';

describe('F16 transport_request schema', () => {
  it('зарегистрирован в EXTENDED_SCHEMAS', () => {
    expect(EXTENDED_SCHEMAS.transport_request).toBeDefined();
    expect(EXTENDED_SCHEMAS.transport_request?.type).toBe('object');
  });

  it('содержит ключевые блоки заявки', () => {
    const schema = EXTENDED_SCHEMAS.transport_request as Record<string, any>;
    const props = schema.properties as Record<string, unknown>;

    // Шапка
    expect(props.number).toBeDefined();
    expect(props.date).toBeDefined();
    // 2 стороны
    expect(props.client).toBeDefined();
    expect(props.carrier).toBeDefined();
    // Маршрут с loading/unloading + промежуточные
    expect(props.route).toBeDefined();
    // Груз
    expect(props.cargo).toBeDefined();
    // ТС + трейлер + водитель
    expect(props.vehicle).toBeDefined();
    expect(props.trailer).toBeDefined();
    expect(props.driver).toBeDefined();
    // Ставка
    expect(props.rate).toBeDefined();
    // Договор-основание
    expect(props.parent_contract_number).toBeDefined();
  });

  it('route.loading может быть object ИЛИ array (multi-stop)', () => {
    const schema = EXTENDED_SCHEMAS.transport_request as any;
    const loading = schema.properties.route.properties.loading;
    expect(loading.type).toEqual(['object', 'array']);
    // Multi-stop поле
    expect(schema.properties.route.properties.intermediate_stops).toBeDefined();
  });

  it('cargo содержит спец. поля логистики', () => {
    const schema = EXTENDED_SCHEMAS.transport_request as any;
    const cargo = schema.properties.cargo.properties;
    expect(cargo.weight_t).toBeDefined();      // тонны
    expect(cargo.volume_m3).toBeDefined();     // объём
    expect(cargo.temperature).toBeDefined();   // температурный режим
    expect(cargo.dangerous_class).toBeDefined(); // ADR
  });

  it('rate содержит НДС и payment_terms', () => {
    const schema = EXTENDED_SCHEMAS.transport_request as any;
    const rate = schema.properties.rate.properties;
    expect(rate.amount).toBeDefined();
    expect(rate.currency).toBeDefined();
    expect(rate.vat_included).toBeDefined();
    expect(rate.vat_rate).toBeDefined();
    expect(rate.payment_terms).toBeDefined();
  });

  it('vehicle / driver — опциональные (могут быть null на открытом рынке)', () => {
    const schema = EXTENDED_SCHEMAS.transport_request as any;
    // Проверка что поля вообще есть в схеме (модель решает заполнять или null)
    expect(schema.properties.vehicle).toBeDefined();
    expect(schema.properties.driver).toBeDefined();
    // НЕТ required — это и значит «опциональные»
    expect(schema.required).toBeUndefined();
  });

  it('EXTENDED_EXPECTED_FIELDS НЕ требует vehicle/driver (открытый рынок)', () => {
    const fields = EXTENDED_EXPECTED_FIELDS.transport_request;
    expect(fields).toContain('number');
    expect(fields).toContain('client');
    expect(fields).toContain('carrier');
    expect(fields).toContain('route');
    expect(fields).toContain('cargo');
    expect(fields).toContain('rate');
    // vehicle/driver НЕ в обязательных — для открытого рынка
    expect(fields).not.toContain('vehicle');
    expect(fields).not.toContain('driver');
  });
});

describe('F16 transport_request classifier-rules', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rulesPath = resolve(__dirname, '../../shared/classifier-rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf-8')) as Array<{
    slug: string;
    pattern: string;
    weight: number;
  }>;
  const trRule = rules.find((r) => r.slug === 'transport_request');

  it('правило для transport_request добавлено', () => {
    expect(trRule).toBeDefined();
  });

  it('матчит "Заявка на перевозку"', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявка на перевозку № 713-К')).toBe(true);
    expect(re.test('заявка на перевозку')).toBe(true);
  });

  it('матчит "Заявка на транспортные услуги"', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявка на транспортные услуги')).toBe(true);
  });

  it('матчит "Заявка на автоперевозку"', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявка на автоперевозку груза')).toBe(true);
  });

  it('матчит "Заявка-договор на перевозку"', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявка-договор на перевозку № 100')).toBe(true);
  });

  it('матчит "Заявка №"', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявка № 713-К от 08.04.2026')).toBe(true);
  });

  it('НЕ матчит просто "заявление" или "заявка" без контекста', () => {
    const re = new RegExp(trRule!.pattern, 'i');
    expect(re.test('Заявление в полицию')).toBe(false);
    expect(re.test('Заявка скоро будет')).toBe(false);
  });
});
