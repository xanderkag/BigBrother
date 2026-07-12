/**
 * §8.3 (CLASSIFIER-PACKET-V2, ПДн-блокер): жёсткий allowlist-пост-фильтр
 * для документов-удостоверений личности (паспорт водителя и пр.).
 *
 * ЗАЧЕМ детерминированный фильтр, а не только схема/промпт: одна
 * `llm_schema` / `expected_fields` НЕ гарантирует, что LLM не вернёт поля
 * сверх схемы — модель регулярно отдаёт лишнее (ФИО, номер паспорта, MRZ,
 * дату рождения). Поэтому для ID-документов в коде doc-service оставляем
 * ТОЛЬКО {doc_kind, country, present} и выбрасываем всё остальное. Никакие
 * персональные поля дальше по конвейеру (match_signals, БД, webhook,
 * requality) не попадают.
 *
 * Триггер — ЛИБО тип классифицирован как ID-слаг, ЛИБО сама модель
 * пометила `doc_kind:"id"`. Применяется и к основному, и к сегментному
 * extract (см. normalize/run.ts, вызывается ПЕРВЫМ шагом).
 */

/** Слаги документов-удостоверений (совпадает с миграцией ВЭД-пакета). */
export const ID_DOC_SLUGS: ReadonlySet<string> = new Set([
  'driver_passport',
  'id_document',
  'passport',
]);

/** Единственные поля, разрешённые к выдаче для ID-документа. */
const ID_ALLOWED_KEYS: ReadonlySet<string> = new Set(['doc_kind', 'country', 'present']);

/** Является ли документ удостоверением личности (по типу или по doc_kind). */
export function isIdDocument(
  documentType: string | null | undefined,
  extracted: Record<string, unknown> | null,
): boolean {
  if (documentType && ID_DOC_SLUGS.has(documentType)) return true;
  if (
    extracted &&
    typeof extracted === 'object' &&
    (extracted as Record<string, unknown>).doc_kind === 'id'
  ) {
    return true;
  }
  return false;
}

/**
 * Для ID-документа оставить только allowlist-поля. Для прочих — вернуть
 * `extracted` без изменений (тождественно). Не мутирует вход.
 */
export function applyIdAllowlist(
  extracted: Record<string, unknown> | null,
  documentType?: string | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (!isIdDocument(documentType, extracted)) return extracted;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(extracted)) {
    if (ID_ALLOWED_KEYS.has(key)) out[key] = extracted[key];
  }
  // Гарантируем маркеры вида даже если модель их не вернула — потребителю
  // важен факт «это удостоверение и оно есть», без персональных полей.
  if (!('doc_kind' in out)) out.doc_kind = 'id';
  if (!('present' in out)) out.present = true;
  return out;
}
