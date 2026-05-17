/**
 * F22: case-insensitive slug lookup + SLAI alias map для
 * DocumentTypeResolver. SLAI ТЗ v1 использует другой нейминг.
 */
import { describe, expect, it, vi } from 'vitest';
import { DocumentTypeResolver } from '../src/pipeline/document-type-resolver.js';
import { documentTypesRepo } from '../src/storage/document-types.js';

function mockRepo(known: Record<string, unknown>) {
  return vi.spyOn(documentTypesRepo, 'findBySlug').mockImplementation(async (slug: string) => {
    return (known[slug] as never) ?? null;
  });
}

describe('DocumentTypeResolver.get — F22 slug aliases', () => {
  it('находит row по точному slug (без алиасов)', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ invoice: { slug: 'invoice', display_name: 'Счёт' } });

    const row = await resolver.get('invoice');
    expect((row as any)?.slug).toBe('invoice');
    spy.mockRestore();
  });

  it('SLAI lowercase "upd" → находит row "UPD"', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ UPD: { slug: 'UPD', display_name: 'УПД' } });

    const row = await resolver.get('upd');
    expect((row as any)?.slug).toBe('UPD');
    spy.mockRestore();
  });

  it('SLAI alias "services_act" → находит row "AKT"', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ AKT: { slug: 'AKT', display_name: 'Акт работ' } });

    const row = await resolver.get('services_act');
    expect((row as any)?.slug).toBe('AKT');
    spy.mockRestore();
  });

  it('SLAI alias "tax_invoice" → находит row "factInvoice"', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ factInvoice: { slug: 'factInvoice', display_name: 'Счёт-фактура' } });

    const row = await resolver.get('tax_invoice');
    expect((row as any)?.slug).toBe('factInvoice');
    spy.mockRestore();
  });

  it('SLAI lowercase "ttn"/"cmr" → находят uppercase варианты', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({
      TTN: { slug: 'TTN', display_name: 'ТТН' },
      CMR: { slug: 'CMR', display_name: 'CMR' },
    });

    expect(((await resolver.get('ttn')) as any)?.slug).toBe('TTN');
    expect(((await resolver.get('cmr')) as any)?.slug).toBe('CMR');
    spy.mockRestore();
  });

  it('uppercase "UPD" → находит row "UPD" (наш default путь)', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ UPD: { slug: 'UPD', display_name: 'УПД' } });

    const row = await resolver.get('UPD');
    expect((row as any)?.slug).toBe('UPD');
    spy.mockRestore();
  });

  it('неизвестный slug → null', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ invoice: { slug: 'invoice' } });

    const row = await resolver.get('foo_bar_baz');
    expect(row).toBeNull();
    spy.mockRestore();
  });

  it('кэширует результат — повторный get() не дёргает БД', async () => {
    const resolver = new DocumentTypeResolver();
    const spy = mockRepo({ UPD: { slug: 'UPD', display_name: 'УПД' } });

    await resolver.get('upd');
    await resolver.get('upd');
    await resolver.get('upd');
    // Точное число вызовов зависит от того сколько candidates'ов resolver
    // попробовал ДО первого найденного: 'upd' → null, 'UPD' → row, кэш.
    // Второй и третий запрос — оба cache hits. Точно: 2 вызова (для 'upd' и 'UPD'),
    // не 6 (если кэш не работает).
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });
});
