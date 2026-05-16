/**
 * Normalize identifiers — INN strip+checksum, plate cyr/lat normalization,
 * Damerau-Levenshtein distance.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeInn,
  normalizePlate,
  damerauLevenshtein,
} from '../src/pipeline/normalize/identifiers.js';

describe('normalizeInn', () => {
  it('убирает пунктуацию и пробелы из ИНН юрлица', () => {
    expect(normalizeInn('7728-168-971')).toBe('7728168971');
    expect(normalizeInn('  7728168971  ')).toBe('7728168971');
    expect(normalizeInn('ИНН: 7728168971')).toBe('7728168971');
  });

  it('режет ИНН/КПП пару, берёт только ИНН', () => {
    // Реальный кейс: документ пишет «ИНН/КПП 7728168971/772801001»
    // После replace(/\D/g) получим 7728168971772801001 — 19 цифр, не 10 и не 12.
    // Это правильное поведение: нельзя «угадать» какие 10 цифр были ИНН.
    expect(normalizeInn('7728168971/772801001')).toBeNull();
  });

  it('режет невалидную checksum даже при правильной длине', () => {
    // Меняем последнюю цифру корректного ИНН — checksum должна не сойтись
    expect(normalizeInn('7728168972')).toBeNull();  // правильно: 7728168971
  });

  it('принимает 12-значный ИНН ИП', () => {
    // Сгенерирован валидный: 500100732259 (из нашего pool)
    expect(normalizeInn('500100732259')).toBe('500100732259');
    expect(normalizeInn('500-100-732-259')).toBe('500100732259');
  });

  it('null на пустые / странные значения', () => {
    expect(normalizeInn(null)).toBeNull();
    expect(normalizeInn(undefined)).toBeNull();
    expect(normalizeInn('')).toBeNull();
    expect(normalizeInn('abc')).toBeNull();
    expect(normalizeInn('123')).toBeNull();         // слишком короткий
    expect(normalizeInn('1234567890123')).toBeNull(); // слишком длинный
  });
});

describe('normalizePlate', () => {
  it('маппит латиницу на кириллицу', () => {
    // A123BB77 (всё латиница) → А123ВВ77 (всё кириллица)
    expect(normalizePlate('A123BB77')).toBe('А123ВВ77');
    expect(normalizePlate('a123bb77')).toBe('А123ВВ77');
  });

  it('убирает пробелы и пунктуацию', () => {
    expect(normalizePlate('А 123 ВВ 77')).toBe('А123ВВ77');
    expect(normalizePlate('А-123-ВВ-77')).toBe('А123ВВ77');
  });

  it('принимает 3-значный регион (199, 750, etc.)', () => {
    expect(normalizePlate('М500НТ199')).toBe('М500НТ199');
    expect(normalizePlate('m500ht199')).toBe('М500НТ199');
  });

  it('исправляет O/0 в позиции цифры', () => {
    // O123ВВ77 — первая O — буква (О). Цифровые позиции 1,2,3 — там 1,2,3.
    expect(normalizePlate('О123ВВ77')).toBe('О123ВВ77');
    // OO в позициях букв (середина) — должны остаться О
    // А5O7ВВ77 → A5O7BB77 — символ O в позиции 2 (цифра) должен стать 0
    expect(normalizePlate('А5O7ВВ77')).toBe('А507ВВ77');
  });

  it('null на нераспознаваемом формате', () => {
    expect(normalizePlate('123ABC')).toBeNull();
    expect(normalizePlate('')).toBeNull();
    expect(normalizePlate(null)).toBeNull();
    expect(normalizePlate('ПИВО777')).toBeNull(); // буквы не из ГИБДД набора
  });

  it('идемпотентна — повторный вызов на нормализованной строке возвращает её', () => {
    expect(normalizePlate('А123ВВ77')).toBe('А123ВВ77');
    expect(normalizePlate(normalizePlate('a123bb77'))).toBe('А123ВВ77');
  });
});

describe('damerauLevenshtein', () => {
  it('0 для одинаковых строк', () => {
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
  });

  it('1 для одной замены', () => {
    expect(damerauLevenshtein('Иванов', 'Иванев')).toBe(1);
  });

  it('1 для одной вставки/удаления', () => {
    expect(damerauLevenshtein('Иванов', 'Иваноов')).toBe(1);
    expect(damerauLevenshtein('Иванов', 'Иванв')).toBe(1);
  });

  it('early exit при превышении maxDistance', () => {
    // Совсем разные строки — должен вернуть maxDistance+1
    expect(damerauLevenshtein('Иванов', 'Сидоров', 2)).toBe(3);
  });

  it('typical use case: ФИО водителя с опечаткой', () => {
    // "Сидоров П.Р." vs "Сидаров П.Р." — 1 опечатка
    expect(damerauLevenshtein('Сидоров П.Р.', 'Сидаров П.Р.')).toBe(1);
  });
});
