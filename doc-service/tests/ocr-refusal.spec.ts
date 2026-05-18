/**
 * Тесты на детектор «модель отказалась прочитать изображение».
 * Источник кейсов — реальный VED-кейс eac-cert.pdf 2026-05-18.
 */
import { describe, expect, it } from 'vitest';
import { detectOcrRefusal } from '../src/pipeline/ocr/refusal.js';

describe('detectOcrRefusal', () => {
  it('detects short Russian refusal (1 sentence)', () => {
    const text =
      'Извините, я не могу просматривать изображения или видимый текст на них.';
    const res = detectOcrRefusal(text);
    expect(res.isRefusal).toBe(true);
    expect(res.preview).toContain('просматривать изображения');
  });

  it('detects repeated refusal (real eac-cert.pdf case)', () => {
    // Фактический pattern: vision-LLM на 4-страничный скан-PDF вернул
    // 4 копии того же отказа.
    const refusal =
      'Извините, я не могу просматривать изображения или видимый текст на них. Если у вас есть текст, который вы хотели бы переписать, пожалуйста, скопируйте его и вставьте здесь, и я с радостью помогу!';
    const text = [refusal, refusal, refusal, refusal].join('\n\n');
    const res = detectOcrRefusal(text);
    expect(res.isRefusal).toBe(true);
    // Coverage не обязательно очень высокий — паттерн матчит ключевую
    // часть фразы, остальное «если у вас есть текст…» в покрытии не
    // считается. Главное что детектор сработал.
    expect(res.coverage).toBeGreaterThan(0.05);
  });

  it('detects English refusal (Claude/GPT style)', () => {
    const text =
      "I'm sorry, I cannot view images. If you have text to extract, please paste it here.";
    expect(detectOcrRefusal(text).isRefusal).toBe(true);
  });

  it('detects "unable to view"', () => {
    expect(
      detectOcrRefusal('I am unable to view this attachment').isRefusal,
    ).toBe(true);
  });

  it('does NOT trigger on legitimate document mentioning "image"', () => {
    // Длинный документ который случайно содержит refusal-like phrase
    // в теле — не должен помечаться как отказ (coverage < 30%).
    const longDoc =
      'Договор поставки № 12/2024 от 15 января 2024 года. ' +
      'Поставщик ООО «Альфа», покупатель ООО «Бета». ' +
      'Предмет договора: поставка офисной мебели. ' +
      'Стоимость: 1 000 000 рублей. Срок поставки: 30 дней. ' +
      'Поставщик предоставляет покупателю каталог с изображениями. '.repeat(15);
    const res = detectOcrRefusal(longDoc);
    expect(res.isRefusal).toBe(false);
  });

  it('handles empty string', () => {
    expect(detectOcrRefusal('').isRefusal).toBe(false);
  });

  it('does NOT trigger on normal OCR output', () => {
    const text =
      'СЧЁТ № СЧ-1787/1\nот 2026-04-22\nПоставщик: ИП Иванов И.И., ИНН 500100732259\n' +
      'Покупатель: ООО «Складские Решения», ИНН 7704211201';
    expect(detectOcrRefusal(text).isRefusal).toBe(false);
  });
});
