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
  /**
   * Ранжированная score-map: ВСЕ сматчившиеся типы, отсортированы по убыванию
   * (тот же порядок, что и выбор победителя — вес, при равенстве длиннее match).
   * `ranked[0]` — это победитель (`type`), остальные — runners-up. `score` —
   * тот же outbound-clamp [0,1] что и `confidence`. Пусто/undefined когда
   * ничего не сматчилось. Additive-поле: caller (LlmDocClassifier) использует
   * его для обогащённого `candidates[]`; downstream, читающий только `type`,
   * не затронут.
   */
  ranked?: Array<{ type: DocumentTypeSlug; score: number }>;
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
