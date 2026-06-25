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

/**
 * Курируемая карта «ключ поля → короткая русская подпись». Покрывает
 * реальные ключи статических схем (../src/types/document-json-schemas.ts) и
 * DB-driven схем (wire_transfer_application и т.п.). Для ключей вне карты —
 * fallback `humanizeKey` (snake_case → «Sentence case»), чтобы пользователь
 * НИКОГДА не видел сырой `snake_case` с подчёркиваниями.
 */
export const FIELD_LABELS: Record<string, string> = {
  /* --- общие / шапка --- */
  number: 'Номер',
  doc_number: 'Номер',
  date: 'Дата',
  amount: 'Сумма',
  amount_words: 'Сумма прописью',
  currency: 'Валюта',
  exchange_rate: 'Курс',
  purpose: 'Назначение платежа',
  payment_terms: 'Условия оплаты',
  payment_method: 'Способ оплаты',
  due_date: 'Срок оплаты',
  invoice_ref: 'Ссылка на счёт',
  contract_ref: 'Договор',
  contract_no: 'Номер договора',
  contract_date: 'Дата договора',
  parent_contract_number: 'Номер договора',
  parent_contract_date: 'Дата договора',
  period_from: 'Период с',
  period_to: 'Период по',
  notes: 'Примечание',
  additional_terms: 'Доп. условия',
  incoterms: 'Incoterms',
  incoterm: 'Incoterms',

  /* --- стороны --- */
  seller: 'Продавец',
  buyer: 'Покупатель',
  shipper: 'Грузоотправитель',
  consignee: 'Грузополучатель',
  consignor: 'Грузоотправитель',
  supplier: 'Поставщик',
  customer: 'Покупатель',
  carrier: 'Перевозчик',
  successive_carrier: 'Последующий перевозчик',
  forwarder: 'Экспедитор',
  payer: 'Плательщик',
  client: 'Заказчик',
  organization: 'Организация',
  notify_party: 'Уведомляемая сторона',
  sender: 'Отправитель',
  recipient: 'Получатель',
  beneficiary: 'Получатель',
  party_a: 'Сторона А',
  party_b: 'Сторона Б',

  /* --- платёжные / банковские (wire_transfer_application и др.) --- */
  sender_name: 'Отправитель',
  sender_inn: 'ИНН отправителя',
  sender_account: 'Счёт отправителя',
  beneficiary_name: 'Получатель',
  beneficiary_account: 'Счёт получателя',
  beneficiary_iban: 'IBAN получателя',
  beneficiary_address: 'Адрес получателя',
  beneficiary_country: 'Страна получателя',
  beneficiary_bank_name: 'Банк получателя',
  beneficiary_bank_swift: 'SWIFT банка получателя',

  /* --- реквизиты организации --- */
  name: 'Наименование',
  name_full: 'Полное наименование',
  name_short: 'Краткое наименование',
  inn: 'ИНН',
  kpp: 'КПП',
  ogrn: 'ОГРН',
  address: 'Адрес',
  bank: 'Банк',
  bank_name: 'Банк',
  bik: 'БИК',
  bic: 'БИК',
  swift: 'SWIFT',
  iban: 'IBAN',
  account: 'Счёт',
  corr_account: 'Корр. счёт',
  correspondent_account: 'Корр. счёт',
  phone: 'Телефон',
  email: 'E-mail',

  /* --- география / груз --- */
  country: 'Страна',
  country_of_origin: 'Страна происхождения',
  city: 'Город',
  route: 'Маршрут',
  route_from: 'Откуда',
  route_to: 'Куда',
  loading_point: 'Место погрузки',
  unloading_point: 'Место разгрузки',
  loading_place: 'Место погрузки',
  delivery_place: 'Место доставки',
  place_of_loading: 'Место погрузки',
  place_of_delivery: 'Место доставки',
  loading_date: 'Дата погрузки',
  unloading_date: 'Дата разгрузки',
  port_of_loading: 'Порт погрузки',
  port_of_discharge: 'Порт выгрузки',
  place_of_receipt: 'Место приёма',
  cargo: 'Груз',
  cargo_description: 'Описание груза',
  cargo_summary: 'Сводка по грузу',
  cargo_weight: 'Масса груза',
  declared_value: 'Заявленная стоимость',
  seal_number: 'Номер пломбы',
  containers: 'Контейнеры',
  container_number: 'Номер контейнера',
  vessel: 'Судно',
  driver: 'Водитель',
  vehicle: 'Транспорт',
  trailer: 'Прицеп',
  plate: 'Гос. номер',
  trailer_plate: 'Номер прицепа',
  model: 'Модель',
  vin: 'VIN',
  fio: 'ФИО',
  full_name: 'ФИО',
  fullName: 'ФИО',
  license: 'Вод. удостоверение',
  passport: 'Паспорт',

  /* --- суммы / НДС --- */
  vat: 'НДС',
  vat_rate: 'Ставка НДС',
  vat_amount: 'Сумма НДС',
  vat_included: 'НДС включён',
  total: 'Итого',
  total_with_vat: 'Итого с НДС',
  total_without_vat: 'Итого без НДС',
  amount_with_vat: 'Сумма с НДС',
  rate: 'Ставка',
  base: 'База',
  vat_summary: 'Разбивка НДС',
  service_cost: 'Стоимость услуг',
  distance_km: 'Расстояние, км',

  /* --- позиции --- */
  items: 'Позиции',
  positions: 'Позиции',
  qty: 'Кол-во',
  qty_per_package: 'Кол-во в упаковке',
  packages: 'Упаковок',
  unit: 'Ед. изм.',
  price: 'Цена',
  code: 'Код',
  barcode: 'Штрих-код',
  hs_code: 'ТН ВЭД',
  line_no: '№ строки',
  weight_net: 'Вес нетто',
  weight_gross: 'Вес брутто',
  weight_nett: 'Вес нетто',
  weight_kg: 'Вес, кг',
  gross_weight_kg: 'Вес брутто, кг',
  volume_m3: 'Объём, м³',
  order_ref: 'Заказ',
  order_refs: 'Заказы',

  /* --- флаги --- */
  is_export: 'Экспорт',
  is_advance: 'Аванс',
  vat_agent: 'Налоговый агент',
  usn: 'УСН',
  flags: 'Признаки',
};

/**
 * Гуманизатор ключа — чистая функция (юнит-тестируемая). Превращает
 * `snake_case` / `camelCase` в «Sentence case»:
 *   beneficiary_bank_swift → «Beneficiary bank swift»
 * Ведущие `_` и лишние разделители отбрасываются. camelCase разбивается по
 * границе регистра. Аббревиатуры в нижнем регистре по слову — намеренно
 * (короткая подпись, а не калька оригинала).
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  const joined = words.join(' ').toLowerCase();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Многоуровневый резолвинг подписи поля (для любой вложенности):
 *   1) курируемая карта FIELD_LABELS (короткая русская подпись);
 *   2) иначе — humanizeKey(key) как fallback.
 * Сырой `snake_case` наружу не попадает никогда.
 */
export function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? humanizeKey(key);
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

/**
 * Поля одного элемента массива по фактическим данным — объединение ключей
 * всех элементов (служебные `_*` отброшены). Используется как value-driven
 * источник колонок таблицы позиций и как fallback, когда схема объявила
 * массив объектов, но не дала `properties`.
 */
export function itemFieldsFromArray(value: unknown): FieldSpec[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const el of value) {
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      for (const k of Object.keys(el as Record<string, unknown>)) {
        if (!isVolatile(k)) keys.add(k);
      }
    }
  }
  return [...keys].map((k) => {
    const sample = (value.find(
      (el) => el && typeof el === 'object' && (el as Record<string, unknown>)[k] !== undefined,
    ) as Record<string, unknown> | undefined)?.[k];
    return specFromValue(k, sample);
  });
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
    spec.itemFields = itemFieldsFromArray(value);
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
  const obj = extracted && typeof extracted === 'object' ? extracted : undefined;
  // Сверяем форму поля схемы с фактическими данными: если схема объявила
  // массив (строк или без свойств элемента), а пришёл массив объектов —
  // показываем таблицу позиций по фактическим колонкам, а не textarea.
  const reconciled = schemaFields.map((f) => {
    const v = obj?.[f.key];
    const isArrayOfObjects =
      Array.isArray(v) &&
      v.some((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (isArrayOfObjects && (f.kind === 'array-strings' || (f.kind === 'array-objects' && (f.itemFields?.length ?? 0) === 0))) {
      return { ...f, kind: 'array-objects' as FieldKind, itemFields: itemFieldsFromArray(v) };
    }
    return f;
  });
  const known = new Set(schemaFields.map((f) => f.key));
  const extras: FieldSpec[] = [];
  if (obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (!isVolatile(k) && !known.has(k)) extras.push(specFromValue(k, v));
    }
  }
  return [...reconciled, ...extras];
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
