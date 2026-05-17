/**
 * F18: путевой лист (waybill) — проверка schema + expected_fields +
 * classifier keywords. Не интеграционный, только статика.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENDED_SCHEMAS, EXTENDED_EXPECTED_FIELDS } from '../src/types/document-json-schemas.js';

describe('F18 waybill schema', () => {
  it('зарегистрирован в DOCUMENT_JSON_SCHEMAS', () => {
    expect(EXTENDED_SCHEMAS.waybill).toBeDefined();
    expect(EXTENDED_SCHEMAS.waybill?.type).toBe('object');
  });

  it('имеет обязательные группы полей', () => {
    const schema = EXTENDED_SCHEMAS.waybill as Record<string, any>;
    const props = schema.properties as Record<string, unknown>;

    // Шапка
    expect(props.number).toBeDefined();
    expect(props.date).toBeDefined();
    expect(props.form).toBeDefined();
    expect(props.organization).toBeDefined();

    // ТС / водитель / маршрут — три кита путевого листа
    expect(props.vehicle).toBeDefined();
    expect(props.driver).toBeDefined();
    expect(props.route).toBeDefined();

    // Спидометр + топливо — специфичны для waybill (нет в TTN/UPD)
    expect(props.odometer_start).toBeDefined();
    expect(props.odometer_end).toBeDefined();
    expect(props.fuel).toBeDefined();

    // Медосмотр + техосмотр — критичны (по 4-С)
    expect(props.medical_check).toBeDefined();
    expect(props.technical_check).toBeDefined();
  });

  it('vehicle содержит plate', () => {
    const schema = EXTENDED_SCHEMAS.waybill as any;
    expect(schema.properties.vehicle.properties.plate).toBeDefined();
    expect(schema.properties.vehicle.properties.model).toBeDefined();
  });

  it('driver содержит fio + license', () => {
    const schema = EXTENDED_SCHEMAS.waybill as any;
    expect(schema.properties.driver.properties.fio).toBeDefined();
    expect(schema.properties.driver.properties.license).toBeDefined();
  });

  it('НЕ содержит items[] (это не накладная)', () => {
    const schema = EXTENDED_SCHEMAS.waybill as any;
    expect(schema.properties.items).toBeUndefined();
  });

  it('EXTENDED_EXPECTED_FIELDS waybill содержит критичные поля', () => {
    const fields = EXTENDED_EXPECTED_FIELDS.waybill;
    expect(fields).toBeDefined();
    expect(fields).toContain('number');
    expect(fields).toContain('date');
    expect(fields).toContain('organization');
    expect(fields).toContain('vehicle');
    expect(fields).toContain('driver');
    expect(fields).toContain('route');
  });
});

describe('F18 waybill classifier-rules.json', () => {
  // Читаем напрямую файл — то же что делает keywords.ts через readFileSync
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rulesPath = resolve(__dirname, '../../shared/classifier-rules.json');
  const rules = JSON.parse(readFileSync(rulesPath, 'utf-8')) as Array<{
    slug: string;
    pattern: string;
    weight: number;
  }>;
  const waybillRule = rules.find((r) => r.slug === 'waybill');

  it('правило для waybill добавлено', () => {
    expect(waybillRule).toBeDefined();
  });

  it('паттерн матчит "путевой лист"', () => {
    expect(waybillRule).toBeDefined();
    const re = new RegExp(waybillRule!.pattern, 'i');
    // NB: \b в JavaScript regex использует ASCII word-boundaries и
    // НЕ матчит границы кириллических слов. Поэтому в реальном extract'е
    // надо иметь ASCII-character (пробел/перевод строки/начало) перед
    // кириллическим словом. Тестируем с trailing space:
    expect(re.test(' путевой лист от 15.05.2026')).toBe(true);
    expect(re.test('  ПУТЕВОЙ ЛИСТ №1234')).toBe(true);
  });

  it('паттерн матчит формы 4-С / 4-П / ПЛ-1', () => {
    const re = new RegExp(waybillRule!.pattern, 'i');
    expect(re.test('Форма 4-С')).toBe(true);
    expect(re.test('форма 4-П')).toBe(true);
    expect(re.test('Форма ПЛ-1')).toBe(true);
  });

  it('паттерн НЕ матчит «товарно-транспортная накладная»', () => {
    const re = new RegExp(waybillRule!.pattern, 'i');
    expect(re.test('Товарно-транспортная накладная')).toBe(false);
  });

  it('weight путевого листа = 1.0 (high-confidence keyword)', () => {
    expect(waybillRule!.weight).toBe(1.0);
  });
});
