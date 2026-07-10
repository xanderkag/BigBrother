import { describe, it, expect } from 'vitest';
import { relocateOgrnFromInn } from '../src/pipeline/normalize/ogrn-relocate.js';

describe('relocateOgrnFromInn', () => {
  it('moves 13-digit OGRN from inn to ogrn', () => {
    const r = relocateOgrnFromInn({
      seller: { name: 'ANJI', inn: '1147847397906' },
    }) as Record<string, any>;
    expect(r.seller.inn).toBeNull();
    expect(r.seller.ogrn).toBe('1147847397906');
    expect(r._ogrn_relocated).toEqual(['seller']);
  });

  it('moves 15-digit OGRNIP too', () => {
    const r = relocateOgrnFromInn({
      buyer: { name: 'ИП Иванов', inn: '304500116000157' },
    }) as Record<string, any>;
    expect(r.buyer.inn).toBeNull();
    expect(r.buyer.ogrn).toBe('304500116000157');
  });

  it('leaves valid 10-digit INN untouched', () => {
    const src = { seller: { name: 'X', inn: '7811595513' } };
    const r = relocateOgrnFromInn(src);
    expect(r).toBe(src); // same ref — no change
  });

  it('leaves valid 12-digit INN (ИП) untouched', () => {
    const src = { seller: { name: 'X', inn: '500100732259' } };
    const r = relocateOgrnFromInn(src);
    expect(r).toBe(src);
  });

  it('handles inn with punctuation (ОГРН 1147847397906)', () => {
    const r = relocateOgrnFromInn({
      seller: { inn: '1147-847-397906' },
    }) as Record<string, any>;
    expect(r.seller.ogrn).toBe('1147847397906');
  });

  it('does not overwrite existing ogrn, but still clears bad inn', () => {
    const r = relocateOgrnFromInn({
      seller: { inn: '1147847397906', ogrn: '9999999999999' },
    }) as Record<string, any>;
    expect(r.seller.inn).toBeNull();
    expect(r.seller.ogrn).toBe('9999999999999'); // kept
  });

  it('processes multiple parties', () => {
    const r = relocateOgrnFromInn({
      seller: { inn: '1147847397906' },
      sender: { inn: '1237700106181' },
      recipient: { inn: '7811595513' }, // valid, untouched
    }) as Record<string, any>;
    expect(r.seller.ogrn).toBe('1147847397906');
    expect(r.sender.ogrn).toBe('1237700106181');
    expect(r.recipient.inn).toBe('7811595513');
    expect(r._ogrn_relocated.sort()).toEqual(['seller', 'sender']);
  });

  it('supports { data: {...} } wrapper', () => {
    const r = relocateOgrnFromInn({
      data: { seller: { inn: '1147847397906' } },
    }) as Record<string, any>;
    expect(r.data.seller.ogrn).toBe('1147847397906');
    expect(r.data._ogrn_relocated).toEqual(['seller']);
  });

  it('null input → null', () => {
    expect(relocateOgrnFromInn(null)).toBeNull();
  });

  it('no party fields → unchanged ref', () => {
    const src = { number: 'X1', date: '2026-01-01' };
    expect(relocateOgrnFromInn(src)).toBe(src);
  });
});
