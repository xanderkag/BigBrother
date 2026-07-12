/**
 * §P0-2 (CLASSIFIER-PACKET-V2): детектор границ документов в композите.
 *
 * ПРОБЛЕМА (сверено с кодом): per-page keyword-классификатор на иноязычной
 * или фото-странице возвращает null/low-conf, splitter приклеивает её к
 * предыдущему сегменту → N разнотипных страниц сливаются в 1 → пакет
 * классифицируется одним типом. Главный провал корпуса БКТ (~35/51).
 *
 * РЕШЕНИЕ: `detectDocumentStart(text, prev)` по первым ~500 символам ищет
 * ЗАГОЛОВОЧНЫЕ якоря, ПЕРЕЗАПИСЫВАЮЩИЕ тип сегмента (не полагается на
 * null-класс классификатора). Возвращает slug + identity страницы.
 *
 * Два класса сигналов:
 *   (а) безусловные якоря — открывают сегмент всегда;
 *   (б) identity-условные (commercial_invoice) — только если invoice_no
 *       сменился (иначе стр. 2-4 инвойса открывали бы ложный сегмент).
 *
 * Прецеденс: самое специфичное первым. excise_ead / driver_passport
 * проверяются ДО generic EAD-заголовков (акцизная и паспортная страницы
 * содержат EU-текст, матчащий customs_export_ead).
 *
 * Мультиязычность: `fold()` снимает диакритику (ā/ē/š/ī/ő/ç) и приводит к
 * верхнему регистру — якоря и текст фолдятся одинаково, поэтому LV/DE/ES/
 * FR/LT-заголовки матчатся ASCII-паттерном. Кириллический `\b` в JS-regex
 * не работает — кириллические якоря даны подстрокой (без `\b`).
 */
import type { DocumentTypeSlug } from '../../types/documents.js';
import type { DocIdentity } from './types.js';

export interface BoundaryHit {
  slug: DocumentTypeSlug;
  identity: DocIdentity;
}

/** «Первые ~500 символов» + небольшой запас на шапку. */
const HEAD_CHARS = 600;

/**
 * Unicode-fold: NFKD-декомпозиция + снятие диакритики + upper-case.
 * `AKCĪZES`→`AKCIZES`, `Engedély`→`ENGEDELY`, `Rēķins`→`REKINS`.
 * ВАЖНО: фолдим И текст, И якоря — тогда сравнение согласовано (в т.ч.
 * для кириллицы, где NFKD раскладывает й→и+breve и т.п.).
 */
export function fold(s: string): string {
  // ̀-ͯ — комбинирующие диакритические знаки (после NFKD-разложения).
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

/**
 * Безусловные якоря в порядке ПРЕЦЕДЕНСА (специфичное — первым).
 * Needle'ы даны в fold-форме (upper-case, без диакритики).
 */
const UNCONDITIONAL: ReadonlyArray<{ slug: string; needles: RegExp[] }> = [
  // паспорт — до всего: MRZ-строка + слова-удостоверения (мультиязычно)
  {
    slug: 'driver_passport',
    needles: [/P<[A-Z]{3}/, /\bPASSPORT\b/, /ПАШПАРТ/, /РЭСПУБЛ[IІ]?КА/, /IDENTITY CARD/],
  },
  // акциз — до generic EAD (акцизная страница несёт EU-текст EAD)
  {
    slug: 'excise_ead',
    needles: [/АКЦИЗЕ ПРЕЦЕС/, /AKCIZES PRECES/, /684\/2009/, /EXCISE MOVEMENT/],
  },
  // экспортная декларация ЕС — ТОЛЬКО со структурным MRN (проверяется ниже)
  {
    slug: 'customs_export_ead',
    needles: [
      /AUSFUHRBEGLEITDOKUMENT/,
      /EKSPORTA DEKLARACIJA/,
      /EXPORT ACCOMPANYING/,
      /EUROPAISCHE GEMEINSCHAFT/,
      /EUROPEAN COMMUNITY/,
    ],
  },
  {
    slug: 'packing_list',
    needles: [/PACKING LIST/, /УПАКОВОЧНЫЙ ЛИСТ/, /PACKLISTE/, /LISTA DE EMBALAJE/],
  },
  {
    slug: 'cmr',
    needles: [/\bCMR\b/, /МЕЖДУНАРОДНАЯ.{0,25}НАКЛАДНАЯ/, /FRACHTBRIEF/, /TOVARNI LIST/],
  },
  {
    slug: 'vehicle_registration',
    needles: [
      /REGISTRACIJOS LIUDIJIMAS/,
      /ТЕХНИЧЕСКИЙ ТАЛОН/,
      /TRANSPORDIAMET/,
      /CERTIFICAT D'IMMATRICULATION/,
      /\bTIR\b/,
      /CARNET TIR/,
      /СЕРТИФИКАТ ОДОБРЕНИЯ/,
      /CERTIFICATE OF APPROVAL/,
    ],
  },
  {
    slug: 'transport_permit',
    needles: [/ENGEDELY/, /РАЗОВОЕ РАЗРЕШЕНИ/, /SPECIAL SINGLE-TRIP/, /SINGLE TRIP PERMIT/],
  },
  {
    slug: 'contract_specification',
    needles: [
      /СПЕЦИФИКАЦИЯ.{0,25}КОНТРАКТ/,
      /SPECIFICATION.{0,25}CONTRACT/,
      /SPEZIFIKATION/,
      /ESPECIFICACION/,
    ],
  },
  {
    slug: 'certificate_register',
    needles: [
      /РЕЕСТР.{0,25}СЕРТИФИКАТ/,
      /ANNEX TO INVOICE/,
      /СЕРТИФИКАТ СООТВЕТСТВИЯ ЕАЭС/,
      /ПЕРЕЧЕНЬ СЕРТИФИКАТОВ/,
    ],
  },
  {
    slug: 'delivery_note',
    needles: [
      /DELIVERY NOTE/,
      /РАСХОДНАЯ НАКЛАДНАЯ/,
      /LIEFERSCHEIN/,
      /PAVADZIME/,
      /ОТГРУЗОЧНАЯ НАКЛАДНАЯ/,
    ],
  },
];

/** identity-условный якорь: инвойс. Открывает сегмент, только если invoice_no сменился. */
const INVOICE_HEADER: RegExp[] = [
  /\bINVOICE\b/,
  /\bFACTURA\b/,
  /\bRECHNUNG\b/,
  /\bFACTURE\b/,
  /\bREKINS\b/,
  /ИНВОЙС/,
  /КОММЕРЧЕСКИЙ СЧЕТ/,
  /СЧЕТ-ФАКТУРА/,
];

/** Извлечь identity из fold-текста шапки. */
function extractIdentity(folded: string): DocIdentity {
  const id: DocIdentity = {};

  // MRN: литерал MRN рядом (±40 симв.) + структура (2 цифры года + 2 буквы
  // страны + 13-17 буквоцифр). Строгость против false-positive на ref/контейнерах.
  const mrn = folded.match(/\bMRN\b[^A-Z0-9]{0,40}(\d{2}[A-Z]{2}[A-Z0-9]{13,17})/);
  if (mrn) id.mrn = mrn[1];

  // ARC: литерал ARC + акцизный код (21 симв.: 2 цифры + 2 буквы + 17).
  const arc = folded.match(/\bARC\b[^A-Z0-9]{0,20}(\d{2}[A-Z]{2}[A-Z0-9]{15,19})/);
  if (arc) id.arc = arc[1];

  // Номер инвойса после заголовка.
  const inv = folded.match(
    /(?:INVOICE\s*(?:NO|NUMBER|#)|FACTURA|REKINS|RECHNUNG(?:\s*NR)?|FACTURE|СЧЕТ[- ]?ФАКТУРА\s*№?)[^A-Z0-9]{0,8}([A-Z0-9][A-Z0-9/._-]{1,20})/,
  );
  if (inv) id.invoice_no = inv[1];

  return id;
}

/**
 * Определить, открывает ли страница новый документ. Возвращает slug +
 * identity, либо null (страница — продолжение предыдущего сегмента).
 *
 * @param text  raw OCR-текст страницы.
 * @param prev  сегмент/страница слева: slug + его identity (для back-ref и
 *              continuation-rule). Может отсутствовать (первая страница).
 */
export function detectDocumentStart(
  text: string,
  prev?: { slug: DocumentTypeSlug | null; identity?: DocIdentity } | null,
): BoundaryHit | null {
  const folded = fold(text.slice(0, HEAD_CHARS));
  const identity = extractIdentity(folded);

  // 1. Безусловные якоря по прецеденсу.
  for (const { slug, needles } of UNCONDITIONAL) {
    if (!needles.some((re) => re.test(folded))) continue;

    if (slug === 'customs_export_ead') {
      // EU-заголовок без структурного MRN — слабый сигнал, пропускаем
      // (пусть решают якоря ниже или классификатор).
      if (!identity.mrn) continue;
      // Тот же MRN, что у предыдущего сегмента, — это back-reference /
      // продолжение той же декларации, НЕ новая граница.
      if (prev?.identity?.mrn && prev.identity.mrn === identity.mrn) return null;
    }

    return { slug: slug as DocumentTypeSlug, identity };
  }

  // 2. Identity-условный якорь: commercial_invoice.
  if (INVOICE_HEADER.some((re) => re.test(folded))) {
    const prevInv = prev?.identity?.invoice_no;
    // Тот же invoice_no → многостраничный инвойс продолжается, НЕ граница.
    if (identity.invoice_no && prevInv && identity.invoice_no === prevInv) return null;
    return { slug: 'commercial_invoice' as DocumentTypeSlug, identity };
  }

  // 3. Голый ARC (без excise-заголовка) — back-reference на инвойсе, не граница.
  return null;
}
