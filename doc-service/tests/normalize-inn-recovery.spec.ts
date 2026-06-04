/**
 * F0 recoverPartyInnsFromText — добивание ИНН сторон из raw_text по меткам.
 *
 * Юнит-тесты на чистую функцию (без БД): извлечение из окна метки,
 * checksum-гейт, неперетирание валидного значения модели, идемпотентность.
 */
import { describe, expect, it } from 'vitest';
import { recoverPartyInnsFromText } from '../src/pipeline/normalize/inn-recovery.js';

// Реальные валидные ИНН (прошли checksum):
//   7722753969 — ВсеИнструменты (10-зн), 7811472920 — ТАЙПИТ (10-зн).
const SELLER_INN = '7722753969';
const BUYER_INN = '7811472920';

describe('recoverPartyInnsFromText (F0)', () => {
  it('добивает seller/buyer.inn из меток, когда модель дала placeholder', () => {
    const text =
      'Поставщик: ООО «ВсеИнструменты.ру», ИНН 7722753969, КПП 997750001\n' +
      'Покупатель: ООО «ТАЙПИТ», ИНН 7811472920, КПП 784201001';
    const r = recoverPartyInnsFromText(
      { seller: { inn: 'не указан' }, buyer: { inn: 'не указан' } },
      text,
    ) as any;
    expect(r.seller.inn).toBe(SELLER_INN);
    expect(r.buyer.inn).toBe(BUYER_INN);
    expect(r._inn_recovered['seller.inn']).toBe(SELLER_INN);
    expect(r._inn_recovered['buyer.inn']).toBe(BUYER_INN);
  });

  it('окно метки: ИНН поставщика не утекает в покупателя', () => {
    // У «Поставщик» в его окне ИНН нет — должен остаться placeholder,
    // ИНН из блока «Покупатель» НЕ должен подставиться поставщику.
    const text = 'Поставщик: ООО «А»\nПокупатель: ООО «Б», ИНН 7811472920';
    const r = recoverPartyInnsFromText(
      { seller: { inn: 'не указан' }, buyer: { inn: 'не указан' } },
      text,
    ) as any;
    expect(r.seller.inn).toBe('не указан'); // не тронут
    expect(r.buyer.inn).toBe(BUYER_INN);
  });

  it('не перетирает валидный ИНН, который дала модель', () => {
    const text = 'Поставщик: ООО «А», ИНН 7722753969, КПП 997750001';
    const r = recoverPartyInnsFromText(
      { seller: { inn: '7728168971' } }, // валидный, но другой
      text,
    ) as any;
    expect(r.seller.inn).toBe('7728168971'); // модель победила
    // ничего не восстановили → объект не клонировали, _inn_recovered нет
    expect(r._inn_recovered).toBeUndefined();
  });

  it('checksum-гейт: число рядом с меткой, но не валидный ИНН — игнор', () => {
    // 1234567890 не проходит контрольную сумму ИНН → не подставляем.
    const text = 'Поставщик: ООО «А», ИНН 1234567890';
    const r = recoverPartyInnsFromText({ seller: { inn: 'не указан' } }, text) as any;
    expect(r.seller.inn).toBe('не указан');
    expect(r._inn_recovered).toBeUndefined();
  });

  it('формат «ИНН/КПП 7722753969/997750001» — берёт ровно ИНН', () => {
    const text = 'Поставщик: ООО «А» ИНН/КПП 7722753969/997750001';
    const r = recoverPartyInnsFromText({ seller: { inn: '' } }, text) as any;
    expect(r.seller.inn).toBe(SELLER_INN);
  });

  it('создаёт party-объект, если его не было', () => {
    const text = 'Грузополучатель: ООО «Б», ИНН 7811472920';
    const r = recoverPartyInnsFromText({}, text) as any;
    expect(r.consignee.inn).toBe(BUYER_INN);
  });

  it('нет rawText → возвращает исходный объект без изменений', () => {
    const input = { seller: { inn: 'не указан' } };
    expect(recoverPartyInnsFromText(input, null)).toBe(input);
    expect(recoverPartyInnsFromText(input, '')).toBe(input);
    expect(recoverPartyInnsFromText(input, undefined)).toBe(input);
  });

  it('нет меток в тексте → возвращает исходный объект', () => {
    const input = { seller: { inn: 'не указан' } };
    expect(recoverPartyInnsFromText(input, 'просто текст без сторон')).toBe(input);
  });

  it('идемпотентна: второй проход ничего не меняет', () => {
    const text = 'Поставщик: ООО «А», ИНН 7722753969';
    const first = recoverPartyInnsFromText({ seller: { inn: 'не указан' } }, text) as any;
    const second = recoverPartyInnsFromText(first, text) as any;
    expect(second.seller.inn).toBe(SELLER_INN);
    expect(second._inn_recovered).toEqual(first._inn_recovered);
  });

  it('null/невалидный extracted → возвращается как есть', () => {
    expect(recoverPartyInnsFromText(null, 'Поставщик: ИНН 7722753969')).toBeNull();
  });
});
