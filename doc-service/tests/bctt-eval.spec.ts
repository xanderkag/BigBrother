/**
 * §9 (CLASSIFIER-PACKET-V2): тесты ядра приёмочного eval'а (без корпуса).
 */
import { describe, expect, it } from 'vitest';
import {
  typeSetMatches,
  typeSetDiff,
  evalCorpus,
  type ActualResult,
} from '../src/scripts/eval/bctt-eval.js';
import { BCTT_GOLDEN, type GoldenCase } from '../src/scripts/eval/bctt-golden.js';

describe('typeSetMatches', () => {
  it('совпадение независимо от порядка и регистра, с дедупом', () => {
    expect(typeSetMatches(['B', 'a', 'a'], ['a', 'b'])).toBe(true);
    expect(typeSetMatches(['cmr'], ['cmr'])).toBe(true);
  });
  it('лишний/недостающий тип → не совпадает', () => {
    expect(typeSetMatches(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(typeSetMatches(['a'], ['a', 'b'])).toBe(false);
  });
  it('typeSetDiff даёт missing/extra', () => {
    expect(typeSetDiff(['a', 'd'], ['a', 'b'])).toEqual({ missing: ['b'], extra: ['d'] });
  });
});

describe('evalCorpus — M1/M2/M4', () => {
  const golden: GoldenCase[] = [
    { id: 'A1', fileMatch: 'SKMBT', flagship: true, types: ['customs_export_ead', 'cmr'] },
    { id: 'X', fileMatch: 'foo', types: ['commercial_invoice'] },
    { id: 'P', fileMatch: 'pass', types: ['driver_passport'], piiEmpty: true },
  ];

  it('считает M1/M2/M4 и итоговый ok', () => {
    const results: ActualResult[] = [
      { file: 'SKMBT_c224.pdf', types: ['cmr', 'customs_export_ead'] }, // A1 pass
      { file: 'foo.pdf', types: ['commercial_invoice', 'packing_list'] }, // X fail (extra)
      { file: 'pass_photo.jpg', types: ['driver_passport'], piiClean: true }, // P pass
    ];
    const ev = evalCorpus(results, golden);
    expect(ev.m1Pass).toBe(2);
    expect(ev.m1Total).toBe(3);
    expect(ev.m2Ok).toBe(true); // единственный флагман A1 прошёл
    expect(ev.m4Ok).toBe(true); // P с piiClean
    expect(ev.cases.find((c) => c.id === 'X')!.extra).toEqual(['packing_list']);
    expect(ev.ok).toBe(false); // 2/3 = 66.7% < 85%
  });

  it('флагман провалился → M2 не ок → ИТОГО не ок', () => {
    const results: ActualResult[] = [
      { file: 'SKMBT.pdf', types: ['cmr'] }, // A1 fail (missing customs_export_ead)
      { file: 'foo.pdf', types: ['commercial_invoice'] },
      { file: 'pass.jpg', types: ['driver_passport'], piiClean: true },
    ];
    const ev = evalCorpus(results, golden);
    expect(ev.m2Ok).toBe(false);
    expect(ev.ok).toBe(false);
  });

  it('ПДн не чист (piiClean=false) → M4 не ок', () => {
    const results: ActualResult[] = [
      { file: 'SKMBT.pdf', types: ['customs_export_ead', 'cmr'] },
      { file: 'foo.pdf', types: ['commercial_invoice'] },
      { file: 'pass.jpg', types: ['driver_passport'], piiClean: false },
    ];
    const ev = evalCorpus(results, golden);
    expect(ev.m4Ok).toBe(false);
    expect(ev.ok).toBe(false);
  });

  it('файл не найден в результатах → кейс не прошёл, matched=false', () => {
    const ev = evalCorpus([], golden);
    expect(ev.m1Pass).toBe(0);
    expect(ev.cases.every((c) => !c.matched)).toBe(true);
  });
});

describe('BCTT_GOLDEN — целостность', () => {
  it('4 флагмана (M2): SKMBT, noreply, 448, 632', () => {
    const flags = BCTT_GOLDEN.filter((g) => g.flagship).map((g) => g.fileMatch);
    expect(flags).toEqual(expect.arrayContaining(['SKMBT', 'noreply', '16-448', '632']));
    expect(flags).toHaveLength(4);
  });
  it('все кейсы имеют непустой набор типов', () => {
    expect(BCTT_GOLDEN.every((g) => g.types.length > 0)).toBe(true);
  });
});
