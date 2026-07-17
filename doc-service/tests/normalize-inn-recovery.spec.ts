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

/**
 * FIX-B (находки SLAI 2026-07-16, docs/BCTT_EXTRACT_FIXES.md).
 *
 * Регрессия (заказ #5 БКТ): `inv_1.jpeg` + `pac_1.jpeg` → seller.inn = 7707083893
 * = ИНН ПАО «Сбербанк», при том что продавец — SIA BALTEREX (Латвия), у которой
 * российского ИНН быть не может. ИНН взят из БЛОКА ПЛАТЁЖНЫХ РЕКВИЗИТОВ: он
 * настоящий и проходит checksum, поэтому «первый ИНН в окне» его принимал.
 *
 * Цена ошибки: оба документа дают ОДНО значение → кросс-документная сверка SLAI
 * красит поле зелёным. Хуже явного промаха — ЕГРЮЛ и контрольная сумма проходят.
 */
const SBER_INN = '7707083893'; // ПАО «Сбербанк» — настоящий ИНН, checksum валиден

describe('recoverPartyInnsFromText — FIX-B: ИНН банка не выдаём за сторону', () => {
  it('банковский блок в окне стороны → ИНН Сбербанка НЕ попадает в seller', () => {
    const text = [
      'Поставщик: SIA BALTEREX, Латвия',
      'Банк получателя: ПАО СБЕРБАНК г. Москва',
      `ИНН ${SBER_INN}  КПП 773643001  БИК 044525225`,
    ].join('\n');
    const out = recoverPartyInnsFromText({ seller: { inn: 'не указан' } }, text) as any;
    // Лучше пусто, чем чужой ИНН: ложно-зелёная сверка дороже явного промаха.
    expect(out.seller?.inn).not.toBe(SBER_INN);
    expect(out._inn_recovered ?? {}).not.toHaveProperty('seller.inn');
  });

  it('свой ИНН до банковского блока → добивается корректно (банк не мешает)', () => {
    const text = [
      `Поставщик: ООО «Ромашка», ИНН ${SELLER_INN}, КПП 997750001`,
      'Банк получателя: ПАО СБЕРБАНК',
      `ИНН ${SBER_INN}  БИК 044525225`,
    ].join('\n');
    const out = recoverPartyInnsFromText({ seller: { inn: 'не указан' } }, text) as any;
    expect(out.seller.inn).toBe(SELLER_INN);
  });

  it('обе стороны: свои ИНН берём, банковский игнорим', () => {
    const text = [
      `Поставщик: ООО «А», ИНН ${SELLER_INN}`,
      'Банк получателя: ПАО СБЕРБАНК ИНН ' + SBER_INN + ' БИК 044525225',
      `Покупатель: ООО «Б», ИНН ${BUYER_INN}`,
    ].join('\n');
    const out = recoverPartyInnsFromText({}, text) as any;
    expect(out.seller.inn).toBe(SELLER_INN);
    expect(out.buyer.inn).toBe(BUYER_INN);
  });

  it('иностранной стороне (country != RU) российский ИНН не подставляем', () => {
    const text = `Поставщик: SIA BALTEREX, ИНН ${SELLER_INN}`;
    const out = recoverPartyInnsFromText({ seller: { name: 'SIA BALTEREX', country: 'LV' } }, text) as any;
    expect(out.seller.inn).toBeUndefined();
  });

  it('country=RU → добиваем как обычно', () => {
    const text = `Поставщик: ООО «Ромашка», ИНН ${SELLER_INN}`;
    const out = recoverPartyInnsFromText({ seller: { name: 'ООО Ромашка', country: 'RU' } }, text) as any;
    expect(out.seller.inn).toBe(SELLER_INN);
  });

  it('country не задан → поведение прежнее (добиваем)', () => {
    const text = `Поставщик: ООО «Ромашка», ИНН ${SELLER_INN}`;
    const out = recoverPartyInnsFromText({ seller: {} }, text) as any;
    expect(out.seller.inn).toBe(SELLER_INN);
  });
});
