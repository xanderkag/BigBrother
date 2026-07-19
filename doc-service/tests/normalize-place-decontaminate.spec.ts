/**
 * FIX-F (SLAI 2026-07-19): place_of_delivery замусорен именем грузополучателя.
 */
import { describe, expect, it } from 'vitest';
import {
  decontaminatePlaceFields,
  stripPartyNameFromPlace,
} from '../src/pipeline/normalize/place-decontaminate.js';

describe('stripPartyNameFromPlace', () => {
  it('имя-префикс + город → город (кейс #4 OSKAR)', () => {
    expect(stripPartyNameFromPlace('LLP MONDELEZ KAZAKHSTAN ALMATY', 'LLP MONDELEZ KAZAKHSTAN')).toBe('ALMATY');
  });

  it('город-префикс + имя-суффикс → город', () => {
    expect(stripPartyNameFromPlace('ALMATY, LLP MONDELEZ KAZAKHSTAN', 'LLP MONDELEZ KAZAKHSTAN')).toBe('ALMATY');
  });

  it('имя без юр-формы в поле места, но с формой в party.name → всё равно матч', () => {
    // поле: «MONDELEZ KAZAKHSTAN ALMATY», имя: «LLP MONDELEZ KAZAKHSTAN»
    expect(stripPartyNameFromPlace('MONDELEZ KAZAKHSTAN ALMATY', 'LLP MONDELEZ KAZAKHSTAN')).toBe('ALMATY');
  });

  it('разный регистр → матч регистронезависимо', () => {
    expect(stripPartyNameFromPlace('llp mondelez kazakhstan Almaty', 'LLP MONDELEZ KAZAKHSTAN')).toBe('Almaty');
  });

  it('имени нет в поле → null (не трогаем)', () => {
    expect(stripPartyNameFromPlace('Zagreb', 'LLP MONDELEZ KAZAKHSTAN')).toBeNull();
  });

  it('поле = только имя, города нет → null (не блэнкуем)', () => {
    expect(stripPartyNameFromPlace('LLP MONDELEZ KAZAKHSTAN', 'LLP MONDELEZ KAZAKHSTAN')).toBeNull();
  });

  it('короткое имя (< 3 симв.) не матчим — иначе испортим место', () => {
    expect(stripPartyNameFromPlace('Riga', 'AO')).toBeNull();
  });

  it('остаток-мусор (без букв) → null', () => {
    expect(stripPartyNameFromPlace('LLP MONDELEZ KAZAKHSTAN 12', 'LLP MONDELEZ KAZAKHSTAN')).toBeNull();
  });
});

describe('decontaminatePlaceFields', () => {
  const oskar = () => ({
    place_of_loading: 'Zagreb',
    loading_place: 'Zagreb',
    place_of_delivery: 'LLP MONDELEZ KAZAKHSTAN ALMATY',
    delivery_place: 'LLP MONDELEZ KAZAKHSTAN ALMATY',
    consignee: { name: 'LLP MONDELEZ KAZAKHSTAN', address: '101 TOLE BI STR, 050012 ALMATY', country: 'KZ' },
    consignor: { name: 'PODRAVKA', country: 'HR' },
  });

  it('кейс #4: обе формы delivery → ALMATY, loading (чистый) не тронут', () => {
    const out = decontaminatePlaceFields(oskar()) as any;
    expect(out.place_of_delivery).toBe('ALMATY');
    expect(out.delivery_place).toBe('ALMATY');
    expect(out.place_of_loading).toBe('Zagreb');
    expect(out.loading_place).toBe('Zagreb');
  });

  it('имя грузополучателя остаётся в consignee.name (не удаляем сторону)', () => {
    const out = decontaminatePlaceFields(oskar()) as any;
    expect(out.consignee.name).toBe('LLP MONDELEZ KAZAKHSTAN');
  });

  it('пишет аудит-канал _place_decontaminated', () => {
    const out = decontaminatePlaceFields(oskar()) as any;
    expect(out._place_decontaminated.place_of_delivery).toBe('ALMATY');
  });

  it('чистое место → объект не меняется (та же ссылка)', () => {
    const clean = { place_of_delivery: 'Almaty', consignee: { name: 'LLP MONDELEZ KAZAKHSTAN' } };
    expect(decontaminatePlaceFields(clean)).toBe(clean);
  });

  it('нет стороны → не трогаем место', () => {
    const noParty = { place_of_delivery: 'LLP MONDELEZ KAZAKHSTAN ALMATY' };
    expect(decontaminatePlaceFields(noParty)).toBe(noParty);
  });

  it('идемпотентна: второй проход ничего не меняет', () => {
    const first = decontaminatePlaceFields(oskar()) as any;
    const second = decontaminatePlaceFields(first) as any;
    expect(second.place_of_delivery).toBe('ALMATY');
    expect(second).toBe(first);
  });

  it('loading тоже чистится, когда замусорен именем отправителя', () => {
    const out = decontaminatePlaceFields({
      place_of_loading: 'PODRAVKA Koprivnica',
      consignor: { name: 'PODRAVKA' },
    }) as any;
    expect(out.place_of_loading).toBe('Koprivnica');
  });

  it('null / не-объект → как есть', () => {
    expect(decontaminatePlaceFields(null)).toBeNull();
  });
});
