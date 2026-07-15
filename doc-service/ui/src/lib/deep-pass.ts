/**
 * DEEP-PASS (docs/DEEP-PASS-SPEC.md): чтение следа второго яруса из
 * extracted._deep + словари человекочитаемых меток. Общее для JobsList
 * (бейдж + разворот строки) и JobDetail (карточка «Глубокий разбор»).
 */

export type DeepPassVerdict = 'mapped' | 'foreign_document' | 'not_a_document';

export interface DeepPassData {
  broad_type: string;
  broad_label: string;
  language: string | null;
  summary: string;
  catalog_slug: string | null;
  verdict: DeepPassVerdict;
  via: 'text' | 'vision';
  reason: 'classify_unknown' | 'ocr_refused';
}

/** Достать и провалидировать _deep из extracted. null = следа нет/битый. */
export function getDeepPass(extracted: unknown): DeepPassData | null {
  if (!extracted || typeof extracted !== 'object') return null;
  const d = (extracted as Record<string, unknown>)._deep;
  if (!d || typeof d !== 'object') return null;
  const r = d as Record<string, unknown>;
  if (typeof r.broad_label !== 'string' || r.broad_label.length === 0) return null;
  const verdict: DeepPassVerdict =
    r.verdict === 'mapped' || r.verdict === 'not_a_document' ? r.verdict : 'foreign_document';
  return {
    broad_type: typeof r.broad_type === 'string' ? r.broad_type : 'other',
    broad_label: r.broad_label,
    language: typeof r.language === 'string' && r.language ? r.language : null,
    summary: typeof r.summary === 'string' ? r.summary : '',
    catalog_slug: typeof r.catalog_slug === 'string' && r.catalog_slug ? r.catalog_slug : null,
    verdict,
    via: r.via === 'vision' ? 'vision' : 'text',
    reason: r.reason === 'ocr_refused' ? 'ocr_refused' : 'classify_unknown',
  };
}

export const DEEP_VERDICT_META: Record<
  DeepPassVerdict,
  { label: string; tone: 'emerald' | 'amber' | 'slate' }
> = {
  mapped: { label: 'возвращён в конвейер', tone: 'emerald' },
  foreign_document: { label: 'вне рабочего каталога', tone: 'amber' },
  not_a_document: { label: 'не документ', tone: 'slate' },
};

export const DEEP_VIA_LABELS: Record<DeepPassData['via'], string> = {
  text: 'по тексту',
  vision: 'по изображению (VL)',
};

export const DEEP_REASON_LABELS: Record<DeepPassData['reason'], string> = {
  classify_unknown: 'тип не опознан классификатором',
  ocr_refused: 'OCR не смог прочитать скан (отказ модели)',
};
