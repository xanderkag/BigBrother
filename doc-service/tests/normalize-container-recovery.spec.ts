/**
 * Unit'ы на recoverContainersFromText (SLAI Q15) — DB-free.
 *
 * Контракт: добить ISO 6346 из raw_text по метке «контейнер», ТОЛЬКО когда
 * модель контейнер не дала; извлечённое моделью не перетираем; без метки не
 * ловим (anti-false-positive).
 */
import { describe, it, expect } from 'vitest';
import { recoverContainersFromText } from '../src/pipeline/normalize/container-recovery.js';

describe('recoverContainersFromText', () => {
  it('CMR: модель пропустила контейнер → добиваем из строки «Контейнер,TCLU7654321»', () => {
    const ex = { number: 'CMR-1', cargo: { description: 'станки' } };
    const text = 'CMR № CMR-1\nПеревозчик,DB Schenker\nКонтейнер,TCLU7654321\nГруз,станки';
    const out = recoverContainersFromText(ex, text)!;
    expect(out).not.toBe(ex); // новый объект
    expect(out.containers).toEqual([{ number: 'TCLU7654321' }]);
    expect(out._container_recovered).toEqual(['TCLU7654321']);
  });

  it('Акт: контейнер в тексте услуги «перевозке контейнера GESU2345678»', () => {
    const ex = { number: 'AKT-1' };
    const text = 'Услуга,Транспортно-экспедиционные услуги по перевозке контейнера GESU2345678 по маршруту';
    const out = recoverContainersFromText(ex, text)!;
    expect(out.containers).toEqual([{ number: 'GESU2345678' }]);
  });

  it('модель уже дала контейнер (container_number) → НЕ трогаем', () => {
    const ex = { container_number: 'MSCU1234567' };
    const text = 'Контейнер,TCLU7654321';
    const out = recoverContainersFromText(ex, text);
    expect(out).toBe(ex); // тот же объект, без изменений
  });

  it('модель дала контейнер в containers[].number → НЕ трогаем', () => {
    const ex = { containers: [{ number: 'MSCU1234567' }] };
    const out = recoverContainersFromText(ex, 'Контейнер,TCLU7654321');
    expect(out).toBe(ex);
  });

  it('нет метки «контейнер» рядом с токеном → НЕ ловим (anti-false-positive)', () => {
    const ex = { number: 'INV-1' };
    // Похожий на ISO 6346 токен, но без метки контейнера.
    const text = 'Артикул,ABCD1234567\nНомер партии,XXXX9999999';
    const out = recoverContainersFromText(ex, text);
    expect(out).toBe(ex);
  });

  it('несколько контейнеров → собираем все уникальные', () => {
    const ex = { number: 'BL-1' };
    const text = 'Контейнер: MSCU1234567\nКонтейнер: TCLU7654321\nКонтейнер: MSCU1234567';
    const out = recoverContainersFromText(ex, text)!;
    expect(out.containers).toEqual([{ number: 'MSCU1234567' }, { number: 'TCLU7654321' }]);
  });

  it('пустой raw_text / null → возвращаем как есть', () => {
    const ex = { number: 'X' };
    expect(recoverContainersFromText(ex, null)).toBe(ex);
    expect(recoverContainersFromText(ex, '')).toBe(ex);
  });
});
