import type { DocumentTypeSlug } from '../../types/documents.js';
import { config } from '../../config.js';

/**
 * Filename signal (2026-07-01). Реальный кейс: имя файла буквально содержит
 * тип документа (`Act_260127-051.pdf`, `ТТН_28.01.2026.pdf`, `988726MBL.xls`),
 * но контент-классификатор скорит только keyword'ы в тексте и промахивается
 * (акт → customs_declaration, ТТН → invoice, коносамент → без типа).
 *
 * Решение: имя файла — это **weighted booster / tie-breaker**, НЕ override.
 * Маркеры матчатся case-insensitively по file_name. Сигнал:
 *   - усиливает уверенность, если совпал с контент-победителем;
 *   - переворачивает LOW-confidence / null / ambiguous случай на тип из имени;
 *   - НЕ бьёт STRONG контент-матч (title-boosted, confidence ≥ порога).
 *
 * Generic-имена (`Скан_документа`, `финал`, `Драфт`, `PWR`) НЕ дают маркер —
 * не форсируют тип. Порядок правил важен: специфичные раньше общих
 * (VAT invoice раньше invoice; weighing раньше act; PI/proforma раньше invoice).
 */

/**
 * Вес filename-сигнала во ВНУТРЕННЕМ weight-пространстве классификатора
 * (не в [0,1] — там веса типов доходят до 5-8, а title-boost ×1.5). Подобран
 * так, чтобы имя:
 *   - переворачивало кейсы, где верный тип без контент-поддержки (ТТН — OCR
 *     не поймал «накладную») или где ССЫЛАЕМЫЙ тип ложно перебивает (invoice
 *     вес 5) → 5.5 > 5.0;
 *   - НЕ било title-boosted strong контент-матч (contract_specification
 *     «Приложение к Договору» = 5.0 ×1.5 = 7.5 > 5.5) — защита `Заявка_*.pdf`
 *     от ложного флипа.
 *
 * Значение (как и FILENAME_AGREE_BOOST) вынесено в config.classifier —
 * env-tunable (FILENAME_SIGNAL_WEIGHT). Дефолт 5.5 = прежний хардкод.
 */
export const FILENAME_SIGNAL_WEIGHT = config.classifier.filenameSignalWeight;

/** Аддитивный boost, когда имя подтверждает тип с контент-поддержкой. */
export const FILENAME_AGREE_BOOST = config.classifier.filenameAgreeBoost;

type Marker = { pattern: RegExp; slug: DocumentTypeSlug };

/**
 * Маркеры имени → slug. ПОРЯДОК ЗНАЧИМ: первое совпадение выигрывает,
 * поэтому специфичные паттерны идут раньше общих (VAT invoice < invoice,
 * weighing < act, proforma < invoice, commercial invoice < invoice).
 *
 * Слаги сверены с prod document_types (2026-07-01). Нет маркера для `PWR`
 * (легитимно неоднозначен — cert_of_origin & price_list).
 */
const MARKERS: Marker[] = [
  // Bill of lading — коносамент + house/master B/L телекс-варианты.
  { pattern: /(?:коносамент|(?<![a-z])(?:m|h|a|b|c)?bl(?![a-z])|hbtelex)/i, slug: 'bill_of_lading' },
  // Customs declaration (ГТД / декларация на товары).
  { pattern: /(?:gtd|гтд|декларация\s+на\s+товары)/i, slug: 'customs_declaration' },
  // VAT invoice → счёт-фактура (factInvoice). Раньше generic invoice.
  { pattern: /vat.?invoice/i, slug: 'factInvoice' },
  // Weighing act → weighing_act. Раньше generic act.
  { pattern: /(?:акт.?взвешив|взвешив|weighing)/i, slug: 'weighing_act' },
  // Proforma invoice. Раньше generic invoice.
  { pattern: /(?:pi-|pi20|pfa|proforma|проформа)/i, slug: 'proforma_invoice' },
  // Commercial invoice. Раньше generic invoice.
  { pattern: /commercial.?invoice/i, slug: 'commercial_invoice' },
  // Packing list.
  { pattern: /packing.?list/i, slug: 'packing_list' },
  // ТТН.
  { pattern: /ттн/i, slug: 'TTN' },
  // AWB (air waybill).
  { pattern: /(?<![a-z])awb(?![a-z])/i, slug: 'awb' },
  // Standalone Act_ / Акт (НЕ взвешивания — тот выше) → акт-услуг (AKT).
  { pattern: /(?:(?<![a-z])act[_\- ]|(?<![a-я])акт(?![а-я]))/i, slug: 'AKT' },
  // Generic invoice / счёт (после VAT/PI/commercial).
  { pattern: /(?:(?<![a-z])invoice(?![a-z])|сч[её]т)/i, slug: 'invoice' },
  // ЕАЭС / conformity → сертификат соответствия ЕАЭС.
  { pattern: /(?:еаэс|conformity)/i, slug: 'eac_conformity_certificate' },
  // Контракт / Contract.
  { pattern: /(?:контракт|contract)/i, slug: 'contract' },
  // Заявка (на перевозку / ТЭУ) → transport_request.
  { pattern: /заявка/i, slug: 'transport_request' },
];

/**
 * Вернуть slug-маркер из имени файла (или null). Матчится по basename без
 * расширения — расширение не должно давать ложных срабатываний.
 */
export function markerFromFileName(fileName: string | null | undefined): DocumentTypeSlug | null {
  if (!fileName) return null;
  // basename без директорий и без расширения.
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  for (const m of MARKERS) {
    if (m.pattern.test(stem)) return m.slug;
  }
  return null;
}
