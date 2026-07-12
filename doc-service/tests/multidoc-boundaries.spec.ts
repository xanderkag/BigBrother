/**
 * §P0-4 (CLASSIFIER-PACKET-V2): тесты детектора границ документов.
 * Якоря позитив/негатив, мультиязычность, excise-vs-EAD прецеденс,
 * MRN back-reference, invoice continuation.
 */
import { describe, expect, it } from 'vitest';
import { detectDocumentStart, fold } from '../src/pipeline/multidoc/boundaries.js';

describe('fold — unicode-fold', () => {
  it('снимает диакритику и апает регистр', () => {
    expect(fold('Eksporta deklarācija')).toBe('EKSPORTA DEKLARACIJA');
    expect(fold('Engedély')).toBe('ENGEDELY');
    expect(fold('Rēķins')).toBe('REKINS');
    expect(fold('AKCĪZES PRECES')).toBe('AKCIZES PRECES');
  });
});

describe('detectDocumentStart — безусловные якоря (мультиязык)', () => {
  const cases: Array<[string, string, string]> = [
    ['packing_list DE', 'Packliste Nr. 5\nGesamtgewicht 1200 kg', 'packing_list'],
    ['packing_list ES', 'LISTA DE EMBALAJE\nBultos 12', 'packing_list'],
    ['cmr', 'CMR\nМеждународная товарно-транспортная накладная', 'cmr'],
    ['vehicle_registration LT', 'REGISTRACIJOS LIUDIJIMAS\nNr AB123', 'vehicle_registration'],
    ['vehicle_registration TIR', 'CARNET TIR\nCertificate of approval', 'vehicle_registration'],
    ['transport_permit HU', 'Engedély szám 42\nNemzetközi', 'transport_permit'],
    ['delivery_note DE', 'Lieferschein Nr 88\nMenge', 'delivery_note'],
    ['delivery_note LV', 'Pavadzīme Nr 12', 'delivery_note'],
    ['contract_specification', 'Спецификация № 3 к Контракту № 77', 'contract_specification'],
    ['certificate_register', 'Реестр сертификатов соответствия ЕАЭС', 'certificate_register'],
  ];
  for (const [name, text, slug] of cases) {
    it(`${name} → ${slug}`, () => {
      expect(detectDocumentStart(text)?.slug).toBe(slug);
    });
  }
});

describe('detectDocumentStart — excise vs EAD прецеденс', () => {
  it('акцизная страница с EU-текстом → excise_ead, НЕ customs_export_ead', () => {
    const text = 'EUROPEAN COMMUNITY\nАКЦИЗЕ ПРЕЦЕС\nReg. 684/2009\nARC 23LV0000012345678AB';
    expect(detectDocumentStart(text)?.slug).toBe('excise_ead');
  });

  it('паспорт с любым фоном → driver_passport (высший прецеденс)', () => {
    const text = 'EUROPEAN COMMUNITY\nP<BLRAUSIYEVICH<<PIOTR<<<<<<<<<<';
    expect(detectDocumentStart(text)?.slug).toBe('driver_passport');
  });
});

describe('detectDocumentStart — customs_export_ead требует MRN', () => {
  it('EU-заголовок + структурный MRN → customs_export_ead', () => {
    const text = 'AUSFUHRBEGLEITDOKUMENT\nMRN 23HR030228018557B5\nOffice of exit';
    const hit = detectDocumentStart(text);
    expect(hit?.slug).toBe('customs_export_ead');
    expect(hit?.identity.mrn).toBe('23HR030228018557B5');
  });

  it('EU-заголовок БЕЗ MRN → не customs_export_ead', () => {
    const text = 'EUROPEAN COMMUNITY export accompanying reference only';
    expect(detectDocumentStart(text)?.slug).not.toBe('customs_export_ead');
  });

  it('тот же MRN, что у prev → back-reference, null', () => {
    const text = 'AUSFUHRBEGLEITDOKUMENT\nMRN 23HR030228018557B5';
    const prev = { slug: 'customs_export_ead', identity: { mrn: '23HR030228018557B5' } };
    expect(detectDocumentStart(text, prev)).toBeNull();
  });

  it('другой MRN, чем у prev → новая граница', () => {
    const text = 'AUSFUHRBEGLEITDOKUMENT\nMRN 24LV030228099999C7';
    const prev = { slug: 'customs_export_ead', identity: { mrn: '23HR030228018557B5' } };
    expect(detectDocumentStart(text, prev)?.slug).toBe('customs_export_ead');
  });
});

describe('detectDocumentStart — commercial_invoice identity-условный', () => {
  it('инвойс с новым номером → commercial_invoice', () => {
    const hit = detectDocumentStart('INVOICE No INV-200\nUnit price 10', {
      slug: 'commercial_invoice',
      identity: { invoice_no: 'INV-100' },
    });
    expect(hit?.slug).toBe('commercial_invoice');
    expect(hit?.identity.invoice_no).toBe('INV-200');
  });

  it('та же invoice_no, что у prev → continuation, null', () => {
    const prev = { slug: 'commercial_invoice', identity: { invoice_no: 'INV-100' } };
    expect(detectDocumentStart('INVOICE No INV-100\nстр. 2', prev)).toBeNull();
  });

  it('страница инвойса без номера (стр. 2-4) при наличии заголовка → всё равно граница только если header есть', () => {
    // нет ни заголовка, ни номера → продолжение (null)
    expect(detectDocumentStart('Unit price 10\nAmount 120\nTotal 1200')).toBeNull();
  });
});

describe('detectDocumentStart — негатив', () => {
  it('обычная страница без якорей → null', () => {
    expect(detectDocumentStart('Товарная накладная ТОРГ-12\nпозиции ниже')).toBeNull();
  });
});
