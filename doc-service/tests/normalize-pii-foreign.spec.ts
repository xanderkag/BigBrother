/**
 * §8.5а (CLASSIFIER-PACKET-V2): расширение PII-redact на MRZ и иностранные
 * удостоверения. Корпус БКТ мультиязычный (BY/KGZ/LV) — российский
 * passport_rf их не ловит.
 */
import { describe, expect, it } from 'vitest';
import { redactPii } from '../src/pipeline/normalize/pii-redact.js';

describe('redactPii — MRZ паспорта', () => {
  it('редактирует MRZ строку 1 (name-line P<XXX)', () => {
    const r = redactPii({
      raw_block: 'P<BLRAUSIYEVICH<<PIOTR<<<<<<<<<<<<<<<<<<<<<',
    });
    expect((r as any).raw_block).not.toContain('AUSIYEVICH');
    expect((r as any).raw_block).toContain('[REDACTED]');
  });

  it('редактирует MRZ строку 2 (data-line: номер+ДР+срок)', () => {
    const r = redactPii({
      raw_block: 'AB12345678BLR7501012M3001019<<<<<<<<<<<<<<',
    });
    expect((r as any).raw_block).not.toContain('AB1234567');
    expect((r as any).raw_block).not.toContain('750101');
    expect((r as any).raw_block).toContain('[REDACTED]');
  });

  it('редактирует обе MRZ-строки в одном поле', () => {
    const r = redactPii({
      passport_ocr:
        'P<KGZMAMETKAZIEV<<AIBEK<<<<<<<<<<<<<<<<<<<<\nAN90966BC9KGZ8203015M2909018<<<<<<<<<<<<<<06',
    });
    expect((r as any).passport_ocr).not.toContain('MAMETKAZIEV');
    expect((r as any).passport_ocr).not.toContain('820301');
  });
});

describe('redactPii — иностранные ID и коды', () => {
  it('редактирует номер паспорта по контексту', () => {
    const r = redactPii({ notes: 'Passport No AB123456 выдан 2019' });
    expect((r as any).notes).not.toContain('123456');
    expect((r as any).notes).toContain('[REDACTED]');
  });

  it('редактирует латвийский персональный код (6-5)', () => {
    const r = redactPii({ holder_extra: 'Kods 220367-11114' });
    expect((r as any).holder_extra).not.toContain('220367-11114');
    expect((r as any).holder_extra).toContain('[REDACTED]');
  });

  it('редактирует персональный код по контексту (asmens kodas)', () => {
    const r = redactPii({ notes: 'asmens kodas 38801234567 водителя' });
    expect((r as any).notes).not.toContain('38801234567');
    expect((r as any).notes).toContain('[REDACTED]');
  });

  it('НЕ трогает ИНН/ОГРН без ПДн-контекста', () => {
    const r = redactPii({ seller: { inn: '7707083893', ogrn: '1027700132195' } });
    expect((r as any).seller.inn).toBe('7707083893');
    expect((r as any).seller.ogrn).toBe('1027700132195');
  });
});

describe('redactPii — ID-поля (holder/passport_number/mrz)', () => {
  it('редактирует holder.name, passport_number, date_of_birth, mrz', () => {
    const r = redactPii({
      holder: { name: 'Ausiyevich Piotr' },
      passport_number: 'AB1234567',
      date_of_birth: '1975-01-01',
      mrz: 'P<BLRAUSIYEVICH<<PIOTR<<<',
    });
    expect((r as any).holder.name).toBe('[REDACTED]');
    expect((r as any).passport_number).toBe('[REDACTED]');
    expect((r as any).date_of_birth).toBe('[REDACTED]');
    expect((r as any).mrz).toBe('[REDACTED]');
  });
});
