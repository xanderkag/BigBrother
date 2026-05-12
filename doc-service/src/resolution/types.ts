/**
 * Resolution Engine — публичные типы и конфигурационные схемы.
 *
 * ## Концепция
 *
 * После извлечения данных из документа Resolution Engine «привязывает» его к
 * бизнес-объектам из организационных справочников (reference_list_entries).
 *
 * Два механизма:
 *   - **EntityLink** — job целиком → запись справочника.
 *     Пример: ТТН → cargo_unit, счёт → контрагент.
 *   - **ItemMatch** — каждая строка `extracted.items[]` → запись номенклатуры.
 *     Поиск: сначала по code (exact), потом по name (exact lowercased).
 *
 * ## Конфигурация (document_types.resolution_config JSONB)
 *
 * ```json
 * {
 *   "entity_links": [
 *     {
 *       "list_type": "cargo_units",
 *       "match_fields": ["cargo_id", "cargo_number"],
 *       "on_not_found": "needs_review"
 *     }
 *   ],
 *   "item_matching": {
 *     "list_type": "nomenclature",
 *     "items_field": "items",
 *     "code_field": "code",
 *     "name_field": "name",
 *     "on_not_found": "warn"
 *   }
 * }
 * ```
 *
 * ## on_not_found поведение
 *   - `"needs_review"` (default для entity_links) — job переводится в needs_review,
 *     в extracted._issues добавляется описание проблемы.
 *   - `"warn"` (default для item_matching) — только лог, job не трогается.
 *   - `"ignore"` — молча пропускаем.
 *
 * ## Жизненный цикл результата
 *   `suggested` → `confirmed` (оператор одобрил, опционально с другим entry_id)
 *              → `rejected`  (оператор отклонил)
 *   `not_found` → `confirmed` (оператор вручную указал запись)
 *              → `rejected`
 */

// ---------------------------------------------------------------------------
// Конфигурация (из document_types.resolution_config)
// ---------------------------------------------------------------------------

/** Что делать когда сущность не найдена в справочнике. */
export type OnNotFound = 'needs_review' | 'warn' | 'ignore';

/** Конфиг одной ссылки на справочник (entity link). */
export type EntityLinkConfig = {
  /** Slug типа справочника ('cargo_units', 'contracts', …). */
  list_type: string;
  /** Поля из extracted, значения которых используются для поиска. */
  match_fields: string[];
  /** Поведение при ненахождении. Default: 'needs_review'. */
  on_not_found?: OnNotFound;
};

/** Конфиг матчинга строк документа с номенклатурой. */
export type ItemMatchingConfig = {
  /** Slug типа справочника для номенклатуры ('nomenclature'). */
  list_type: string;
  /** Путь в extracted к массиву строк ('items'). */
  items_field: string;
  /** Поле строки для текстового названия. Default: 'name'. */
  name_field?: string;
  /** Поле строки для кода/артикула. Default: 'code'. */
  code_field?: string;
  /** Порог fuzzy-матча (0…1). Default: 0.75. */
  fuzzy_threshold?: number;
  /** Поведение при ненахождении. Default: 'warn'. */
  on_not_found?: OnNotFound;
};

/** Полный конфиг резолюции из document_types.resolution_config. */
export type ResolutionConfig = {
  entity_links?: EntityLinkConfig[];
  item_matching?: ItemMatchingConfig;
};

// ---------------------------------------------------------------------------
// DB-строки (raw из Postgres)
// ---------------------------------------------------------------------------

export type ReferenceListTypeRow = {
  slug: string;
  organization_id: string;
  label: string;
  search_hint: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ReferenceListEntryRow = {
  id: string;
  list_type_slug: string;
  organization_id: string;
  external_id: string | null;
  display_name: string;
  search_keys: string[];
  data: Record<string, unknown>;
  is_active: boolean;
  synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type JobEntityLinkRow = {
  id: string;
  job_id: string;
  organization_id: string;
  list_type_slug: string;
  entry_id: string | null;
  match_score: string | null;       // NUMERIC → string
  match_method: string | null;
  match_field: string | null;
  match_value: string | null;
  status: 'suggested' | 'confirmed' | 'rejected' | 'not_found';
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
};

export type JobItemMatchRow = {
  id: string;
  job_id: string;
  organization_id: string;
  list_type_slug: string;
  item_index: number;
  item_raw: Record<string, unknown>;
  entry_id: string | null;
  match_score: string | null;
  match_method: string | null;
  status: 'suggested' | 'confirmed' | 'rejected' | 'not_found';
  issues: string[];
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// API-формы (то, что возвращаем клиенту)
// ---------------------------------------------------------------------------

export type ReferenceListTypeApi = {
  slug: string;
  organization_id: string;
  label: string;
  search_hint: string | null;
  created_at: string;
};

export type ReferenceListEntryApi = {
  id: string;
  list_type_slug: string;
  organization_id: string;
  external_id: string | null;
  display_name: string;
  search_keys: string[];
  data: Record<string, unknown>;
  is_active: boolean;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EntityLinkApi = {
  id: string;
  job_id: string;
  list_type_slug: string;
  entry_id: string | null;
  entry?: ReferenceListEntryApi | null;   // join, если запрошено
  match_score: number | null;
  match_method: string | null;
  match_field: string | null;
  match_value: string | null;
  status: 'suggested' | 'confirmed' | 'rejected' | 'not_found';
  confirmed_at: string | null;
  created_at: string;
};

export type ItemMatchApi = {
  id: string;
  job_id: string;
  list_type_slug: string;
  item_index: number;
  item_raw: Record<string, unknown>;
  entry_id: string | null;
  entry?: ReferenceListEntryApi | null;
  match_score: number | null;
  match_method: string | null;
  status: 'suggested' | 'confirmed' | 'rejected' | 'not_found';
  issues: string[];
  confirmed_at: string | null;
  created_at: string;
};

export type ResolutionResultApi = {
  entity_links: EntityLinkApi[];
  item_matches: ItemMatchApi[];
  summary: {
    links_total: number;
    links_confirmed: number;
    links_not_found: number;
    items_total: number;
    items_matched: number;
    items_not_found: number;
  };
};

// ---------------------------------------------------------------------------
// Вспомогательные типы для репо/пайплайна
// ---------------------------------------------------------------------------

export type EntryCreateInput = {
  external_id?: string | null;
  display_name: string;
  search_keys: string[];
  data?: Record<string, unknown>;
};

export type SyncEntry = EntryCreateInput & {
  /** Если external_id уже есть — обновляем, иначе создаём. */
  external_id: string;
};
