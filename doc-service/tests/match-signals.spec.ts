/**
 * Unit'ы на buildMatchSignals (PD-CONTRACT-1 §2.1) — DB-free, как tokens.spec.
 *
 * Проверяем:
 *   - schema_version: "1.0" всегда
 *   - present-only: ключ есть только если у документа есть значение
 *     (никаких '' / [] / null в выходе)
 *   - per-type мапинг для bill_of_lading / ttn / invoice (+ выборочно
 *     cmr / wire_transfer / generic fallback / confidence)
 */
import { describe, it, expect } from 'vitest';
import {
  buildMatchSignals,
  MATCH_SIGNALS_SCHEMA_VERSION,
} from '../src/pipeline/normalize/match-signals.js';

describe('buildMatchSignals — общий контракт', () => {
  it('schema_version всегда 1.0', () => {
    expect(buildMatchSignals(null, null).schema_version).toBe('1.0');
    expect(buildMatchSignals('invoice', {}).schema_version).toBe(MATCH_SIGNALS_SCHEMA_VERSION);
  });

  it('пустой extracted → только schema_version (present-only)', () => {
    const s = buildMatchSignals('TTN', {});
    expect(Object.keys(s)).toEqual(['schema_version']);
  });

  it('не эмитит пустые строки / массивы / null', () => {
    const s = buildMatchSignals('bill_of_lading', {
      number: '',
      containers: [],
      shipper: { name: '   ' },
      date: null,
    });
    expect(s.bl_number).toBeUndefined();
    expect(s.containers).toBeUndefined();
    expect(s.parties).toBeUndefined();
    expect(s.dates).toBeUndefined();
    expect(Object.keys(s)).toEqual(['schema_version']);
  });
});

describe('buildMatchSignals — bill_of_lading', () => {
  it('маппит number/containers/parties/dates из плоской BL_SCHEMA', () => {
    const s = buildMatchSignals('bill_of_lading', {
      number: 'FITFL8771877',
      date: '2026-06-03',
      shipped_on_board: '2026-06-01',
      shipper: { name: 'Anji Mingpai', inn: '7728168971' },
      consignee: { name: 'EWL', kpp: '772801001' },
      notify_party: { name: 'Notify Co' },
      containers: [
        { number: 'FITU8888881', seal: 'X1' },
        { number: 'not-a-container' },
        { number: 'FITU8888881' }, // дубль → схлопывается
      ],
    });
    expect(s.bl_number).toBe('FITFL8771877');
    expect(s.containers).toEqual(['FITU8888881']);
    expect(s.parties?.shipper).toEqual({ name: 'Anji Mingpai', inn: '7728168971' });
    expect(s.parties?.consignee).toEqual({ name: 'EWL', kpp: '772801001' });
    expect(s.parties?.notify_party).toEqual({ name: 'Notify Co' });
    expect(s.dates).toEqual({ document: '2026-06-03', shipped_on_board: '2026-06-01' });
    // никаких ttn/cmr/order_refs у BL
    expect(s.ttn_number).toBeUndefined();
    expect(s.cmr_number).toBeUndefined();
    expect(s.order_refs).toBeUndefined();
  });

  it('legacy DB-снимок: bl_number + container_number', () => {
    const s = buildMatchSignals('bill_of_lading', {
      bl_number: 'BL-LEGACY-1',
      containers: [{ container_number: 'MSCU1234567' }],
    });
    expect(s.bl_number).toBe('BL-LEGACY-1');
    expect(s.containers).toEqual(['MSCU1234567']);
  });

  it('контейнер с приклеенным типом/размером → вытаскиваем ISO-подстроку (B/L реальный кейс)', () => {
    const s = buildMatchSignals('bill_of_lading', {
      number: 'BL-1',
      containers: [
        { number: 'MRKU1234567 40HC' }, // ISO + размер через пробел
        { number: 'GESU765432145G1' }, // ISO + тип без пробела
        { number: 'TCLU 7654321' }, // OCR-пробел внутри префикса
        { number: 'AB CD1234567' }, // склейки НЕТ — {4} подряд букв не набирается
      ],
    });
    expect(s.containers).toEqual(['MRKU1234567', 'GESU7654321', 'TCLU7654321']);
  });
});

describe('buildMatchSignals — ttn', () => {
  it('маппит number/vehicle/parties/date; внутренний slug TTN', () => {
    const s = buildMatchSignals('TTN', {
      number: '50_13683',
      date: '2026-06-03',
      shipper: { name: 'Отправитель', inn: '7728168971' },
      consignee: { name: 'Получатель' },
      carrier: { name: 'Перевозчик', inn: '7707083893' },
      vehicle: { plate: 'Х716ТТ797', trailer_plate: 'ЕК451577' },
    });
    expect(s.ttn_number).toBe('50_13683');
    expect(s.vehicle).toEqual({ plate: 'Х716ТТ797', trailer: 'ЕК451577' });
    expect(s.parties?.shipper?.inn).toBe('7728168971');
    expect(s.parties?.carrier?.inn).toBe('7707083893');
    expect(s.dates?.document).toBe('2026-06-03');
    expect(s.bl_number).toBeUndefined();
  });

  it('госномер нормализуется латиница→кириллица', () => {
    const s = buildMatchSignals('TTN', {
      number: 'T-1',
      vehicle: { plate: 'X716TT797' }, // латиница
    });
    expect(s.vehicle?.plate).toBe('Х716ТТ797'); // кириллица
  });
});

describe('buildMatchSignals — invoice / tax_invoice', () => {
  it('маппит parties/totals/dates/order_refs', () => {
    const s = buildMatchSignals('invoice', {
      number: 'INV-1',
      date: '2026-06-03',
      seller: { name: 'Продавец', inn: '7728168971', kpp: '772801001' },
      buyer: { name: 'Покупатель', inn: '7707083893' },
      total: 16280.0,
      currency: 'USD',
      vat: 0,
      order_ref: 'IMP-1877',
    });
    expect(s.parties?.seller).toEqual({ name: 'Продавец', inn: '7728168971', kpp: '772801001' });
    expect(s.parties?.buyer?.inn).toBe('7707083893');
    expect(s.totals).toEqual({ amount: 16280.0, currency: 'USD', vat: 0 });
    expect(s.dates?.document).toBe('2026-06-03');
    expect(s.order_refs).toEqual(['IMP-1877']);
  });

  it('factInvoice (внутренний slug) → tax_invoice проектор', () => {
    const s = buildMatchSignals('factInvoice', {
      seller: { name: 'S' },
      buyer: { name: 'B' },
      total_with_vat: 100,
      currency: 'RUB',
    });
    expect(s.parties?.seller?.name).toBe('S');
    expect(s.totals).toEqual({ amount: 100, currency: 'RUB' });
  });

  it('order_refs отсутствует если нет order_ref поля (не выдумываем)', () => {
    const s = buildMatchSignals('invoice', {
      seller: { name: 'S' },
      total: 1,
    });
    expect(s.order_refs).toBeUndefined();
  });

  it('order_refs из нового top-level массива order_refs[]', () => {
    const s = buildMatchSignals('invoice', {
      total: 1,
      order_refs: ['Заказ № 42', 'PO-2026-118', '  ', 'PO-2026-118'],
    });
    // trim, present-only, dedupe; пустая строка отброшена
    expect(s.order_refs).toEqual(['Заказ № 42', 'PO-2026-118']);
  });

  it('order_refs собираются из top-level + order_number + items[] + positions[] с дедупом', () => {
    const s = buildMatchSignals('upd', {
      order_refs: ['PO-1'],
      order_number: 'PO-2',
      items: [{ order_ref: 'PO-3' }, { order_ref: ' PO-1 ' }],
      positions: [{ order_ref: 'PO-4' }],
    });
    // PO-1 встречается в top-level и в items (после trim) → схлопывается;
    // порядок: top-level → order_ref/order_number → items → positions
    expect(s.order_refs).toEqual(['PO-1', 'PO-2', 'PO-3', 'PO-4']);
  });

  it('totals.vat опускается если vat отсутствует', () => {
    const s = buildMatchSignals('invoice', { total: 100, currency: 'RUB' });
    expect(s.totals).toEqual({ amount: 100, currency: 'RUB' });
    expect('vat' in (s.totals ?? {})).toBe(false);
  });
});

describe('buildMatchSignals — cmr / wire_transfer / generic', () => {
  it('cmr: number + consignor/recipient алиасы', () => {
    const s = buildMatchSignals('CMR', {
      number: 'CMR-1871-RU',
      consignor: { name: 'Sender Co' },
      consignee: { name: 'Recv Co' },
      carrier: { name: 'Carrier', inn: '7707083893' },
      vehicle: { plate: 'А123ВС777' },
    });
    expect(s.cmr_number).toBe('CMR-1871-RU');
    expect(s.parties?.shipper?.name).toBe('Sender Co');
    expect(s.parties?.consignee?.name).toBe('Recv Co');
    expect(s.parties?.carrier?.inn).toBe('7707083893');
  });

  it('cmr: containers из doc-level containers[].number и items[].container_no (SLAI Q15)', () => {
    const s = buildMatchSignals('CMR', {
      number: 'CMR-1',
      containers: [{ number: 'MSCU1234567' }],
      items: [{ container_no: 'TCLU7654321' }],
    });
    expect(s.containers).toEqual(['MSCU1234567', 'TCLU7654321']);
  });

  it('cmr: containers из doc-level скаляра container_number (SLAI Q15)', () => {
    const s = buildMatchSignals('CMR', {
      number: 'CMR-1',
      container_number: 'TCLU7654321',
    });
    expect(s.containers).toEqual(['TCLU7654321']);
  });

  it('wire_transfer_application: payer/payee + amount/currency', () => {
    const s = buildMatchSignals('wire_transfer_application', {
      date: '2026-06-03',
      amount: 50000,
      currency: 'CNY',
      sender_name: 'EWL',
      sender_inn: '7728168971',
      beneficiary_name: 'Anji Mingpai',
    });
    expect(s.parties?.payer).toEqual({ name: 'EWL', inn: '7728168971' });
    expect(s.parties?.payee).toEqual({ name: 'Anji Mingpai' });
    expect(s.totals).toEqual({ amount: 50000, currency: 'CNY' });
  });

  it('неизвестный тип → только generic fallback', () => {
    const s = buildMatchSignals('something_new', {
      seller: { name: 'S', inn: '7728168971' },
      total: 42,
      currency: 'RUB',
      date: '2026-06-03',
    });
    expect(s.parties?.seller?.inn).toBe('7728168971');
    expect(s.totals).toEqual({ amount: 42, currency: 'RUB' });
    expect(s.dates?.document).toBe('2026-06-03');
  });

  it('generic fallback тоже поднимает order_refs (любой тип с заказом)', () => {
    const s = buildMatchSignals('contract', {
      order_refs: ['Заказ № 7'],
      items: [{ order_ref: 'PO-99' }],
    });
    expect(s.order_refs).toEqual(['Заказ № 7', 'PO-99']);
  });

  it('ttn/cmr: order_refs из top-level массива', () => {
    const ttn = buildMatchSignals('TTN', {
      number: 'T-1',
      order_refs: ['Order Ref ABC-1'],
    });
    expect(ttn.order_refs).toEqual(['Order Ref ABC-1']);
    const cmr = buildMatchSignals('CMR', {
      number: 'CMR-1',
      order_refs: ['Our ref. XYZ-9'],
    });
    expect(cmr.order_refs).toEqual(['Our ref. XYZ-9']);
  });
});

describe('buildMatchSignals — services_act (Акт)', () => {
  it('маппит party_a→executor, party_b→customer (внутренний slug AKT → services_act)', () => {
    const s = buildMatchSignals('AKT', {
      number: 'А-2026-1',
      date: '2026-06-03',
      party_a: { name: 'Исполнитель', inn: '7728168971', kpp: '772801001' },
      party_b: { name: 'Заказчик', inn: '7707083893' },
      total: 1000,
      currency: 'RUB',
    });
    expect(s.parties?.executor).toEqual({ name: 'Исполнитель', inn: '7728168971', kpp: '772801001' });
    expect(s.parties?.customer?.inn).toBe('7707083893');
    // generic seller/buyer не должны появляться у акта
    expect(s.parties?.seller).toBeUndefined();
    expect(s.parties?.buyer).toBeUndefined();
    expect(s.totals).toEqual({ amount: 1000, currency: 'RUB' });
    expect(s.dates?.document).toBe('2026-06-03');
  });

  it('confidence для executor/customer из party_a.inn/party_b.inn', () => {
    const s = buildMatchSignals(
      'AKT',
      { party_a: { inn: '7728168971' }, party_b: { inn: '7707083893' } },
      { 'party_a.inn': 0.9, 'party_b.inn': 0.7 },
    );
    expect(s._confidence?.['parties.executor']).toBe(0.9);
    expect(s._confidence?.['parties.customer']).toBe(0.7);
  });

  it('containers из doc-level containers[].number и items[].container_no (SLAI Q15)', () => {
    const s = buildMatchSignals('AKT', {
      number: 'А-1',
      containers: [{ number: 'MSCU1234567' }],
      items: [{ container_no: 'TCLU7654321' }],
    });
    expect(s.containers).toEqual(['MSCU1234567', 'TCLU7654321']);
  });

  it('order_refs собирается из ex.order_refs (SLAI Q15)', () => {
    const s = buildMatchSignals('AKT', {
      number: 'А-1',
      order_refs: ['Заказ № 42', 'PO-2026-118'],
    });
    expect(s.order_refs).toEqual(['Заказ № 42', 'PO-2026-118']);
  });

  it('пустой акт → только schema_version (present-only)', () => {
    expect(Object.keys(buildMatchSignals('AKT', {}))).toEqual(['schema_version']);
  });
});

describe('buildMatchSignals — §2.3 confidence', () => {
  it('_confidence наполняется из field-confidence для присутствующих сигналов', () => {
    const s = buildMatchSignals(
      'bill_of_lading',
      { number: 'BL-1', date: '2026-06-03', shipper: { inn: '7728168971' } },
      { number: 0.93, date: 0.8, 'shipper.inn': 0.88, 'buyer.inn': 0.5 },
    );
    expect(s._confidence?.bl_number).toBe(0.93);
    expect(s._confidence?.['dates.document']).toBe(0.8);
    expect(s._confidence?.['parties.shipper']).toBe(0.88);
    // buyer отсутствует в сигналах → не должно быть его confidence
    expect(s._confidence?.['parties.buyer']).toBeUndefined();
  });

  it('читает _field_confidence из extracted если param не передан', () => {
    const s = buildMatchSignals('invoice', {
      total: 100,
      currency: 'RUB',
      _field_confidence: { total: 0.77 },
    });
    expect(s._confidence?.['totals.amount']).toBe(0.77);
  });

  it('нет field-confidence → нет _confidence', () => {
    const s = buildMatchSignals('invoice', { total: 100 });
    expect(s._confidence).toBeUndefined();
  });
});
