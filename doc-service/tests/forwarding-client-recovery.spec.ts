/**
 * F0d: восстановление заказчика (client) поручения экспедитору из raw-текста.
 * Кейсы — с реальных поручений (2026-07-17): проза «(далее — Клиент)» и метка
 * «Клиент:» перед компанией; совпадение роли с грузополучателем.
 */
import { describe, it, expect } from 'vitest';
import { recoverForwardingClientFromText } from '../src/pipeline/normalize/forwarding-client-recovery.js';

const FWD = 'forwarding_order';

describe('recoverForwardingClientFromText', () => {
  it('проза «(далее — Клиент)» → берёт клиента, НЕ экспедитора', () => {
    const raw =
      'ООО «КРАФТТРАНС Атлас» (далее — Экспедитор) и ООО «Ист-Вест Лоджистик» (далее — Клиент), учитывая характер услуг';
    const out = recoverForwardingClientFromText({ expeditor: { name: 'ООО «КРАФТТРАНС Атлас»' } }, raw, FWD)!;
    expect((out.client as { name: string }).name).toBe('ООО «Ист-Вест Лоджистик»');
    expect(out._client_recovered).toBe('ООО «Ист-Вест Лоджистик»');
  });

  it('метка «Клиент:» перед компанией (нумерованное поле)', () => {
    const raw = '3. Грузоотправитель\nJIAXING CO\n4. Клиент\nООО "МЛР"\n5. Грузополучатель\nOOO MLR';
    const out = recoverForwardingClientFromText({}, raw, FWD)!;
    expect((out.client as { name: string }).name).toBe('ООО "МЛР"');
  });

  it('«Заказчик: ООО …» тоже ловит', () => {
    const out = recoverForwardingClientFromText({}, 'Заказчик: ООО ТрансСервис', FWD)!;
    expect((out.client as { name: string }).name).toBe('ООО ТрансСервис');
  });

  it('роли совпадают: клиент = грузополучатель → всё равно заполняем client', () => {
    const raw = '4. Клиент: ООО «МЛР»\n5. Грузополучатель: ООО «МЛР»';
    const out = recoverForwardingClientFromText({ consignee: { name: 'ООО «МЛР»' } }, raw, FWD)!;
    expect((out.client as { name: string }).name).toBe('ООО «МЛР»');
  });

  it('НЕ forwarding_order → no-op', () => {
    const raw = 'Клиент: ООО МЛР';
    expect(recoverForwardingClientFromText({}, raw, 'invoice')).toEqual({});
  });

  it('client уже заполнен → идемпотентно, не трогаем', () => {
    const ex = { client: { name: 'ООО «Уже Есть»' } };
    expect(recoverForwardingClientFromText(ex, 'Клиент: ООО «Другой»', FWD)).toBe(ex);
  });

  it('нет метки клиента в тексте → no-op', () => {
    const ex = { consignee: { name: 'ООО МЛР' } };
    expect(recoverForwardingClientFromText(ex, 'Грузополучатель: ООО МЛР', FWD)).toBe(ex);
  });

  it('boilerplate «с Клиентом» без компании рядом → не выдумывает', () => {
    const ex = { expeditor: { name: 'ООО ТЭК' } };
    const raw = 'договор транспортной экспедиции, заключённый с Клиентом на условиях приложения';
    expect(recoverForwardingClientFromText(ex, raw, FWD)).toBe(ex);
  });

  it('пустой/битый вход → возвращает как есть', () => {
    expect(recoverForwardingClientFromText(null, 'Клиент: ООО X', FWD)).toBeNull();
    expect(recoverForwardingClientFromText({}, '', FWD)).toEqual({});
  });
});
