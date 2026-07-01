import type { DocumentTypeSlug } from '../../types/documents.js';

export type ClassificationResult = {
  /**
   * Slug of the classified type. Может быть как builtin (`invoice`, `UPD`,
   * ...), так и пользовательский, заведённый админом через UI. `null`,
   * если ничего не распозналось — оркестратор тогда оставляет тип пустым
   * и переводит в needs_review.
   */
  type: DocumentTypeSlug | null;
  confidence: number;
  // Trace which keyword/rule fired — useful for debugging and dataset building.
  source: 'keyword' | 'llm' | 'hint';
  matched?: string;
  /**
   * Сколько правил сматчилось в текст (best wins). Для лога и метрик —
   * помогает понять «классификатор уверенно выбрал из 1» vs «выбрал
   * один из 5 кандидатов».
   */
  candidatesCount?: number;
};

export interface Classifier {
  /**
   * @param organizationId  CP7: scope активного набора типов. <uuid> ⇒
   *   глобальные ∪ типы этой орг; null/undefined ⇒ только глобальные
   *   (см. DocumentTypeResolver.listActiveForOrg). Tenant никогда не видит
   *   кастомные типы другого tenant'а.
   * @param fileName  Имя загруженного файла — weighted-сигнал классификации
   *   (booster / tie-breaker). Тип из имени (`Act_*`, `ТТН_*`, `*MBL.xls`)
   *   усиливает совпавший контент-тип или переворачивает low-confidence/null
   *   кейс, но НЕ бьёт strong контент-матч. См. filename-signal.ts.
   */
  classify(
    text: string,
    organizationId?: string | null,
    fileName?: string | null,
  ): Promise<ClassificationResult>;
}
