/**
 * PII redaction (F4) — тесты на known-field-paths и regex-чистку строк.
 */
import { describe, expect, it } from 'vitest';
import { redactPii } from '../src/pipeline/normalize/pii-redact.js';

describe('redactPii — known field paths', () => {
  it('редактирует vehicle.driver', () => {
    const r = redactPii({
      vehicle: {
        plate: 'А123ВВ77',
        driver: 'Сидоров П.Р.',
      },
    });
    expect((r as any).vehicle.driver).toBe('[REDACTED]');
    expect((r as any).vehicle.plate).toBe('А123ВВ77'); // НЕ редактим
    expect((r as any)._redacted_fields).toContain('vehicle.driver');
  });

  it('редактирует driver_phone и контакт-персону', () => {
    const r = redactPii({
      vehicle: { driver_phone: '+7 (495) 123-45-67' },
      seller: { name: 'ООО Тест', inn: '7707083893', contact_person: 'Иванов И.И.' },
    });
    expect((r as any).vehicle.driver_phone).toBe('[REDACTED]');
    expect((r as any).seller.contact_person).toBe('[REDACTED]');
    expect((r as any).seller.name).toBe('ООО Тест'); // НЕ редактим
    expect((r as any).seller.inn).toBe('7707083893'); // НЕ редактим
  });

  it('не падает на null/undefined значениях', () => {
    const r = redactPii({
      vehicle: { driver: null, driver_phone: undefined },
    });
    expect((r as any).vehicle.driver).toBe(null);
    expect((r as any)._redacted_fields).toBeUndefined();
  });
});

describe('redactPii — regex в свободных полях', () => {
  it('редактирует паспортные данные в свободном тексте', () => {
    const r = redactPii({
      notes: 'Документы водителя: паспорт 4501 №123456, выдан...',
    });
    expect((r as any).notes).not.toContain('4501');
    expect((r as any).notes).not.toContain('123456');
    expect((r as any).notes).toContain('[REDACTED]');
  });

  it('редактирует телефон в свободном тексте', () => {
    const r = redactPii({
      payment_purpose: 'Звонить по тел. +7 (495) 123-45-67 для подтверждения',
    });
    expect((r as any).payment_purpose).toContain('[REDACTED]');
    expect((r as any).payment_purpose).not.toContain('495');
  });

  it('редактирует email', () => {
    const r = redactPii({
      seller: { name: 'ООО Тест', email_extra: 'driver@example.com — менеджер' },
    });
    expect((r as any).seller.email_extra).toContain('[REDACTED]');
    expect((r as any).seller.email_extra).not.toContain('@example');
  });
});

describe('redactPii — что НЕ редактим', () => {
  it('оставляет ИНН юрлица', () => {
    const r = redactPii({
      seller: { inn: '7707083893', kpp: '770701001' },
      buyer: { inn: '5024169813' },
    });
    expect((r as any).seller.inn).toBe('7707083893');
    expect((r as any).seller.kpp).toBe('770701001');
    expect((r as any).buyer.inn).toBe('5024169813');
  });

  it('оставляет ИНН ИП (12 цифр)', () => {
    const r = redactPii({
      seller: { inn: '500100732259' },
    });
    expect((r as any).seller.inn).toBe('500100732259');
  });

  it('оставляет госномер ТС', () => {
    const r = redactPii({
      vehicle: { plate: 'А123ВВ77', driver: 'Сидоров П.Р.' },
    });
    expect((r as any).vehicle.plate).toBe('А123ВВ77');
    expect((r as any).vehicle.driver).toBe('[REDACTED]');
  });

  it('оставляет _normalized_fields (там ИНН и plate)', () => {
    const r = redactPii({
      _normalized_fields: { 'seller.inn': '7707083893', 'vehicle.plate': 'А123ВВ77' },
      vehicle: { driver: 'Сидоров' },
    });
    expect((r as any)._normalized_fields['seller.inn']).toBe('7707083893');
    expect((r as any)._normalized_fields['vehicle.plate']).toBe('А123ВВ77');
    expect((r as any).vehicle.driver).toBe('[REDACTED]');
  });
});

describe('redactPii — идемпотентность', () => {
  it('повторный вызов не двойной [REDACTED]', () => {
    const r1 = redactPii({ vehicle: { driver: 'Сидоров П.Р.' } });
    const r2 = redactPii(r1);
    expect((r2 as any).vehicle.driver).toBe('[REDACTED]');
  });

  it('null на вход — null на выход', () => {
    expect(redactPii(null)).toBe(null);
  });
});

describe('redactPii — реалистичный пример', () => {
  it('редактирует ТТН целиком', () => {
    const ttn = {
      document_type: 'TTN',
      number: 'ТТН-37020/1',
      date: '2026-04-04',
      seller: {
        name: 'ИП Иванов И.И.',
        inn: '500100732259',
        contact_person: 'Иванов И.И.',
      },
      buyer: {
        name: 'ООО ТАЙПИТ',
        inn: '5024169813',
      },
      vehicle: {
        plate: 'А123ВВ77',
        driver: 'Сидоров П.Р.',
        driver_phone: '+7 495 1234567',
        driver_passport: '4501 123456',
      },
      notes: 'Контакт менеджера: maxim@taipit.ru, +7-916-555-12-34',
    };
    const r = redactPii(ttn);

    // PII удалено
    expect((r as any).seller.contact_person).toBe('[REDACTED]');
    expect((r as any).vehicle.driver).toBe('[REDACTED]');
    expect((r as any).vehicle.driver_phone).toBe('[REDACTED]');
    expect((r as any).vehicle.driver_passport).toBe('[REDACTED]');
    expect((r as any).notes).not.toContain('@taipit');
    expect((r as any).notes).not.toContain('916');

    // Не-PII осталось
    expect((r as any).number).toBe('ТТН-37020/1');
    expect((r as any).date).toBe('2026-04-04');
    expect((r as any).seller.name).toBe('ИП Иванов И.И.');
    expect((r as any).seller.inn).toBe('500100732259');
    expect((r as any).buyer.name).toBe('ООО ТАЙПИТ');
    expect((r as any).buyer.inn).toBe('5024169813');
    expect((r as any).vehicle.plate).toBe('А123ВВ77');

    // Аудит-список
    expect((r as any)._redacted_fields).toContain('vehicle.driver');
    expect((r as any)._redacted_fields).toContain('vehicle.driver_phone');
    expect((r as any)._redacted_fields).toContain('seller.contact_person');
  });
});
