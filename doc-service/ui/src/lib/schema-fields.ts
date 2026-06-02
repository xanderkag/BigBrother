/**
 * F2 — разбор JSON Schema типа документа в плоское описание полей для
 * schema-driven редактора, плюс утилиты get/set по dotted-path.
 *
 * Источник схемы — `GET /document-types/:slug/schema` (эффективная схема:
 * admin-override из БД ?? встроенный fallback). Если схемы нет (незнакомый
 * тип) — поля выводятся из фактически распознанного `extracted`
 * (`fieldsFromValue`), решение владельца §10.4.
 *
 * Виджет ввода выбирается по `kind`:
 *   string / date  → text / date input
 *   number/integer → number input
 *   boolean        → чекбокс
 *   object         → вложенная группа полей (children)
 *   array-objects  → редактируемая таблица позиций (itemFields)
 *   array-strings  → textarea (по строке на элемент)
 */

export type FieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'object'
  | 'array-objects'
  | 'array-strings'
  | 'unknown';

export interface FieldSpec {
  /** Локальный ключ внутри родителя. */
  key: string;
  /** Подпись для UI (словарь RU ?? humanize(key)). */
  label: string;
  kind: FieldKind;
  /** Полное описание из схемы — как подсказка (title). */
  description?: string;
  /** Для kind='object' — вложенные поля. */
  children?: FieldSpec[];
  /** Для kind='array-objects' — поля одного элемента. */
  itemFields?: FieldSpec[];
}

type SchemaNode = {
  type?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

/** Серверные/служебные ключи — не показываем как редактируемые поля. */
export const VOLATILE_KEYS = [
  '_issues',
  '_field_confidence',
  '_normalized_fields',
  '_totals_recomputed',
  '_multidoc_documents',
  '_enrichment',
] as const;

const isVolatile = (k: string) => k.startsWith('_');

/** Частые ключи → человекочитаемая подпись (RU). Fallback — humanize. */
const LABELS: Record<string, string> = {
  number: 'Номер',
  doc_number: 'Номер',
  date: 'Дата',
  seller: 'Продавец',
  buyer: 'Покупатель',
  shipper: 'Грузоотправитель',
  consignee: 'Грузополучатель',
  supplier: 'Поставщик',
  customer: 'Покупатель',
  carrier: 'Перевозчик',
  sender: 'Отправитель',
  recipient: 'Получатель',
  party_a: 'Сторона А',
  party_b: 'Сторона Б',
  name: 'Наименование',
  inn: 'ИНН',
  kpp: 'КПП',
  ogrn: 'ОГРН',
  address: 'Адрес',
  bank: 'Банк',
  bank_name: 'Банк',
  bik: 'БИК',
  bic: 'БИК',
  account: 'Счёт',
  corr_account: 'Корр. счёт',
  correspondent_account: 'Корр. счёт',
  phone: 'Телефон',
  country: 'Страна',
  country_of_origin: 'Страна происхождения',
  currency: 'Валюта',
  exchange_rate: 'Курс',
  vat: 'НДС',
  vat_rate: 'Ставка НДС',
  vat_amount: 'Сумма НДС',
  total: 'Итого',
  total_with_vat: 'Итого с НДС',
  total_without_vat: 'Итого без НДС',
  items: 'Позиции',
  positions: 'Позиции',
  vat_summary: 'Разбивка НДС',
  qty: 'Кол-во',
  unit: 'Ед. изм.',
  price: 'Цена',
  code: 'Код',
  barcode: 'Штрих-код',
  hs_code: 'ТН ВЭД',
  line_no: '№ строки',
  weight_net: 'Вес нетто',
  weight_gross: 'Вес брутто',
  notes: 'Примечание',
  incoterms: 'Incoterms',
  is_export: 'Экспорт',
  is_advance: 'Аванс',
  vat_agent: 'Налоговый агент',
  usn: 'УСН',
};

/** key → подпись: словарь, иначе из snake_case → «Первое слово остальные». */
export function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key];
  const words = key.replace(/^_+/, '').split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return key;
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

const isDateKey = (key: string, node?: SchemaNode): boolean =>
  /(^|_)date$/.test(key) ||
  /(^|_)at$/.test(key) ||
  Boolean(node?.description && node.description.includes('YYYY-MM-DD'));

/** kind поля по узлу JSON Schema (+ ключ — для распознавания дат). */
function kindFromNode(key: string, node: SchemaNode): FieldKind {
  const t = node.type;
  if (t === 'object' && node.properties) return 'object';
  if (t === 'array') {
    return node.items?.type === 'object' ? 'array-objects' : 'array-strings';
  }
  if (t === 'number') return 'number';
  if (t === 'integer') return 'integer';
  if (t === 'boolean') return 'boolean';
  // string (или не указан) — может быть датой
  if (isDateKey(key, node)) return 'date';
  return 'string';
}

function specFromNode(key: string, node: SchemaNode): FieldSpec {
  const kind = kindFromNode(key, node);
  const spec: FieldSpec = {
    key,
    label: labelFor(key),
    kind,
    description: node.description,
  };
  if (kind === 'object' && node.properties) {
    spec.children = Object.entries(node.properties).map(([k, v]) => specFromNode(k, v));
  }
  if (kind === 'array-objects' && node.items?.properties) {
    spec.itemFields = Object.entries(node.items.properties).map(([k, v]) =>
      specFromNode(k, v),
    );
  }
  return spec;
}

/**
 * Разбор JSON Schema (`type:object, properties:{}`) в список полей верхнего
 * уровня. Пустая/некорректная схема → [] (вызывающий упадёт в fieldsFromValue).
 */
export function parseSchemaFields(schema: Record<string, unknown> | null | undefined): FieldSpec[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as SchemaNode).properties;
  if (!props || typeof props !== 'object') return [];
  return Object.entries(props)
    .filter(([k]) => !isVolatile(k))
    .map(([k, v]) => specFromNode(k, v as SchemaNode));
}

/** kind по фактическому значению (для незнакомых типов / extra-полей). */
export function kindFromValue(key: string, value: unknown): FieldKind {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) {
    return value.some((x) => x && typeof x === 'object' && !Array.isArray(x))
      ? 'array-objects'
      : 'array-strings';
  }
  if (value && typeof value === 'object') return 'object';
  if (isDateKey(key)) return 'date';
  return 'string';
}

function specFromValue(key: string, value: unknown): FieldSpec {
  const kind = kindFromValue(key, value);
  const spec: FieldSpec = { key, label: labelFor(key), kind };
  if (kind === 'object' && value && typeof value === 'object') {
    spec.children = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !isVolatile(k))
      .map(([k, v]) => specFromValue(k, v));
  }
  if (kind === 'array-objects' && Array.isArray(value)) {
    // Поля элемента = объединение ключей всех элементов.
    const keys = new Set<string>();
    for (const el of value) {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        for (const k of Object.keys(el as Record<string, unknown>)) {
          if (!isVolatile(k)) keys.add(k);
        }
      }
    }
    spec.itemFields = [...keys].map((k) => {
      const sample = (value.find(
        (el) => el && typeof el === 'object' && (el as Record<string, unknown>)[k] !== undefined,
      ) as Record<string, unknown> | undefined)?.[k];
      return specFromValue(k, sample);
    });
  }
  return spec;
}

/**
 * Поля из фактического `extracted` — для типов без схемы (решение §10.4:
 * «форма по распознанным полям», не сырой JSON). Служебные `_*` отброшены.
 */
export function fieldsFromValue(extracted: Record<string, unknown> | null | undefined): FieldSpec[] {
  if (!extracted || typeof extracted !== 'object') return [];
  return Object.entries(extracted)
    .filter(([k]) => !isVolatile(k))
    .map(([k, v]) => specFromValue(k, v));
}

/**
 * Объединяет поля схемы с фактически присланными ключами `extracted`:
 * сначала все ожидаемые (по схеме, в её порядке — видны даже пустые),
 * затем «лишние» распознанные поля, которых в схеме нет. Так выполняется
 * критерий «пустые ожидаемые поля видны» + не теряются неожиданные данные.
 */
export function mergeSchemaWithValue(
  schemaFields: FieldSpec[],
  extracted: Record<string, unknown> | null | undefined,
): FieldSpec[] {
  if (schemaFields.length === 0) return fieldsFromValue(extracted);
  const known = new Set(schemaFields.map((f) => f.key));
  const extras: FieldSpec[] = [];
  if (extracted && typeof extracted === 'object') {
    for (const [k, v] of Object.entries(extracted)) {
      if (!isVolatile(k) && !known.has(k)) extras.push(specFromValue(k, v));
    }
  }
  return [...schemaFields, ...extras];
}

/* ----------------------------- path utils ------------------------------ */

/** Сегменты dotted-path: "items.0.qty" → ['items','0','qty']. */
function segments(path: string): string[] {
  return path.split('.').filter((s) => s.length > 0);
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of segments(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/**
 * Иммутабельно проставляет значение по dotted-path, клонируя только узлы на
 * пути (structural sharing). Числовой сегмент создаёт/обновляет массив.
 */
export function setByPath<T>(root: T, path: string, value: unknown): T {
  const segs = segments(path);
  if (segs.length === 0) return root;

  const recurse = (node: unknown, i: number): unknown => {
    const seg = segs[i];
    const isIndex = /^\d+$/.test(seg);
    const last = i === segs.length - 1;

    if (isIndex) {
      const arr = Array.isArray(node) ? [...(node as unknown[])] : [];
      const idx = Number(seg);
      arr[idx] = last ? value : recurse(arr[idx], i + 1);
      return arr;
    }
    const obj =
      node && typeof node === 'object' && !Array.isArray(node)
        ? { ...(node as Record<string, unknown>) }
        : {};
    (obj as Record<string, unknown>)[seg] = last
      ? value
      : recurse((obj as Record<string, unknown>)[seg], i + 1);
    return obj;
  };

  return recurse(root, 0) as T;
}

/** Удаляет элемент массива по dotted-path к массиву + индексу (иммутабельно). */
export function removeArrayItem<T>(root: T, arrayPath: string, index: number): T {
  const arr = getByPath(root, arrayPath);
  if (!Array.isArray(arr)) return root;
  const next = arr.filter((_, i) => i !== index);
  return setByPath(root, arrayPath, next);
}
