/**
 * ListJobsQuery — новые фильтры шапки журнала: document_types (comma, OR)
 * и format (enum). Back-compat одиночного document_type не трогаем.
 */
import { describe, it, expect } from 'vitest';
import { ListJobsQuery } from '../src/types/api-schemas.js';
import { expandSlugForms } from '../src/types/slug-normalize.js';

describe('ListJobsQuery.document_types', () => {
  it('парсит comma-separated в массив слагов', () => {
    const q = ListJobsQuery.parse({ document_types: 'invoice,factInvoice,UPD' });
    expect(q.document_types).toEqual(['invoice', 'factInvoice', 'UPD']);
  });

  it('трим и пустые токены отбрасываются', () => {
    const q = ListJobsQuery.parse({ document_types: ' invoice , ,bill_of_lading ' });
    expect(q.document_types).toEqual(['invoice', 'bill_of_lading']);
  });

  it('невалидный slug в списке → reject', () => {
    expect(() => ListJobsQuery.parse({ document_types: 'invoice,тип' })).toThrow();
    expect(() => ListJobsQuery.parse({ document_types: 'invoice,a b' })).toThrow();
  });

  it('не задан → undefined; одиночный document_type работает как раньше', () => {
    const q = ListJobsQuery.parse({ document_type: 'invoice' });
    expect(q.document_types).toBeUndefined();
    expect(q.document_type).toBe('invoice');
  });
});

describe('expandSlugForms — фильтр по типу ловит обе формы слага', () => {
  // В jobs.document_type живут ОБЕ формы: keyword-классификатор пишет
  // исторические ('CMR'), document_hint сохраняется в outbound ('cmr').
  it('алиасные builtin расширяются в пару (обе стороны)', () => {
    expect(expandSlugForms('CMR')).toEqual(['CMR', 'cmr']);
    expect(expandSlugForms('cmr')).toEqual(['cmr', 'CMR']);
    expect(expandSlugForms('factInvoice')).toEqual(['factInvoice', 'tax_invoice']);
    expect(expandSlugForms('tax_invoice')).toEqual(['tax_invoice', 'factInvoice']);
    expect(expandSlugForms('UPD')).toEqual(['UPD', 'upd']);
  });

  it('не-алиасные слаги остаются одиночными', () => {
    expect(expandSlugForms('invoice')).toEqual(['invoice']);
    expect(expandSlugForms('bill_of_lading')).toEqual(['bill_of_lading']);
    expect(expandSlugForms('commercial_invoice')).toEqual(['commercial_invoice']);
  });
});

describe('ListJobsQuery.format', () => {
  it('принимает каждый из шести форматов (как массив из одного)', () => {
    for (const f of ['pdf', 'excel', 'word', 'image', 'xml', 'other']) {
      expect(ListJobsQuery.parse({ format: f }).format).toEqual([f]);
    }
  });

  it('несколько форматов через запятую (пресет «Excel и Word»)', () => {
    expect(ListJobsQuery.parse({ format: 'excel,word' }).format).toEqual(['excel', 'word']);
  });

  it('неизвестный формат → reject', () => {
    expect(() => ListJobsQuery.parse({ format: 'docx' })).toThrow();
    expect(() => ListJobsQuery.parse({ format: 'excel,zip' })).toThrow();
  });
});
