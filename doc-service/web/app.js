/**
 * parsdocs operator UI.
 *
 * One HTML shell + this module. No bundler, no framework — just hash-based
 * routing, fetch() with a Bearer token from localStorage, and templates
 * inlined as tagged template strings.
 *
 * Все стили — через design tokens из index.html (`.card`, `.btn-*`,
 * `.form-*`, `.page-*`, `.badge-*`, etc.). Ad-hoc Tailwind утилиты —
 * только для локального layout'а (flex, grid, gap). Это держит UI
 * консистентным между всеми views.
 */

const API = '/api/v1';
const STORAGE = {
  token: 'parsdocs.token',
  dark: 'parsdocs.dark',
  workspace: 'parsdocs.workspace',  // {organization_id, project_id}
};

/**
 * Workspace context — текущий выбранный проект пользователя.
 * Шарится между views: jobs list использует для фильтра, upload — как
 * дефолт project_id, document_types и providers пока глобальные.
 *
 * Хранится в localStorage и инициализируется при логине из списка
 * доступных пользователю проектов.
 */
const workspace = {
  get current() {
    try { return JSON.parse(localStorage.getItem(STORAGE.workspace) ?? 'null'); }
    catch { return null; }
  },
  set current(v) {
    if (v) localStorage.setItem(STORAGE.workspace, JSON.stringify(v));
    else localStorage.removeItem(STORAGE.workspace);
  },
};

// ============================================================
// Auth + API
// ============================================================

const auth = {
  get token() { return localStorage.getItem(STORAGE.token); },
  set token(v) {
    if (v) localStorage.setItem(STORAGE.token, v);
    else localStorage.removeItem(STORAGE.token);
  },
  isAuthed() { return !!this.token; },
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...opts, headers });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }
  if (res.status === 401) {
    auth.token = null;
    location.hash = '';
    showLogin();
    throw new Error('Unauthorized — token cleared, log in again');
  }
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    throw new Error(parsed?.error ? JSON.stringify(parsed.error) : `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================
// Theme
// ============================================================

function applyTheme() {
  const stored = localStorage.getItem(STORAGE.dark);
  const dark =
    stored === '1' ? true :
    stored === '0' ? false :
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}
function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  localStorage.setItem(STORAGE.dark, isDark ? '0' : '1');
  applyTheme();
}

// ============================================================
// Helpers — reused across views
// ============================================================

const STATUS_BADGE = {
  pending:      { label: 'Pending',      variant: 'badge-slate' },
  processing:   { label: 'Processing',   variant: 'badge-indigo badge-pulse' },
  done:         { label: 'Done',         variant: 'badge-emerald' },
  needs_review: { label: 'Needs review', variant: 'badge-amber' },
  failed:       { label: 'Failed',       variant: 'badge-rose' },
};
function badge(status) {
  const b = STATUS_BADGE[status] ?? { label: status, variant: 'badge-slate' };
  return `<span class="badge ${b.variant}">${escapeHtml(b.label)}</span>`;
}

const PARSER_BADGE = {
  'builtin:invoice_regex': { label: 'regex (invoice)', variant: 'badge-sky' },
  'builtin:upd_regex':     { label: 'regex (UPD)',     variant: 'badge-sky' },
  'llm_extract':           { label: 'LLM /extract',    variant: 'badge-violet' },
};
function parserKindBadge(kind) {
  const b = PARSER_BADGE[kind] ?? { label: kind, variant: 'badge-slate' };
  return `<span class="badge ${b.variant}">${escapeHtml(b.label)}</span>`;
}

function confidenceBar(confidence) {
  if (confidence === null || confidence === undefined) {
    return '<span class="text-slate-400 text-xs">—</span>';
  }
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.8 ? 'bg-emerald-500' :
    confidence >= 0.6 ? 'bg-amber-500' :
    'bg-rose-500';
  return `
    <div class="flex items-center gap-2">
      <div class="w-20 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div class="h-full ${color}" style="width:${pct}%"></div>
      </div>
      <span class="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">${pct}%</span>
    </div>`;
}

function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const diff = Math.round((Date.now() - t) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render a JSON value as a collapsible tree using native `<details>` for
 * expand/collapse (no JS state to manage). Color-coded by type via the
 * `.json-*` token classes defined in index.html.
 */
function jsonTree(value) {
  return `<div class="json-node">${renderJsonNode(value)}</div>`;
}

function renderJsonNode(value) {
  if (value === null) return `<span class="json-null">null</span>`;
  if (typeof value === 'boolean') return `<span class="json-boolean">${value}</span>`;
  if (typeof value === 'number') return `<span class="json-number">${value}</span>`;
  if (typeof value === 'string') return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="json-bracket">[]</span>`;
    const items = value.map((v, i) =>
      `<div>${renderJsonNode(v)}${i < value.length - 1 ? '<span class="json-bracket">,</span>' : ''}</div>`,
    ).join('');
    return `
      <details open>
        <summary class="json-bracket cursor-pointer select-none">[ <span class="text-slate-400">${value.length} items</span> ]</summary>
        <div class="json-indent ml-2 mt-1">${items}</div>
      </details>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return `<span class="json-bracket">{}</span>`;
    const rows = entries.map(([k, v], i) => `
      <div>
        <span class="json-key">"${escapeHtml(k)}"</span><span class="json-bracket">:</span> ${renderJsonNode(v)}${i < entries.length - 1 ? '<span class="json-bracket">,</span>' : ''}
      </div>`).join('');
    return `
      <details open>
        <summary class="json-bracket cursor-pointer select-none">{ <span class="text-slate-400">${entries.length} fields</span> }</summary>
        <div class="json-indent ml-2 mt-1">${rows}</div>
      </details>`;
  }
  return `<span class="json-null">undefined</span>`;
}

// ============================================================
// Extracted: form view — словарь, форматтеры, рендер
// ============================================================
//
// Сырой JSON-tree скрывает структуру документа от оператора. Этот блок
// превращает `extracted` в человекочитаемую форму: секции по top-level
// объектам (Плательщик/Получатель/Cargo/...), русские лейблы для известных
// ключей, специальное форматирование для ИНН/БИК/денег/дат, плашки
// validation-issues прямо рядом с полем.

/** Русские лейблы для известных ключей. Покрывает 15 builtin-типов. */
const FIELD_LABELS = {
  // Reusable / общие
  number: 'Номер',
  date: 'Дата',
  date_charged: 'Дата списания',
  total: 'Итого',
  total_amount: 'Сумма',
  amount: 'Сумма',
  amount_text: 'Сумма прописью',
  currency: 'Валюта',
  vat: 'НДС',
  vat_rate: 'Ставка НДС',
  vat_amount: 'Сумма НДС',
  vat_included: 'НДС включён',
  payment_terms: 'Условия оплаты',
  payment_kind: 'Вид платежа',
  payment_method: 'Способ оплаты',
  delivery_terms: 'Условия поставки',
  signed_at_location: 'Место подписания',
  effective_date: 'Дата вступления в силу',
  expiration_date: 'Срок действия до',
  title: 'Заголовок',
  description: 'Описание',
  subject: 'Предмет',
  subject_kind: 'Вид договора',
  priority: 'Очерёдность',
  // Banking
  bic: 'БИК',
  account: 'Расчётный счёт',
  correspondent_account: 'Корр. счёт',
  bank_name: 'Банк',
  // Party identification
  inn: 'ИНН',
  kpp: 'КПП',
  ogrn: 'ОГРН',
  tax_id: 'Tax ID',
  name: 'Наименование',
  address: 'Адрес',
  country: 'Страна',
  role: 'Роль',
  representative_name: 'Подписант',
  representative_title: 'Должность',
  representative_basis: 'На основании',
  // Parties (top-level keys)
  payer: 'Плательщик',
  payee: 'Получатель',
  seller: 'Продавец',
  buyer: 'Покупатель',
  exporter: 'Экспортёр',
  consignee: 'Получатель',
  shipper: 'Грузоотправитель',
  sender: 'Отправитель',
  recipient: 'Получатель',
  carrier: 'Перевозчик',
  notify_party: 'Notify Party',
  declarant: 'Декларант',
  merchant: 'Продавец',
  party_a: 'Сторона А',
  party_b: 'Сторона Б',
  // Contracts
  parent_contract_number: 'Договор №',
  parent_contract_date: 'Дата договора',
  changes: 'Изменения',
  addendum_kind: 'Тип допсоглашения',
  new_total_amount: 'Новая сумма',
  new_expiration_date: 'Новый срок',
  term_description: 'Срок',
  // Common purpose / subject
  purpose: 'Назначение платежа',
  // Transport / cargo
  cargo: 'Груз',
  vehicle: 'Транспорт',
  plate: 'Госномер',
  driver: 'Водитель',
  weight: 'Вес',
  weight_net: 'Вес нетто',
  weight_nett: 'Вес нетто',
  weight_gross: 'Вес брутто',
  places: 'Мест',
  qty: 'Количество',
  unit: 'Ед. изм.',
  unit_price: 'Цена за ед.',
  price: 'Цена',
  hs_code: 'Код ТН ВЭД',
  loading_point: 'Место погрузки',
  unloading_point: 'Место разгрузки',
  loading_place: 'Место погрузки',
  delivery_place: 'Место доставки',
  port_of_loading: 'Порт погрузки',
  port_of_discharge: 'Порт выгрузки',
  place_of_delivery: 'Место доставки',
  vessel_name: 'Судно',
  voyage_number: 'Рейс',
  containers: 'Контейнеры',
  container_number: 'Номер контейнера',
  seal_number: 'Пломба',
  freight_terms: 'Условия фрахта',
  bl_number: 'B/L №',
  bl_type: 'Тип B/L',
  // Customs
  declaration_number: 'Номер декларации',
  declaration_type: 'Тип декларации',
  procedure_code: 'Код процедуры',
  trading_country: 'Торгующая страна',
  origin_country: 'Страна происхождения',
  destination_country: 'Страна назначения',
  country_of_origin: 'Страна происхождения',
  transport_mode: 'Вид транспорта',
  exchange_rate: 'Курс',
  customs_value: 'Тамож. стоимость',
  total_value: 'Общая стоимость',
  invoice_value: 'Сумма по инвойсу',
  statistical_value: 'Стат. стоимость',
  duties: 'Платежи',
  base: 'База',
  rate: 'Ставка',
  // Cash receipt
  check_number: 'Номер чека',
  shift_number: 'Смена',
  date_time: 'Дата и время',
  cashier_name: 'Кассир',
  fn_number: 'ФН',
  fd_number: 'ФД',
  fp: 'ФП',
  kkt_serial: 'Серийный № ККТ',
  ofd_name: 'ОФД',
  check_type: 'Тип чека',
  payment_cash: 'Наличными',
  payment_card: 'Картой',
  store_id: 'Магазин',
  // Packing
  package_type: 'Тип упаковки',
  package_qty: 'Кол-во упаковок',
  items_per_package: 'Шт. в упаковке',
  dimensions: 'Габариты',
  volume: 'Объём',
  total_packages: 'Всего мест',
  total_weight_net: 'Вес нетто (всего)',
  total_weight_gross: 'Вес брутто (всего)',
  total_volume: 'Общий объём',
  // Misc
  incoterms: 'Incoterms',
  invoice_number: 'Номер инвойса',
  positions: 'Позиции',
  services: 'Услуги',
  signed: 'Подписан',
  signature_date: 'Дата подписания',
  packages: 'Места',
  description_text: 'Описание',
};

function labelFor(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  // Snake_case → Capitalized words.
  return key
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Формат для значения по типу ключа. Возвращает HTML-safe строку. */
function formatValue(key, value) {
  if (value === null || value === undefined || value === '') {
    return '<span class="text-slate-400 italic">—</span>';
  }
  // Boolean
  if (typeof value === 'boolean') {
    return value
      ? '<span class="badge badge-emerald">да</span>'
      : '<span class="badge badge-slate">нет</span>';
  }
  // Дата YYYY-MM-DD как есть; другие даты — отдаём как строку
  if (key === 'date' || key === 'date_charged' || key.endsWith('_date') || key === 'effective_date' || key === 'expiration_date' || key === 'signature_date') {
    return `<span class="font-mono">${escapeHtml(String(value))}</span>`;
  }
  // Деньги — числа с разделителями тысяч. Эвристика: ключи total/amount/price/value/vat/customs_value.
  if (typeof value === 'number' && /total|amount|price|value|vat|sum|cost/i.test(key) && !/rate/i.test(key)) {
    const formatted = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    return `<span class="font-mono tabular-nums">${escapeHtml(formatted)}</span>`;
  }
  // Технические — моноширинно
  if (key === 'inn' || key === 'kpp' || key === 'ogrn' || key === 'bic' || key === 'account' || key === 'correspondent_account' || key === 'fn_number' || key === 'fd_number' || key === 'fp' || key === 'hs_code' || key === 'container_number' || key === 'bl_number' || key === 'declaration_number' || key === 'plate') {
    return `<span class="font-mono">${escapeHtml(String(value))}</span>`;
  }
  // Country code
  if (key === 'country' || key === 'country_of_origin' || key === 'origin_country' || key === 'destination_country' || key === 'trading_country' || key === 'currency') {
    return `<span class="badge badge-sky">${escapeHtml(String(value))}</span>`;
  }
  // Числа — выровнять
  if (typeof value === 'number') {
    return `<span class="font-mono tabular-nums">${escapeHtml(String(value))}</span>`;
  }
  // Длинные строки (>80 символов) — отдельный класс с переносом
  const s = String(value);
  if (s.length > 80) {
    return `<span class="block break-words">${escapeHtml(s)}</span>`;
  }
  return escapeHtml(s);
}

/**
 * Парсит validation_issues и возвращает Map<dotPath, issue[]>. Issues
 * могут быть в формате «ИНН 7712345678: невалидная контрольная сумма»
 * или «КПП 0 имеет некорректный формат» — пытаемся вытащить значение
 * и сопоставить с конкретным полем в extracted.
 *
 * Грубая эвристика: если в issue упоминается ИНН/КПП/etc. + значение,
 * находим в extracted поле с этим значением и помечаем его. Если
 * сопоставить не удалось — issue остаётся "общим" и показывается в
 * банере над формой.
 */
function indexIssuesByField(extracted, issues) {
  const byPath = new Map();
  const unmatched = [];
  // Соответствие маркер→ключ. Маркер ищется в начале issue (case-insensitive).
  const markers = [
    { rx: /^ИНН\s+(\S+)/i, key: 'inn' },
    { rx: /^КПП\s+(\S+)/i, key: 'kpp' },
    { rx: /^ОГРН\s+(\S+)/i, key: 'ogrn' },
    { rx: /^БИК\s+(\S+)/i, key: 'bic' },
    { rx: /^Госномер\s+(\S+)/i, key: 'plate' },
    { rx: /^Дата\s+(\S+)/i, key: 'date' },
  ];

  for (const issue of issues) {
    let matched = false;
    for (const { rx, key } of markers) {
      const m = rx.exec(issue);
      if (!m) continue;
      const v = m[1];
      // Ищем в extracted top-level или nested-level (1 уровень глубины) поле
      // с таким ключом и таким значением.
      const path = findFieldPath(extracted, key, v);
      if (path) {
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(issue);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(issue);
  }
  return { byPath, unmatched };
}

function findFieldPath(obj, key, value, prefix = '') {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key && String(v) === String(value)) {
      return prefix ? `${prefix}.${k}` : k;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = findFieldPath(v, key, value, prefix ? `${prefix}.${k}` : k);
      if (inner) return inner;
    }
  }
  return null;
}

/** Главный рендерер форменного вида. */
function renderExtractedForm(extracted, issues) {
  if (!extracted || typeof extracted !== 'object' || Object.keys(extracted).length === 0) {
    return `<div class="empty-state"><p class="empty-state-text">Нет извлечённых данных</p></div>`;
  }
  const { byPath, unmatched } = indexIssuesByField(extracted, issues || []);

  // Группируем top-level ключи:
  //   - object (с подполями) → секция «Карточка»
  //   - array → секция со списком
  //   - primitive → idem верхнеуровневые «реквизиты»
  const primitives = [];
  const objectSections = [];
  const arraySections = [];
  for (const [k, v] of Object.entries(extracted)) {
    if (k === '_issues') continue; // служебное
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      objectSections.push([k, v]);
    } else if (Array.isArray(v)) {
      arraySections.push([k, v]);
    } else {
      primitives.push([k, v]);
    }
  }

  const renderRow = (key, value, pathPrefix = '') => {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const fieldIssues = byPath.get(path) || [];
    const issueBadge = fieldIssues.length > 0
      ? `<span class="ml-2 badge badge-amber" title="${escapeHtml(fieldIssues.join('; '))}">⚠ ${fieldIssues.length}</span>`
      : '';
    return `
      <div class="grid grid-cols-[10rem_1fr] gap-3 py-1.5 items-start border-b border-slate-100 dark:border-slate-800 last:border-b-0">
        <div class="text-xs text-slate-500 dark:text-slate-400 pt-0.5">${escapeHtml(labelFor(key))}</div>
        <div class="text-sm">${formatValue(key, value)}${issueBadge}</div>
      </div>`;
  };

  const renderObjectSection = (sectionKey, obj) => {
    const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (entries.length === 0) {
      return `
        <div class="card-section">
          <h4 class="card-title text-sm mb-1">${escapeHtml(labelFor(sectionKey))}</h4>
          <p class="text-xs text-slate-400">— не заполнено</p>
        </div>`;
    }
    return `
      <div class="card-section">
        <h4 class="card-title text-sm mb-2">${escapeHtml(labelFor(sectionKey))}</h4>
        ${entries.map(([k, v]) => renderRow(k, v, sectionKey)).join('')}
      </div>`;
  };

  const renderArraySection = (sectionKey, arr) => {
    if (arr.length === 0) {
      return `
        <div class="card-section">
          <h4 class="card-title text-sm mb-1">${escapeHtml(labelFor(sectionKey))}</h4>
          <p class="text-xs text-slate-400">— пусто</p>
        </div>`;
    }
    // Если элементы массива — объекты, рендерим табличкой.
    const allObjects = arr.every((it) => it !== null && typeof it === 'object' && !Array.isArray(it));
    if (allObjects) {
      const allKeys = Array.from(new Set(arr.flatMap((it) => Object.keys(it))));
      const headerCells = allKeys.map((k) => `<th class="px-2 py-1 text-left text-xs font-medium text-slate-500 dark:text-slate-400">${escapeHtml(labelFor(k))}</th>`).join('');
      const rows = arr.map((item, idx) => {
        const cells = allKeys.map((k) => `<td class="px-2 py-1 align-top">${formatValue(k, item[k])}</td>`).join('');
        return `<tr class="border-t border-slate-100 dark:border-slate-800"><td class="px-2 py-1 text-xs text-slate-400 align-top">${idx + 1}</td>${cells}</tr>`;
      }).join('');
      return `
        <div class="card-section">
          <h4 class="card-title text-sm mb-2">${escapeHtml(labelFor(sectionKey))} <span class="text-xs font-normal text-slate-500">(${arr.length})</span></h4>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr><th class="px-2 py-1 text-left text-xs font-medium text-slate-500">#</th>${headerCells}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }
    // Иначе — список значений.
    return `
      <div class="card-section">
        <h4 class="card-title text-sm mb-2">${escapeHtml(labelFor(sectionKey))} <span class="text-xs font-normal text-slate-500">(${arr.length})</span></h4>
        <ul class="list-disc list-inside space-y-1 text-sm">${arr.map((v) => `<li>${escapeHtml(String(v))}</li>`).join('')}</ul>
      </div>`;
  };

  return `
    ${unmatched.length > 0 ? `
      <div class="card-section warning-banner rounded-none border-0 border-b border-amber-200 dark:border-amber-900">
        <strong>Общие проблемы валидации:</strong>
        <ul class="list-disc list-inside text-xs mt-1 space-y-0.5">
          ${unmatched.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}
        </ul>
      </div>` : ''}
    ${primitives.length > 0 ? `
      <div class="card-section">
        <h4 class="card-title text-sm mb-2">Реквизиты</h4>
        ${primitives.map(([k, v]) => renderRow(k, v)).join('')}
      </div>` : ''}
    ${objectSections.map(([k, v]) => renderObjectSection(k, v)).join('')}
    ${arraySections.map(([k, v]) => renderArraySection(k, v)).join('')}
  `;
}

// ============================================================
// View lifecycle
// ============================================================
//
// setView writes new HTML, replacing the previous view. Before doing so it
// runs any cleanup registered by the previous view (cancels timers, etc.).

let currentCleanup = null;
function runCurrentCleanup() {
  if (currentCleanup) {
    try { currentCleanup(); } catch (e) { console.error('cleanup error', e); }
    currentCleanup = null;
  }
}
function setView(html) {
  runCurrentCleanup();
  document.getElementById('view').innerHTML = html;
}
function registerCleanup(fn) {
  currentCleanup = fn;
}

function pageHeader({ title, subtitle, actions }) {
  return `
    <header class="page-header">
      <div>
        <h2 class="page-title">${escapeHtml(title)}</h2>
        ${subtitle ? `<p class="page-subtitle">${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${actions ? `<div class="flex items-center gap-2 shrink-0">${actions}</div>` : ''}
    </header>`;
}

function backLink(href, label = 'К списку') {
  return `<a href="${escapeHtml(href)}" class="back-link">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clip-rule="evenodd"/></svg>
    ${escapeHtml(label)}
  </a>`;
}

function loadingState() {
  return `
    <div class="card empty-state">
      <div class="space-y-2 max-w-sm mx-auto">
        <div class="skeleton-row w-1/3 mx-auto"></div>
        <div class="skeleton-row w-2/3 mx-auto"></div>
        <div class="skeleton-row w-1/2 mx-auto"></div>
      </div>
    </div>`;
}

function errorState(message) {
  return `
    <div class="card error-banner">
      <p class="font-medium">Не удалось загрузить</p>
      <p class="text-sm mt-1">${escapeHtml(message)}</p>
    </div>`;
}

// ============================================================
// Login
// ============================================================

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('token-input').focus();
}
function hideLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
}

async function tryLogin(token) {
  auth.token = token;
  try {
    const res = await api('/jobs?limit=1');
    if (res.status === 200) return true;
    if (res.status === 401) return false;
    throw new Error(`Server responded ${res.status}`);
  } catch (err) {
    auth.token = null;
    throw err;
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = document.getElementById('token-input').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const ok = await tryLogin(token);
    if (!ok) {
      errEl.textContent = 'Неверный токен';
      errEl.classList.remove('hidden');
      return;
    }
    hideLogin();
    void initWorkspace();
    if (!location.hash) location.hash = '#jobs';
    else route();
  } catch (err) {
    errEl.textContent = err.message || 'Ошибка входа';
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  auth.token = null;
  workspace.current = null;
  showLogin();
});

document.getElementById('dark-toggle').addEventListener('click', toggleTheme);

/**
 * Загружает доступные пользователю проекты и инициализирует workspace
 * switcher. Если проектов >1 — показывает дропдаун в sidebar. Если
 * один (типичный manager) — прячет, но устанавливает в storage.
 * Если ноль — оставляет default System/Default.
 */
async function initWorkspace() {
  let projects;
  try {
    const res = await apiJson('/projects');
    projects = res.items;
  } catch {
    return;
  }
  if (!projects || projects.length === 0) return;

  const switcher = document.getElementById('workspace-switcher');
  const select = document.getElementById('workspace-select');
  if (!switcher || !select) return;

  const current = workspace.current;
  // Если ничего не выбрано — берём первый из списка как default.
  if (!current) {
    workspace.current = {
      organization_id: projects[0].organization_id,
      project_id: projects[0].id,
    };
  } else if (!projects.find((p) => p.id === current.project_id)) {
    // Пользователь больше не имеет доступа к сохранённому проекту.
    workspace.current = {
      organization_id: projects[0].organization_id,
      project_id: projects[0].id,
    };
  }

  select.innerHTML = projects.map((p) => `
    <option value="${p.id}" data-org="${p.organization_id}" ${p.id === workspace.current?.project_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>
  `).join('');

  // Показываем дропдаун только если есть выбор.
  if (projects.length > 1) {
    switcher.classList.remove('hidden');
  }

  select.addEventListener('change', () => {
    const opt = select.options[select.selectedIndex];
    workspace.current = {
      organization_id: opt.dataset.org,
      project_id: opt.value,
    };
    // Перерендериваем текущую view, чтобы фильтр применился.
    route();
  });
}

// ============================================================
// Router
// ============================================================

function route() {
  const h = (location.hash || '#dashboard').slice(1);

  document.querySelectorAll('[data-nav]').forEach((el) => {
    const target = el.dataset.nav;
    const isActive =
      h === target ||
      (target === 'dashboard' && h.startsWith('dashboard')) ||
      (target === 'jobs' && h.startsWith('jobs')) ||
      (target === 'review' && h.startsWith('review')) ||
      (target === 'document-types' && h.startsWith('document-types')) ||
      (target === 'providers' && h.startsWith('providers')) ||
      (target === 'audit-log' && h.startsWith('audit-log')) ||
      (target === 'tenants' && h.startsWith('tenants')) ||
      (target === 'reference-lists' && h.startsWith('reference-lists'));
    el.classList.toggle('active', isActive);
  });

  if (h === 'dashboard') return renderDashboard();
  if (h === 'jobs') return renderJobsList();
  if (h.startsWith('jobs/')) return renderJobDetail(h.slice(5));
  if (h === 'review') return renderReviewQueue();
  if (h === 'upload') return renderUpload();
  if (h === 'document-types') return renderDocumentTypesList();
  if (h === 'document-types/new') return renderDocumentTypeEditor(null);
  if (h.startsWith('document-types/')) return renderDocumentTypeEditor(h.slice('document-types/'.length));
  if (h === 'providers') return renderProvidersList();
  if (h === 'providers/new') return renderProviderEditor(null);
  if (h.startsWith('providers/')) return renderProviderEditor(h.slice('providers/'.length));
  if (h === 'audit-log') return renderAuditLog();
  if (h === 'tenants') return renderTenants();
  if (h === 'settings') return renderSettings();
  if (h === 'reference-lists') return renderReferenceLists();
  if (h.startsWith('reference-lists/')) return renderReferenceListEntries(h.slice('reference-lists/'.length));
  location.hash = '#dashboard';
}
window.addEventListener('hashchange', route);

// ============================================================
// Dashboard — операционный обзор
// ============================================================
//
// Что выводим (и почему): только метрики, которые можно посчитать ИЗ БД
// без ground-truth — статусы, latency перцентили, LLM-стоимость,
// throughput, per-type breakdown. Accuracy/coverage требуют golden-set,
// и считаются отдельно через `npm run eval`.
//
// UX-приоритет: пользователь должен за 5 секунд понять — «всё ок или
// что-то горит». Поэтому сверху — большие цифры totals + статус-бар,
// ниже — латенси и LLM, в самом низу — таблица по типам. Окно
// переключается одним кликом (1h / 24h / 7d / 30d) — без формы.
// Auto-refresh каждые 30 сек когда вкладка активна (cleanup на uhod
// со страницы), окно меняется без перезагрузки страницы.

const DASHBOARD_WINDOWS = [
  { value: '1h', label: '1 час' },
  { value: '24h', label: '24 часа' },
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
];
const DASHBOARD_REFRESH_MS = 30_000;

function pctFmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function msFmt(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${n} мс`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} с`;
}
function numFmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU').format(n);
}
function confFmt(n) {
  if (n === null || n === undefined) return '—';
  return n.toFixed(3);
}

// Цветовая шкала для нашего нагрузки/нездоровья. Использую те же
// токены что для status-бэйджей, чтобы UI был consistent.
function rateBadgeClass(rate, { goodMax, badMin }) {
  if (rate === null || rate === undefined) return 'badge-slate';
  if (rate >= badMin) return 'badge-rose';
  if (rate <= goodMax) return 'badge-emerald';
  return 'badge-amber';
}

async function renderDashboard() {
  // Persist выбранного окна между визитами — частая UX-просьба
  // у мониторинга. Default = 24h (хорошее окно для оперативного взгляда).
  const initialWindow = localStorage.getItem('dashboard_window') || '24h';

  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Dashboard',
        subtitle: 'Операционная сводка по обработке документов',
        actions: `
          <div class="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1" id="dashboard-window-switcher">
            ${DASHBOARD_WINDOWS.map((w) => `
              <button data-window="${w.value}" class="px-3 py-1 text-xs font-medium rounded ${w.value === initialWindow ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}">
                ${escapeHtml(w.label)}
              </button>
            `).join('')}
          </div>
          <button id="dashboard-refresh" class="btn-ghost btn-sm" title="Обновить сейчас">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/></svg>
          </button>
        `,
      })}
      <div id="dashboard-content" class="space-y-4">${loadingState()}</div>
      <p class="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Метрики считаются из БД на лету. Accuracy и поле-точность требуют эталонного набора —
        см. <code class="font-mono">npm run eval</code>.
      </p>
    </div>
  `);

  let currentWindow = initialWindow;
  let refreshTimer = null;

  async function refresh() {
    try {
      const data = await apiJson(`/metrics/operational?window=${encodeURIComponent(currentWindow)}`);
      const el = document.getElementById('dashboard-content');
      if (!el) return; // ушли со страницы
      el.innerHTML = renderDashboardBody(data);
    } catch (err) {
      const el = document.getElementById('dashboard-content');
      if (el) el.innerHTML = errorState(err.message);
    }
  }

  function setWindow(value) {
    if (value === currentWindow) return;
    currentWindow = value;
    localStorage.setItem('dashboard_window', value);
    document
      .querySelectorAll('#dashboard-window-switcher button')
      .forEach((b) => {
        const active = b.dataset.window === value;
        b.className = `px-3 py-1 text-xs font-medium rounded ${
          active
            ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        }`;
      });
    refresh();
  }

  document
    .getElementById('dashboard-window-switcher')
    ?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-window]');
      if (btn) setWindow(btn.dataset.window);
    });
  document.getElementById('dashboard-refresh')?.addEventListener('click', refresh);

  await refresh();
  refreshTimer = setInterval(refresh, DASHBOARD_REFRESH_MS);
  registerCleanup(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
}

function renderDashboardBody(data) {
  return `
    ${renderDashboardTotals(data)}
    ${renderDashboardLatencyAndLlm(data)}
    ${renderDashboardByType(data)}
  `;
}

function renderDashboardTotals(data) {
  const t = data.totals;
  const r = data.rates;

  // Топ-карточки: одна большая цифра + раскладка под ней.
  // Логика бэйджей по rates: чем меньше needs_review и failed — тем лучше.
  // Пороги взяты из README eval'а; для дашборда — те же.
  const reviewBadge = rateBadgeClass(r.needs_review_rate, { goodMax: 0.2, badMin: 0.4 });
  const failedBadge = rateBadgeClass(r.failed_rate, { goodMax: 0.01, badMin: 0.05 });
  const issueBadge = rateBadgeClass(r.validation_issue_rate, { goodMax: 0.15, badMin: 0.35 });

  return `
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div class="card card-body">
        <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Всего jobs</div>
        <div class="text-3xl font-semibold mt-1">${numFmt(t.total)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
          ${numFmt(data.throughput_per_hour)} / час · окно ${escapeHtml(String(data.window_hours))} ч
        </div>
      </div>
      <div class="card card-body">
        <div class="flex items-center justify-between">
          <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Done</div>
          <span class="badge badge-emerald">${pctFmt(r.done_rate)}</span>
        </div>
        <div class="text-3xl font-semibold mt-1">${numFmt(t.done)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
          avg confidence ${confFmt(data.avg_confidence)}
        </div>
      </div>
      <div class="card card-body">
        <div class="flex items-center justify-between">
          <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Needs review</div>
          <span class="badge ${reviewBadge}">${pctFmt(r.needs_review_rate)}</span>
        </div>
        <div class="text-3xl font-semibold mt-1">${numFmt(t.needs_review)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
          <a href="#jobs?status=needs_review" class="text-indigo-600 hover:text-indigo-700">открыть список →</a>
        </div>
      </div>
      <div class="card card-body">
        <div class="flex items-center justify-between">
          <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">Failed</div>
          <span class="badge ${failedBadge}">${pctFmt(r.failed_rate)}</span>
        </div>
        <div class="text-3xl font-semibold mt-1">${numFmt(t.failed)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-1">
          ${t.pending + t.processing > 0 ? `${numFmt(t.pending + t.processing)} in-flight` : 'нет in-flight'}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="flex items-center justify-between mb-2">
          <h3 class="card-title">Качество extraction</h3>
          <span class="badge ${issueBadge}">${pctFmt(r.validation_issue_rate)} с issues</span>
        </div>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Доля jobs, в которых доменная валидация нашла нестыковки (ИНН/КПП, НДС-сумма,
          госномер, парс дат). Без эталона мы не знаем «правильно или нет» —
          это <em>indicator of trouble</em>, не accuracy.
        </p>
        <dl class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm">
          <div class="kv-row"><dt class="kv-key">с validation issues</dt><dd class="kv-value">${numFmt(t.validation_issues)}</dd></div>
          <div class="kv-row"><dt class="kv-key">LLM-fallback</dt><dd class="kv-value">${numFmt(t.llm_used)} (${pctFmt(r.llm_fallback_rate)})</dd></div>
          <div class="kv-row"><dt class="kv-key">pending</dt><dd class="kv-value">${numFmt(t.pending)}</dd></div>
          <div class="kv-row"><dt class="kv-key">processing</dt><dd class="kv-value">${numFmt(t.processing)}</dd></div>
        </dl>
      </div>
    </div>
  `;
}

function renderDashboardLatencyAndLlm(data) {
  return `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="card card-body">
        <h3 class="card-title mb-2">End-to-end latency</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
          От <code class="font-mono">POST /jobs</code> до финального статуса.
          Включает ожидание в очереди — клиент видит именно это.
        </p>
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg bg-slate-50 dark:bg-slate-950/50 p-3">
            <div class="text-xs uppercase tracking-wider text-slate-500">P50</div>
            <div class="text-2xl font-semibold mt-1 font-mono">${msFmt(data.latency.p50_ms)}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-950/50 p-3">
            <div class="text-xs uppercase tracking-wider text-slate-500">P95</div>
            <div class="text-2xl font-semibold mt-1 font-mono">${msFmt(data.latency.p95_ms)}</div>
          </div>
        </div>
      </div>
      <div class="card card-body">
        <h3 class="card-title mb-2">LLM-расход</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
          P95 по последнему LLM-вызову в job'е. Прокси для стоимости —
          хвост важнее среднего (бюджет сжигается на больших документах).
        </p>
        <dl class="grid grid-cols-3 gap-3">
          <div class="rounded-lg bg-slate-50 dark:bg-slate-950/50 p-3">
            <div class="text-xs uppercase tracking-wider text-slate-500">tokens in</div>
            <div class="text-xl font-semibold mt-1 font-mono">${numFmt(data.llm.tokens_in_p95)}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-950/50 p-3">
            <div class="text-xs uppercase tracking-wider text-slate-500">tokens out</div>
            <div class="text-xl font-semibold mt-1 font-mono">${numFmt(data.llm.tokens_out_p95)}</div>
          </div>
          <div class="rounded-lg bg-slate-50 dark:bg-slate-950/50 p-3">
            <div class="text-xs uppercase tracking-wider text-slate-500">call ms</div>
            <div class="text-xl font-semibold mt-1 font-mono">${msFmt(data.llm.duration_p95_ms)}</div>
          </div>
        </dl>
      </div>
    </div>
  `;
}

function renderDashboardByType(data) {
  if (!data.by_type || data.by_type.length === 0) {
    return `
      <div class="card empty-state">
        <p class="empty-state-text">За окно нет jobs — загрузите документы во вкладке Upload.</p>
      </div>
    `;
  }

  const rows = data.by_type.map((t) => {
    const slugLabel =
      t.slug === '_unknown'
        ? '<span class="badge badge-slate">не классифицирован</span>'
        : `<a href="#jobs?document_type=${encodeURIComponent(t.slug)}" class="font-mono text-sm text-indigo-700 dark:text-indigo-300 hover:underline">${escapeHtml(t.slug)}</a>`;
    const reviewBadge = rateBadgeClass(t.needs_review_rate, { goodMax: 0.2, badMin: 0.4 });
    const failedBadge = rateBadgeClass(t.failed_rate, { goodMax: 0.01, badMin: 0.05 });
    const issueBadge = rateBadgeClass(t.validation_issue_rate, { goodMax: 0.15, badMin: 0.35 });
    return `
      <tr>
        <td>${slugLabel}</td>
        <td class="font-mono text-right">${numFmt(t.total)}</td>
        <td class="text-right">${numFmt(t.done)}<span class="text-slate-400 ml-1">/${pctFmt(t.done_rate)}</span></td>
        <td class="text-right"><span class="badge ${reviewBadge}">${pctFmt(t.needs_review_rate)}</span></td>
        <td class="text-right"><span class="badge ${failedBadge}">${pctFmt(t.failed_rate)}</span></td>
        <td class="text-right"><span class="badge ${issueBadge}">${pctFmt(t.validation_issue_rate)}</span></td>
        <td class="font-mono text-right">${msFmt(t.latency_p50_ms)}</td>
        <td class="font-mono text-right">${msFmt(t.latency_p95_ms)}</td>
        <td class="text-right">${pctFmt(t.llm_fallback_rate)}</td>
        <td class="font-mono text-right">${confFmt(t.avg_confidence)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">По типам документов</h3>
        <span class="text-xs text-slate-500 dark:text-slate-400">сортировка по объёму</span>
      </div>
      <div class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>тип</th>
              <th class="text-right">total</th>
              <th class="text-right">done</th>
              <th class="text-right">needs_review</th>
              <th class="text-right">failed</th>
              <th class="text-right">issues</th>
              <th class="text-right">P50</th>
              <th class="text-right">P95</th>
              <th class="text-right">LLM</th>
              <th class="text-right">avg conf.</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// Jobs list
// ============================================================

async function renderJobsList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Jobs',
        subtitle: 'Последние задачи обработки',
        actions: `<a href="#upload" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          New job
        </a>`,
      })}

      <div class="flex flex-wrap items-end gap-3 mb-4">
        <div class="form-row">
          <label class="form-label text-xs" for="filter-status">Статус</label>
          <select id="filter-status" class="form-select" style="width: 12rem;">
            <option value="">Все статусы</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="done">Done</option>
            <option value="needs_review">Needs review</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label text-xs" for="filter-type">Тип документа</label>
          <select id="filter-type" class="form-select" style="width: 14rem;">
            <option value="">Все типы</option>
            <option value="invoice">invoice — счёт</option>
            <option value="factInvoice">factInvoice — счёт-фактура</option>
            <option value="UPD">UPD — УПД</option>
            <option value="TTN">TTN — транспортная накладная</option>
            <option value="CMR">CMR — международная</option>
            <option value="AKT">AKT — акт услуг</option>
            <option value="payment_order">payment_order — платёжка</option>
            <option value="commercial_invoice">commercial_invoice</option>
            <option value="packing_list">packing_list</option>
            <option value="bill_of_lading">bill_of_lading</option>
            <option value="customs_declaration">customs_declaration — ГТД</option>
            <option value="cash_receipt">cash_receipt — кассовый чек</option>
            <option value="contract">contract — договор</option>
            <option value="contract_specification">contract_specification</option>
            <option value="contract_addendum">contract_addendum</option>
          </select>
        </div>
        <button id="refresh-btn" class="btn-secondary btn-sm">Обновить</button>
        <span id="auto-refresh-indicator" class="text-xs text-slate-400 hidden">auto-refresh on</span>
      </div>

      <div id="jobs-table" class="card overflow-hidden">${loadingState()}</div>
    </div>
  `);

  const statusEl = document.getElementById('filter-status');
  const typeEl = document.getElementById('filter-type');
  const refreshEl = document.getElementById('refresh-btn');
  const autoEl = document.getElementById('auto-refresh-indicator');
  let pollTimer = null;

  async function load() {
    const params = new URLSearchParams();
    if (statusEl.value) params.set('status', statusEl.value);
    if (typeEl.value) params.set('document_type', typeEl.value);
    // Применяем workspace-фильтр если выбран. super_admin без switcher'а
    // (workspace=null) увидит всё.
    const ws = workspace.current;
    if (ws?.project_id) params.set('project_id', ws.project_id);
    params.set('limit', '50');
    try {
      const data = await apiJson(`/jobs?${params.toString()}`);
      renderTable(data.items);
      const inflight = data.items.some((j) => j.status === 'pending' || j.status === 'processing');
      autoEl.classList.toggle('hidden', !inflight);
      return inflight;
    } catch (err) {
      document.getElementById('jobs-table').innerHTML = errorState(err.message);
      return false;
    }
  }

  function renderTable(items) {
    if (items.length === 0) {
      document.getElementById('jobs-table').innerHTML = `
        <div class="empty-state">
          <p class="empty-state-text">Задач пока нет.</p>
          <a href="#upload" class="empty-state-cta">Загрузить первый документ →</a>
        </div>`;
      return;
    }
    const rows = items.map((j) => `
      <tr class="row-clickable" data-job-id="${escapeHtml(j.job_id)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(j.job_id.slice(0, 8))}</td>
        <td>${badge(j.status)}</td>
        <td>${escapeHtml(j.document_type ?? '—')}</td>
        <td class="truncate max-w-[12rem]" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</td>
        <td>${confidenceBar(j.confidence)}</td>
        <td>${(j.validation_issues?.length ?? 0) > 0
          ? `<span class="text-amber-600 dark:text-amber-400 font-medium">${j.validation_issues.length}</span>`
          : '<span class="text-slate-300 dark:text-slate-600">—</span>'}</td>
        <td class="text-xs text-slate-500" title="${escapeHtml(j.created_at)}">${escapeHtml(relativeTime(j.created_at))}</td>
      </tr>`).join('');
    document.getElementById('jobs-table').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th><th>Status</th><th>Type</th><th>File</th>
            <th>Confidence</th><th>Issues</th><th>Created</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
    document.querySelectorAll('[data-job-id]').forEach((row) => {
      row.addEventListener('click', () => { location.hash = `#jobs/${row.dataset.jobId}`; });
    });
  }

  async function reloadAndScheduleNext() {
    const inflight = await load();
    if (inflight) pollTimer = setTimeout(reloadAndScheduleNext, 5000);
    else pollTimer = null;
  }

  statusEl.addEventListener('change', () => reloadAndScheduleNext());
  typeEl.addEventListener('change', () => reloadAndScheduleNext());
  refreshEl.addEventListener('click', () => reloadAndScheduleNext());

  await reloadAndScheduleNext();
  registerCleanup(() => { if (pollTimer) clearTimeout(pollTimer); });
}

// ============================================================
// Job detail
// ============================================================

async function renderJobDetail(jobId) {
  // page-narrow слишком узок для side-by-side; используем .page (шире).
  setView(`
    <div class="page">
      ${backLink('#jobs')}
      <div id="job-detail-content" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let pollTimer = null;
  let editing = false;
  // Object URL для preview оригинала. Хранится здесь чтобы освободить
  // в registerCleanup'е — иначе blob висит в памяти до закрытия вкладки.
  let currentOriginalUrl = null;

  async function load() {
    try {
      const job = await apiJson(`/jobs/${encodeURIComponent(jobId)}`);
      renderDetail(job);
      const inflight = job.status === 'pending' || job.status === 'processing';
      if (inflight && !editing) pollTimer = setTimeout(load, 2000);
      else pollTimer = null;
      // Resolution panel загружается асинхронно после рендера detail
      void loadResolution(jobId);
    } catch (err) {
      document.getElementById('job-detail-content').innerHTML = errorState(err.message);
    }
  }

  async function loadResolution(jid) {
    const panel = document.getElementById('resolution-panel');
    if (!panel) return;
    try {
      const res = await apiJson(`/jobs/${encodeURIComponent(jid)}/resolution`);
      if (res.entity_links.length === 0 && res.item_matches.length === 0) {
        panel.innerHTML = ''; // Нет данных резолюции — ничего не показываем
        return;
      }
      panel.innerHTML = renderResolutionPanel(jid, res);
      // Bind confirm/reject buttons
      panel.querySelectorAll('[data-confirm-link]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.confirmLink;
          btn.disabled = true;
          try {
            await apiJson(`/job-entity-links/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' });
            void loadResolution(jid);
          } catch (e) { alert(`Ошибка: ${e.message}`); btn.disabled = false; }
        });
      });
      panel.querySelectorAll('[data-reject-link]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.rejectLink;
          btn.disabled = true;
          try {
            await apiJson(`/job-entity-links/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' });
            void loadResolution(jid);
          } catch (e) { alert(`Ошибка: ${e.message}`); btn.disabled = false; }
        });
      });
      panel.querySelectorAll('[data-confirm-match]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.confirmMatch;
          btn.disabled = true;
          try {
            await apiJson(`/job-item-matches/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' });
            void loadResolution(jid);
          } catch (e) { alert(`Ошибка: ${e.message}`); btn.disabled = false; }
        });
      });
      panel.querySelectorAll('[data-reject-match]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.rejectMatch;
          btn.disabled = true;
          try {
            await apiJson(`/job-item-matches/${encodeURIComponent(id)}/reject`, { method: 'POST', body: '{}' });
            void loadResolution(jid);
          } catch (e) { alert(`Ошибка: ${e.message}`); btn.disabled = false; }
        });
      });
      panel.querySelectorAll('[data-re-resolve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Запускаем…';
          try {
            await apiJson(`/jobs/${encodeURIComponent(jid)}/re-resolve`, { method: 'POST', body: '{}' });
            btn.textContent = 'Запущено ✓';
            setTimeout(() => void loadResolution(jid), 1500);
          } catch (e) {
            const msg = String(e?.message ?? e);
            // 400 «no resolution_config» — конфиг типа был удалён админом между
            // загрузкой панели и кликом. Дизейблим кнопку и подсвечиваем.
            if (msg.includes('no resolution_config') || msg.includes('400')) {
              btn.textContent = 'Конфиг удалён';
              btn.classList.add('opacity-50');
            } else {
              btn.disabled = false;
              btn.textContent = 'Re-resolve';
              alert(`Ошибка: ${msg}`);
            }
          }
        });
      });
    } catch (err) {
      // GET /resolution всегда 200 если job существует; нечего показывать
      // обрабатывается в res.length === 0 ветке выше. Сюда попадаем только при
      // реальных ошибках (500, network, 401/403) — их показываем баннером,
      // чтобы оператор понимал что бэкенд недоступен.
      const msg = String(err?.message ?? err);
      panel.innerHTML = `<div class="error-banner text-sm">Не удалось загрузить резолюцию: ${escapeHtml(msg)}</div>`;
    }
  }

  function resolutionStatusBadge(status) {
    const map = {
      suggested: '<span class="badge badge-indigo">Suggested</span>',
      confirmed:  '<span class="badge badge-emerald">Confirmed</span>',
      rejected:   '<span class="badge badge-rose">Rejected</span>',
      not_found:  '<span class="badge badge-amber">Not found</span>',
    };
    return map[status] ?? `<span class="badge badge-slate">${escapeHtml(status)}</span>`;
  }

  function renderResolutionPanel(jid, res) {
    const { entity_links, item_matches, summary } = res;
    const summaryBadge = (n, color) =>
      n > 0 ? `<span class="badge ${color}">${n}</span>` : '';

    const linksHtml = entity_links.map((l) => {
      const canAct = l.status === 'suggested' || l.status === 'not_found';
      return `
        <tr class="border-b border-slate-100 dark:border-slate-800">
          <td class="px-4 py-3 text-xs font-mono text-slate-500">${escapeHtml(l.list_type_slug)}</td>
          <td class="px-4 py-3 text-sm">${l.entry ? escapeHtml(l.entry.display_name) : `<span class="text-slate-400 italic">—</span>`}</td>
          <td class="px-4 py-3 text-xs font-mono text-slate-500">${escapeHtml(l.match_value ?? '—')}</td>
          <td class="px-4 py-3">${resolutionStatusBadge(l.status)}</td>
          <td class="px-4 py-3">
            ${canAct ? `
              <div class="flex gap-1">
                <button data-confirm-link="${escapeHtml(l.id)}" class="btn-success btn-xs" ${l.status === 'confirmed' ? 'disabled' : ''}>✓</button>
                <button data-reject-link="${escapeHtml(l.id)}" class="btn-danger btn-xs" ${l.status === 'rejected' ? 'disabled' : ''}>✕</button>
              </div>` : ''}
          </td>
        </tr>`;
    }).join('');

    const matchesHtml = item_matches.map((m) => {
      const canAct = m.status === 'suggested' || m.status === 'not_found';
      const name = m.item_raw?.name ?? m.item_raw?.description ?? `#${m.item_index}`;
      return `
        <tr class="border-b border-slate-100 dark:border-slate-800">
          <td class="px-4 py-3 text-xs text-slate-500">${m.item_index}</td>
          <td class="px-4 py-3 text-sm max-w-[16rem] truncate" title="${escapeHtml(String(name))}">${escapeHtml(String(name))}</td>
          <td class="px-4 py-3 text-sm">${m.entry ? escapeHtml(m.entry.display_name) : `<span class="text-slate-400 italic">—</span>`}</td>
          <td class="px-4 py-3">${resolutionStatusBadge(m.status)}</td>
          <td class="px-4 py-3">
            ${canAct ? `
              <div class="flex gap-1">
                <button data-confirm-match="${escapeHtml(m.id)}" class="btn-success btn-xs">✓</button>
                <button data-reject-match="${escapeHtml(m.id)}" class="btn-danger btn-xs">✕</button>
              </div>` : ''}
          </td>
        </tr>`;
    }).join('');

    return `
      <details class="card" open>
        <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
          <div class="flex items-center justify-between w-full gap-3">
            <span class="card-title">Резолюция (привязка)</span>
            <div class="flex items-center gap-2">
              ${summaryBadge(summary.links_not_found + summary.items_not_found, 'badge-amber')}
              ${summaryBadge(summary.links_confirmed + (summary.items_matched - summary.items_not_found), 'badge-emerald')}
              <button data-re-resolve="${escapeHtml(jid)}" class="btn-secondary btn-xs">Re-resolve</button>
            </div>
          </div>
        </summary>

        ${entity_links.length > 0 ? `
          <div class="card-section">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Сущности (entity links)</div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr>
                  <th>Справочник</th><th>Запись</th><th>Значение</th><th>Статус</th><th></th>
                </tr></thead>
                <tbody>${linksHtml}</tbody>
              </table>
            </div>
          </div>` : ''}

        ${item_matches.length > 0 ? `
          <div class="card-section">
            <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
              Строки документа (item matches) — ${summary.items_matched}/${summary.items_total} найдено
            </div>
            <div class="overflow-x-auto">
              <table class="data-table">
                <thead><tr>
                  <th>#</th><th>Строка</th><th>Запись</th><th>Статус</th><th></th>
                </tr></thead>
                <tbody>${matchesHtml}</tbody>
              </table>
            </div>
          </div>` : ''}
      </details>
    `;
  }

  function renderDetail(job) {
    const issues = job.validation_issues || [];
    const extracted = job.extracted ?? {};

    document.getElementById('job-detail-content').innerHTML = `
      <!-- Header -->
      <div class="card card-body-lg">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              ${badge(job.status)}
              ${job.document_type ? `<span class="text-sm text-slate-600 dark:text-slate-400">${escapeHtml(job.document_type)}</span>` : ''}
            </div>
            <h2 class="text-xl font-semibold truncate" title="${escapeHtml(job.file_name)}">${escapeHtml(job.file_name)}</h2>
            <div class="mt-2 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 font-mono flex-wrap">
              <span>${escapeHtml(job.job_id)}</span>
              <span>${(job.file_size / 1024).toFixed(1)} KB</span>
              <span>${escapeHtml(job.mime_type)}</span>
              <span title="organization / project">org ${escapeHtml(job.organization_id.slice(0, 8))} · proj ${escapeHtml(job.project_id.slice(0, 8))}</span>
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-xs text-slate-500 dark:text-slate-400 mb-1.5">Confidence</div>
            ${confidenceBar(job.confidence)}
            ${job.ocr_engine ? `<div class="text-xs text-slate-400 mt-2">via <span class="font-mono">${escapeHtml(job.ocr_engine)}</span></div>` : ''}
          </div>
        </div>
        ${job.error ? `
          <div class="mt-4 error-banner text-sm">
            <strong>Error:</strong> ${escapeHtml(job.error)}
          </div>` : ''}
      </div>

      ${issues.length > 0 ? `
        <div class="card">
          <div class="warning-banner rounded-xl border-0">
            <div class="flex items-center gap-2 mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 text-amber-600 dark:text-amber-400"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>
              <h3 class="font-semibold">Validation issues (${issues.length})</h3>
            </div>
            <ul class="space-y-1.5">
              ${issues.map((i) => `<li class="text-sm flex gap-2"><span class="text-amber-500">•</span><span class="font-mono">${escapeHtml(i)}</span></li>`).join('')}
            </ul>
          </div>
        </div>` : ''}

      <!-- Side-by-side: оригинал + extracted на широких экранах,
           stacked на узких. PDF/картинка слева, JSON справа. -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="card overflow-hidden">
          <div class="card-header">
            <h3 class="card-title">Оригинал</h3>
            <a id="original-open" href="#" target="_blank" class="btn-ghost btn-xs" rel="noopener">Открыть ↗</a>
          </div>
          <div id="original-pane" class="card-body p-2 bg-slate-50 dark:bg-slate-950 min-h-[24rem]">
            ${loadingState()}
          </div>
        </div>

        <div class="card overflow-hidden">
          <div class="card-header">
            <h3 class="card-title">Extracted data</h3>
            <div class="flex items-center gap-2">
              <div class="inline-flex rounded-md border border-slate-300 dark:border-slate-700 overflow-hidden text-xs">
                <button id="view-form-btn" class="px-2 py-1 bg-indigo-600 text-white" data-view="form">Форма</button>
                <button id="view-json-btn" class="px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800" data-view="json">JSON</button>
              </div>
              <button id="copy-json-btn" class="btn-secondary btn-xs">Copy</button>
              ${job.status === 'needs_review' ? `<button id="approve-btn" class="btn-success btn-xs" title="Одобрить: marked as done без изменения extracted">Одобрить ✓</button>` : ''}
              <button id="reprocess-btn" class="btn-secondary btn-xs" title="Перепрогнать через текущий prompt/схему типа (без новой OCR)">Перепрогнать</button>
              <button id="edit-btn" class="btn-accent-outline btn-xs">Edit</button>
            </div>
          </div>
          <div id="extracted-pane" class="card-body p-0">
            <div id="extracted-form-view">${renderExtractedForm(extracted, issues)}</div>
            <div id="extracted-json-view" class="hidden bg-slate-50 dark:bg-slate-950 p-4 overflow-x-auto">${jsonTree(extracted)}</div>
          </div>
        </div>
      </div>

      <!-- Raw text (collapsed) -->
      <details class="card">
        <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
          <span class="card-title">Raw OCR text</span>
        </summary>
        <div class="card-body">
          <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-4 rounded-lg whitespace-pre-wrap max-h-96 overflow-y-auto text-slate-700 dark:text-slate-300">${escapeHtml(job.raw_text || '(нет распознанного текста)')}</pre>
        </div>
      </details>

      ${job.last_llm_call ? `
        <details class="card">
          <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
            <div class="flex items-center justify-between w-full">
              <span class="card-title">LLM call <span class="text-sm font-normal text-slate-500">${escapeHtml(job.last_llm_call.backend)} / ${escapeHtml(job.last_llm_call.model)}</span></span>
              <span class="text-xs text-slate-400">${job.last_llm_call.prompt.length} chars prompt · ${job.last_llm_call.raw_response.length} chars response</span>
            </div>
          </summary>
          <div class="card-body space-y-3">
            <p class="text-xs text-slate-500 dark:text-slate-400">Финальный prompt отправленный модели и её ответ ДО нашего JSON-парсинга. Если extracted кривой — смотрите здесь: prompt криво подставился, схема не подошла, или модель вернула не-JSON.</p>
            <div>
              <div class="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">Prompt</div>
              <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-3 rounded-lg whitespace-pre-wrap max-h-96 overflow-y-auto text-slate-700 dark:text-slate-300">${escapeHtml(job.last_llm_call.prompt)}</pre>
            </div>
            <div>
              <div class="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">Raw model response</div>
              <pre class="text-xs font-mono bg-slate-50 dark:bg-slate-950 p-3 rounded-lg whitespace-pre-wrap max-h-96 overflow-y-auto text-slate-700 dark:text-slate-300">${escapeHtml(job.last_llm_call.raw_response)}</pre>
            </div>
          </div>
        </details>` : ''}

      ${job.metadata ? `
        <details class="card">
          <summary class="card-header cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition list-none">
            <span class="card-title">Client metadata</span>
          </summary>
          <div class="card-body">
            <div class="bg-slate-50 dark:bg-slate-950 rounded-lg p-4 overflow-x-auto">${jsonTree(job.metadata)}</div>
          </div>
        </details>` : ''}

      <!-- Resolution panel — заполняется асинхронно через loadResolution() -->
      <div id="resolution-panel"></div>
    `;

    const copyBtn = document.getElementById('copy-json-btn');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(extracted, null, 2));
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    });

    // View toggle: Форма ↔ JSON. Persist в localStorage чтобы оператор
    // не переключал каждый раз.
    const STORAGE_VIEW = 'parsdocs.extractedView';
    const switchExtractedView = (mode) => {
      const formView = document.getElementById('extracted-form-view');
      const jsonView = document.getElementById('extracted-json-view');
      const formBtn = document.getElementById('view-form-btn');
      const jsonBtn = document.getElementById('view-json-btn');
      if (!formView || !jsonView || !formBtn || !jsonBtn) return;
      const isForm = mode === 'form';
      formView.classList.toggle('hidden', !isForm);
      jsonView.classList.toggle('hidden', isForm);
      formBtn.classList.toggle('bg-indigo-600', isForm);
      formBtn.classList.toggle('text-white', isForm);
      jsonBtn.classList.toggle('bg-indigo-600', !isForm);
      jsonBtn.classList.toggle('text-white', !isForm);
      localStorage.setItem(STORAGE_VIEW, mode);
    };
    const preferred = localStorage.getItem(STORAGE_VIEW);
    if (preferred === 'json') switchExtractedView('json');
    document.getElementById('view-form-btn')?.addEventListener('click', () => switchExtractedView('form'));
    document.getElementById('view-json-btn')?.addEventListener('click', () => switchExtractedView('json'));

    document.getElementById('edit-btn').addEventListener('click', () => {
      editing = true;
      if (pollTimer) clearTimeout(pollTimer);
      renderEditor(extracted);
    });

    // Оригинал документа: подгружается отдельным fetch'ем с Bearer-токеном,
    // превращается в blob → object URL → <img>/<iframe>. Object URL живёт
    // до teardown'а view (см. registerCleanup ниже).
    void loadOriginalFile(jobId, job).then((res) => {
      const pane = document.getElementById('original-pane');
      const opener = document.getElementById('original-open');
      if (!pane) return;
      if (res.gone) {
        pane.innerHTML = `<div class="empty-state"><p class="empty-state-text">Файл удалён по retention-политике</p></div>`;
        if (opener) opener.style.display = 'none';
        return;
      }
      if (res.error) {
        pane.innerHTML = errorState(res.error);
        if (opener) opener.style.display = 'none';
        return;
      }
      // <iframe> подходит для PDF (браузер показывает встроенный viewer),
      // <img> для JPEG/PNG/BMP/TIFF (TIFF поддерживают не все браузеры,
      // но fallback мы оставляем браузеру — он покажет broken-image).
      const isPdf = res.mime === 'application/pdf';
      pane.innerHTML = isPdf
        ? `<iframe src="${res.url}" class="w-full" style="height:70vh; border:0;"></iframe>`
        : `<img src="${res.url}" class="w-full h-auto rounded" alt="original document" />`;
      if (opener) opener.href = res.url;
      if (currentOriginalUrl) URL.revokeObjectURL(currentOriginalUrl);
      currentOriginalUrl = res.url;
    });

    // Одобрить: needs_review → done без изменения extracted.
    const approveBtn = document.getElementById('approve-btn');
    if (approveBtn) {
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        approveBtn.textContent = 'Сохранение…';
        try {
          await apiJson(`/jobs/${encodeURIComponent(jobId)}/approve`, { method: 'POST' });
          await load();
        } catch (err) {
          approveBtn.disabled = false;
          approveBtn.textContent = 'Одобрить ✓';
          alert(`Не удалось одобрить: ${err.message}`);
        }
      });
    }

    // Перепрогнать: вызывает POST /jobs/:id/reprocess. OCR не повторяется,
    // обрабатывает только пост-OCR этап с актуальным prompt/схемой.
    const reprocessBtn = document.getElementById('reprocess-btn');
    reprocessBtn.addEventListener('click', async () => {
      reprocessBtn.disabled = true;
      reprocessBtn.textContent = 'Перепрогон…';
      try {
        await apiJson(`/jobs/${encodeURIComponent(jobId)}/reprocess`, { method: 'POST' });
        reprocessBtn.textContent = 'Готово ✓';
        setTimeout(() => {
          reprocessBtn.textContent = 'Перепрогнать';
          reprocessBtn.disabled = false;
        }, 1500);
        await load();
      } catch (err) {
        reprocessBtn.textContent = 'Перепрогнать';
        reprocessBtn.disabled = false;
        alert(`Не удалось перепрогнать: ${err.message}`);
      }
    });
  }

  function renderEditor(currentExtracted) {
    const currentJson = JSON.stringify(currentExtracted, null, 2);
    document.getElementById('extracted-pane').innerHTML = `
      <div class="form-row">
        <textarea id="extracted-editor" class="form-textarea" rows="16" spellcheck="false">${escapeHtml(currentJson)}</textarea>
        <p id="editor-error" class="hidden form-error"></p>
        <p class="form-help">При сохранении статус станет <code class="font-mono">done</code>, валидация перезапустится автоматически.</p>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <button id="save-btn" class="btn-primary btn-md">Save</button>
        <button id="cancel-btn" class="btn-secondary btn-md">Cancel</button>
      </div>
    `;
    document.getElementById('cancel-btn').addEventListener('click', () => {
      editing = false;
      load();
    });
    document.getElementById('save-btn').addEventListener('click', async () => {
      const text = document.getElementById('extracted-editor').value;
      const errEl = document.getElementById('editor-error');
      errEl.classList.add('hidden');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        errEl.textContent = `Invalid JSON: ${err.message}`;
        errEl.classList.remove('hidden');
        return;
      }
      try {
        await apiJson(`/jobs/${encodeURIComponent(jobId)}/extracted`, {
          method: 'PATCH',
          body: JSON.stringify(parsed),
        });
        editing = false;
        load();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  await load();
  registerCleanup(() => {
    if (pollTimer) clearTimeout(pollTimer);
    if (currentOriginalUrl) {
      URL.revokeObjectURL(currentOriginalUrl);
      currentOriginalUrl = null;
    }
  });
}

/**
 * Подгружает оригинал документа с Bearer-токеном и оборачивает его в
 * blob: URL — это позволяет показать его в <img>/<iframe> без передачи
 * токена в URL.
 *
 * Returns:
 *   { gone: true } — 410, файл удалён по retention.
 *   { error: msg } — другой не-OK статус или network error.
 *   { url, mime } — готовый object URL и MIME-тип.
 */
async function loadOriginalFile(jobId, jobMeta) {
  try {
    const res = await api(`/jobs/${encodeURIComponent(jobId)}/file`);
    if (res.status === 410) return { gone: true };
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const blob = await res.blob();
    // mime_type из job меты надёжнее чем blob.type (некоторые серверы
    // не выставляют Content-Type на бинарь — blob.type будет ''):
    const mime = jobMeta?.mime_type || blob.type || 'application/octet-stream';
    return { url: URL.createObjectURL(blob), mime };
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================
// Upload
// ============================================================

/**
 * Bulk upload — кидаем папку или сразу N файлов, грузим параллельно с
 * ограничением в 3 одновременно. Каждый файл — своя per-row строка с
 * прогрессом / статусом / ссылкой на созданный job.
 *
 * Под капотом: один common-формы (hint / webhook / metadata) применяется
 * ко всем файлам, project_id берётся из workspace switcher'а. Если
 * админ загружает 50 счетов одного типа на тест prompt'а — это самый
 * быстрый способ собрать данные для Field coverage.
 */
const UPLOAD_CONCURRENCY = 3;

function renderUpload() {
  setView(`
    <div class="page-narrow">
      ${pageHeader({ title: 'Загрузить документы', subtitle: 'Один или несколько файлов на обработку' })}

      <div class="space-y-5">
        <div class="card card-body-lg">
          <div id="dropzone" class="dropzone border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-10 text-center cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 transition">
            <input type="file" id="file-input" class="hidden" multiple accept=".pdf,.jpg,.jpeg,.png,.bmp,.tif,.tiff" />
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-12 h-12 mx-auto mb-3 text-slate-400"><path d="M11.47 1.72a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1-1.06 1.06l-1.72-1.72V7.5h-1.5V4.06L9.53 5.78a.75.75 0 0 1-1.06-1.06l3-3ZM11.25 7.5V15a.75.75 0 0 0 1.5 0V7.5h3.75a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3h3.75Z"/></svg>
            <p id="dropzone-text" class="text-sm text-slate-600 dark:text-slate-400">
              Перетащи файлы (или папку) сюда или <span class="text-indigo-600 dark:text-indigo-400 font-medium">кликни чтобы выбрать</span>
            </p>
            <p class="text-xs text-slate-400 mt-1">PDF, JPG, PNG, BMP, TIFF · до 50 МБ на файл · до ${UPLOAD_CONCURRENCY} параллельно</p>
          </div>
        </div>

        <form id="upload-form" class="card card-body-lg space-y-4">
          <!-- Тип документа: главное поле, влияет на качество распознавания -->
          <div class="form-row">
            <label class="form-label">Тип документа</label>
            <select name="document_hint" id="doc-type-select" class="form-select">
              <option value="">Авто-определение (по содержимому)</option>
              <!-- Опции подгружаются из /document-types в onMount -->
            </select>
            <p class="form-help">
              Помогает системе точнее распознать структуру. Оставьте авто-определение,
              если не знаете — классификатор определит сам.
            </p>
          </div>

          <!-- Превью ожидаемых полей: показывается после выбора типа -->
          <div id="expected-fields-preview" class="hidden">
            <div class="info-banner text-sm">
              <div class="font-semibold mb-2 text-sky-800 dark:text-sky-200">Будут извлечены:</div>
              <div id="expected-fields-list" class="flex flex-wrap gap-1.5"></div>
            </div>
          </div>

          <!-- Движки обработки: что реально побежит на сервере -->
          <div id="processing-engines" class="hidden">
            <div class="form-row">
              <label class="form-label">Движок обработки</label>
              <div id="engines-chain" class="flex items-center gap-2 flex-wrap text-sm"></div>
              <p class="form-help">Цепочка пробуется сверху вниз — каждая следующая ступень включается если предыдущая не уверена.</p>
            </div>
          </div>

          <!-- Дев-настройки: webhook + metadata, спрятаны по умолчанию -->
          <details class="border-t border-slate-200 dark:border-slate-800 pt-4">
            <summary class="cursor-pointer text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 select-none flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M6.28 5.22a.75.75 0 0 1 1.06 0L10 7.88l2.66-2.66a.75.75 0 1 1 1.06 1.06l-3.19 3.19a.75.75 0 0 1-1.06 0L6.28 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>
              Настройки для разработчиков
            </summary>
            <div class="mt-4 space-y-4">
              <div class="form-row">
                <label class="form-label">Webhook URL <span class="text-slate-400 font-normal">(опционально)</span></label>
                <input name="webhook_url" type="url" placeholder="https://..." class="form-input" />
                <p class="form-help">URL для POST результата после обработки. Подписывается HMAC-SHA256.</p>
              </div>
              <div class="form-row">
                <label class="form-label">Metadata JSON <span class="text-slate-400 font-normal">(опционально)</span></label>
                <textarea name="metadata" rows="2" placeholder='{"batch": "test-2026-05"}' class="form-textarea"></textarea>
                <p class="form-help">Echo обратно в результат и webhook. Удобно для batch-ID или трекинга источника.</p>
              </div>
            </div>
          </details>
        </form>

        <!-- Очередь файлов -->
        <div id="queue-section" class="card overflow-hidden hidden">
          <div class="card-header">
            <h3 class="card-title">Файлы <span id="queue-counter" class="text-sm font-normal text-slate-500"></span></h3>
            <div class="flex items-center gap-2">
              <button id="clear-done-btn" class="btn-ghost btn-xs" style="display:none">Убрать готовые</button>
              <button id="start-btn" type="button" class="btn-primary btn-sm">Загрузить</button>
            </div>
          </div>
          <div id="queue-list"></div>
        </div>

        <p id="upload-error" class="hidden form-error"></p>
      </div>
    </div>
  `);

  // ── Подгрузка справочников (типы документов + движки) ─────────────────────
  // Делается асинхронно после render'а, чтобы не блокировать показ страницы.
  // Если запросы упадут — UI деградирует к старой пустой логике без ошибок
  // пользователю (auto-detect всё равно работает).
  let availableTypes = []; // [{ slug, display_name, expected_fields }]

  void (async () => {
    try {
      const { items } = await apiJson('/document-types');
      // Только активные типы — деактивированные не должны путать оператора
      availableTypes = items.filter((t) => t.is_active);
      const select = document.getElementById('doc-type-select');
      if (!select) return;
      // Сортируем по русскому display_name для предсказуемого порядка
      availableTypes.sort((a, b) => a.display_name.localeCompare(b.display_name, 'ru'));
      for (const t of availableTypes) {
        const opt = document.createElement('option');
        opt.value = t.slug;
        opt.textContent = t.display_name;
        select.appendChild(opt);
      }
    } catch (err) {
      console.warn('Не удалось загрузить типы документов:', err.message);
    }
  })();

  void (async () => {
    try {
      const settings = await apiJson('/settings');
      renderEngineChain(settings);
    } catch (err) {
      console.warn('Не удалось загрузить настройки движков:', err.message);
    }
  })();

  function renderEngineChain(settings) {
    const container = document.getElementById('processing-engines');
    const chain = document.getElementById('engines-chain');
    if (!container || !chain) return;

    // Цепочка: PDF-text → Tesseract → Vision-LLM → Yandex (опционально)
    const steps = [];
    steps.push({ name: 'PDF-text', desc: 'Извлечение текста из PDF', active: true });
    steps.push({
      name: `Tesseract (${(settings.ocr_engines?.tesseract_langs ?? ['rus', 'eng']).join('+')})`,
      desc: 'Локальный OCR',
      active: true,
    });
    if (settings.ocr_engines?.vision_llm?.enabled) {
      steps.push({ name: 'Vision LLM', desc: 'Нейросеть для сложных сканов', active: true });
    }
    if (settings.ocr_engines?.yandex_vision?.enabled) {
      steps.push({ name: 'Yandex Vision', desc: 'Облачный OCR (резерв)', active: true, warn: true });
    }

    container.classList.remove('hidden');
    chain.innerHTML = steps.map((s, i) => `
      ${i > 0 ? '<span class="text-slate-400">→</span>' : ''}
      <span class="badge ${s.warn ? 'badge-amber' : 'badge-indigo'}" title="${escapeHtml(s.desc)}">
        ${escapeHtml(s.name)}
      </span>
    `).join('');
  }

  // Превью ожидаемых полей под выбранным типом
  document.getElementById('doc-type-select').addEventListener('change', (e) => {
    const slug = e.target.value;
    const preview = document.getElementById('expected-fields-preview');
    const list = document.getElementById('expected-fields-list');
    if (!slug) {
      preview.classList.add('hidden');
      return;
    }
    const type = availableTypes.find((t) => t.slug === slug);
    if (!type || !type.expected_fields || type.expected_fields.length === 0) {
      preview.classList.add('hidden');
      return;
    }
    list.innerHTML = type.expected_fields
      .map((f) => `<span class="chip">${escapeHtml(labelFor(f))}</span>`)
      .join('');
    preview.classList.remove('hidden');
  });

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const dropzoneText = document.getElementById('dropzone-text');
  const queueSection = document.getElementById('queue-section');
  const queueList = document.getElementById('queue-list');
  const queueCounter = document.getElementById('queue-counter');
  const startBtn = document.getElementById('start-btn');
  const clearDoneBtn = document.getElementById('clear-done-btn');
  const errEl = document.getElementById('upload-error');

  // Очередь: каждый item = { id, file, status, jobId?, error? }
  // status: 'queued' | 'uploading' | 'done' | 'failed'
  const queue = [];
  let nextId = 1;

  const ACCEPTED_EXT = /\.(pdf|jpg|jpeg|png|bmp|tif|tiff)$/i;

  function addFiles(files) {
    let added = 0;
    for (const f of files) {
      if (!ACCEPTED_EXT.test(f.name)) continue; // молча пропускаем .docx, .xlsx и пр.
      queue.push({ id: nextId++, file: f, status: 'queued' });
      added += 1;
    }
    if (added > 0) {
      queueSection.classList.remove('hidden');
      renderQueue();
    }
  }

  function renderQueue() {
    const total = queue.length;
    const done = queue.filter((q) => q.status === 'done' || q.status === 'processed' || q.status === 'needs_review').length;
    const failed = queue.filter((q) => q.status === 'failed').length;
    const inflight = queue.filter((q) => q.status === 'uploading' || q.status === 'processing').length;
    queueCounter.textContent = `(${total}: ${done} готово${failed ? `, ${failed} с ошибкой` : ''}${inflight ? `, ${inflight} в работе` : ''})`;

    queueList.innerHTML = queue.map((q) => {
      // Статус-бейдж: разные стадии жизненного цикла item'а в очереди.
      // queued → uploading → processing → processed | needs_review | failed
      const statusLabel = {
        queued: '<span class="badge badge-slate">в очереди</span>',
        uploading: '<span class="badge badge-indigo badge-pulse">загрузка</span>',
        processing: '<span class="badge badge-indigo badge-pulse">обработка</span>',
        processed: `<a href="#jobs/${escapeHtml(q.jobId ?? '')}" class="badge badge-emerald hover:underline">готово →</a>`,
        needs_review: `<a href="#jobs/${escapeHtml(q.jobId ?? '')}" class="badge badge-amber hover:underline">проверить →</a>`,
        done: `<a href="#jobs/${escapeHtml(q.jobId ?? '')}" class="badge badge-emerald hover:underline">готово →</a>`,
        failed: `<span class="badge badge-rose" title="${escapeHtml(q.error ?? '')}">ошибка</span>`,
      }[q.status];

      // Краткая сводка: тип + confidence + время обработки + список проблем.
      // Показывается только когда job завершён — не загромождает row пока идёт обработка.
      const summary = q.summary
        ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
            ${q.summary.document_type ? `<span class="font-mono">${escapeHtml(q.summary.document_type)}</span>` : ''}
            ${q.summary.confidence !== null && q.summary.confidence !== undefined
              ? `<span class="font-mono text-${q.summary.confidence >= 0.8 ? 'emerald' : q.summary.confidence >= 0.6 ? 'amber' : 'rose'}-600">${Math.round(q.summary.confidence * 100)}%</span>`
              : ''}
            ${q.summary.ocr_engine ? `<span class="text-slate-400">через ${escapeHtml(q.summary.ocr_engine)}</span>` : ''}
            ${q.summary.elapsed_ms ? `<span class="text-slate-400">${q.summary.elapsed_ms < 1000 ? `${q.summary.elapsed_ms} мс` : `${(q.summary.elapsed_ms / 1000).toFixed(1)} с`}</span>` : ''}
            ${q.summary.issues_count ? `<span class="text-amber-600">${q.summary.issues_count} замечан${q.summary.issues_count === 1 ? 'ие' : q.summary.issues_count < 5 ? 'ия' : 'ий'}</span>` : ''}
          </div>`
        : '';

      return `
        <div class="grid grid-cols-[1fr_9rem_4rem_2rem] gap-3 px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 last:border-b-0 items-start text-sm">
          <div class="min-w-0">
            <div class="truncate" title="${escapeHtml(q.file.name)}">${escapeHtml(q.file.name)}</div>
            ${summary}
          </div>
          <span class="pt-0.5">${statusLabel}</span>
          <span class="text-xs text-slate-500 font-mono tabular-nums pt-0.5">${(q.file.size / 1024).toFixed(0)} KB</span>
          ${q.status === 'queued'
            ? `<button class="text-slate-400 hover:text-rose-500 pt-0.5" data-remove-id="${q.id}" title="Убрать из очереди">×</button>`
            : '<span></span>'}
        </div>`;
    }).join('');

    queueList.querySelectorAll('[data-remove-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = Number(el.dataset.removeId);
        const idx = queue.findIndex((q) => q.id === id);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0) queueSection.classList.add('hidden');
        else renderQueue();
      });
    });

    clearDoneBtn.style.display = done + failed > 0 ? '' : 'none';
    const hasQueued = queue.some((q) => q.status === 'queued');
    startBtn.disabled = !hasQueued;
    startBtn.textContent = hasQueued ? `Загрузить (${queue.filter((q) => q.status === 'queued').length})` : 'Загрузить';
  }

  clearDoneBtn.addEventListener('click', () => {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].status === 'done' || queue[i].status === 'failed') queue.splice(i, 1);
    }
    if (queue.length === 0) queueSection.classList.add('hidden');
    else renderQueue();
  });

  // Чтение common-полей формы и валидация. Один раз перед стартом батча.
  function readCommonFields() {
    const formEl = document.getElementById('upload-form');
    const formData = new FormData(formEl);
    const hint = formData.get('document_hint')?.toString() ?? '';
    const webhook = formData.get('webhook_url')?.toString() ?? '';
    const metaText = formData.get('metadata')?.toString().trim() ?? '';
    if (metaText) {
      try { JSON.parse(metaText); }
      catch {
        return { error: 'Metadata: невалидный JSON' };
      }
    }
    return { hint, webhook, metaText };
  }

  // Параллельная очередь с ограничением — N worker-промисов разбирают
  // pending-items пока они есть. Каждый uploadOne обновляет UI через
  // renderQueue, так что батч можно наблюдать в реальном времени.
  //
  // После успешного POST /jobs запускаем фоновый polling статуса — оператор
  // видит реальный исход (тип/confidence/issues) прямо в очереди, не
  // переходя в job detail.
  async function uploadOne(item, common) {
    item.status = 'uploading';
    renderQueue();
    const startedAt = Date.now();
    const form = new FormData();
    form.append('file', item.file);
    if (common.hint) form.append('document_hint', common.hint);
    if (common.webhook) form.append('webhook_url', common.webhook);
    if (common.metaText) form.append('metadata', common.metaText);
    const ws = workspace.current;
    if (ws?.project_id) form.append('project_id', ws.project_id);
    if (ws?.organization_id) form.append('organization_id', ws.organization_id);

    try {
      const res = await api('/jobs', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      item.jobId = data.job_id;
      item.status = 'processing';
      renderQueue();
      // Фоновый polling — НЕ блокируем worker-loop, следующий файл идёт сразу
      void pollJobStatus(item, startedAt);
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
      renderQueue();
    }
  }

  /**
   * Опрашивает GET /jobs/:id до терминального статуса. Обновляет item.summary
   * для отображения краткого отчёта в очереди. Backoff: 1.5s → 5s через 30s.
   * Сдаёмся через 5 минут — large PDF может идти дольше, но в UI вечно не висим.
   */
  async function pollJobStatus(item, startedAt) {
    const deadline = startedAt + 5 * 60 * 1000;
    let interval = 1500;
    while (Date.now() < deadline) {
      try {
        const job = await apiJson(`/jobs/${encodeURIComponent(item.jobId)}`);
        if (job.status === 'done' || job.status === 'needs_review' || job.status === 'failed') {
          item.summary = {
            document_type: job.document_type,
            confidence: job.confidence,
            ocr_engine: job.ocr_engine,
            elapsed_ms: Date.now() - startedAt,
            issues_count: (job.validation_issues ?? []).length,
            error: job.error,
          };
          item.status = job.status === 'failed' ? 'failed' : job.status;
          if (job.status === 'failed') item.error = job.error ?? 'неизвестная ошибка';
          renderQueue();
          return;
        }
      } catch (err) {
        // 401/network — прерываем polling, оператор увидит "processing" пока
        // не перезагрузит. Не падаем шумно — это всё ещё лучше чем alert.
        console.warn('poll error:', err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, interval));
      if (Date.now() - startedAt > 30_000) interval = 5000;
    }
    // Timeout — оставляем processing, оператор может зайти в job detail
  }

  startBtn.addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const common = readCommonFields();
    if (common.error) {
      errEl.textContent = common.error;
      errEl.classList.remove('hidden');
      return;
    }
    const pending = queue.filter((q) => q.status === 'queued');
    if (pending.length === 0) return;
    startBtn.disabled = true;

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const idx = cursor++;
        await uploadOne(pending[idx], common);
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    startBtn.disabled = false;
    renderQueue();
  });

  // Dropzone — file picker + drag&drop. У <input multiple> — массив files.
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      addFiles(Array.from(fileInput.files));
      fileInput.value = ''; // позволяем повторно выбрать те же файлы
    }
  });
  ['dragenter', 'dragover'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
  });
  // Папка: e.dataTransfer.items → entry.isDirectory → рекурсивный обход.
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const items = e.dataTransfer?.items;
    if (items && items.length > 0 && items[0].webkitGetAsEntry) {
      const collected = [];
      const promises = [];
      for (const it of items) {
        const entry = it.webkitGetAsEntry?.();
        if (entry) promises.push(readEntryRecursive(entry, collected));
      }
      await Promise.all(promises);
      addFiles(collected);
    } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      // fallback — браузер не дал items API, берём files как плоский список
      addFiles(Array.from(e.dataTransfer.files));
    }
  });
}

/** Рекурсивный обход dropped entry: одиночный файл или директория. */
async function readEntryRecursive(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries returns batches; читаем пока пусто
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const sub of batch) await readEntryRecursive(sub, out);
    } while (batch.length > 0);
  }
}

// ============================================================
// Review Queue (CP6) — очередь needs_review для оператора
// ============================================================
//
// Фокусированный вид: только задачи в статусе needs_review.
// Для каждой — ключевые данные + кнопка «Одобрить» (approve без
// изменения extracted) + ссылка в полный detail для корректировки.
// Автообновление каждые 15 секунд.

async function renderReviewQueue() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Review queue',
        subtitle: 'Задачи, которые требуют проверки оператора. Одобрите корректные или откройте для редактирования.',
        actions: `<button id="rq-refresh" class="btn-secondary btn-md" title="Обновить">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/></svg>
          Обновить
        </button>`,
      })}
      <div id="rq-list">${loadingState()}</div>
    </div>
  `);

  let pollTimer = null;

  async function load() {
    try {
      const data = await apiJson('/jobs?status=needs_review&limit=100');
      renderList(data.items ?? []);
    } catch (err) {
      document.getElementById('rq-list').innerHTML = errorState(err.message);
    }
  }

  function renderList(items) {
    const root = document.getElementById('rq-list');
    if (!root) return;
    if (items.length === 0) {
      root.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-12 h-12 text-emerald-500 mx-auto mb-3"><path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clip-rule="evenodd"/></svg>
          <p class="empty-state-text">Очередь пуста — всё проверено!</p>
          <a href="#jobs" class="empty-state-cta">Посмотреть все задачи →</a>
        </div>`;
      return;
    }

    root.innerHTML = `
      <div class="space-y-3" id="rq-items">
        ${items.map((j) => renderReviewItem(j)).join('')}
      </div>
      <p class="text-xs text-slate-400 text-right mt-3">Всего: ${items.length} задач</p>
    `;

    root.querySelectorAll('[data-approve-id]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.approveId;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await apiJson(`/jobs/${encodeURIComponent(id)}/approve`, { method: 'POST' });
          // Убираем строку из DOM сразу — не ждём перезагрузки.
          const card = root.querySelector(`[data-rq-job-id="${id}"]`);
          if (card) card.remove();
          // Обновляем счётчик
          const remaining = root.querySelectorAll('[data-rq-job-id]').length;
          const countEl = root.querySelector('p.text-xs');
          if (countEl) countEl.textContent = `Всего: ${remaining} задач`;
          if (remaining === 0) load(); // покажем empty state
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '✓';
          alert(`Ошибка: ${err.message}`);
        }
      });
    });

    root.querySelectorAll('[data-rq-job-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-approve-id]')) return; // approve btn handled above
        location.hash = `#jobs/${card.dataset.rqJobId}`;
      });
    });
  }

  function renderReviewItem(j) {
    const issues = j.validation_issues ?? [];
    const extracted = j.extracted ?? {};
    const topFields = Object.entries(extracted)
      .filter(([k]) => !k.startsWith('_'))
      .slice(0, 5);

    return `
      <div class="card card-body row-clickable cursor-pointer" data-rq-job-id="${escapeHtml(j.job_id)}">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap mb-1">
              ${badge(j.status)}
              ${j.document_type ? `<span class="font-mono text-xs text-slate-600 dark:text-slate-400">${escapeHtml(j.document_type)}</span>` : ''}
              ${issues.length > 0 ? `<span class="badge badge-rose">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="font-medium text-sm truncate" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</div>
            <div class="mt-0.5 text-xs text-slate-400 font-mono">${escapeHtml(j.job_id.slice(0, 8))} · ${escapeHtml(relativeTime(j.created_at))}</div>
            ${topFields.length > 0 ? `
              <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                ${topFields.map(([k, v]) => `
                  <span class="text-xs"><span class="text-slate-400">${escapeHtml(k)}:</span> <span class="font-mono text-slate-700 dark:text-slate-300">${escapeHtml(String(v ?? ''))}</span></span>
                `).join('')}
              </div>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${confidenceBar(j.confidence)}
            <button data-approve-id="${escapeHtml(j.job_id)}"
              class="btn-success btn-sm whitespace-nowrap" title="Одобрить: перевести в done без изменений">✓ Одобрить</button>
          </div>
        </div>
        ${issues.length > 0 ? `
          <div class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <ul class="space-y-0.5">
              ${issues.slice(0, 3).map((i) => `<li class="text-xs font-mono text-amber-700 dark:text-amber-400">• ${escapeHtml(i)}</li>`).join('')}
              ${issues.length > 3 ? `<li class="text-xs text-slate-400">… ещё ${issues.length - 3}</li>` : ''}
            </ul>
          </div>` : ''}
      </div>
    `;
  }

  document.getElementById('rq-refresh')?.addEventListener('click', load);

  await load();
  pollTimer = setInterval(load, 15_000);
  registerCleanup(() => { clearInterval(pollTimer); });
}

// ============================================================
// Document types
// ============================================================

async function renderDocumentTypesList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Document types',
        subtitle: 'Конфигурация типов документов: парсеры, поля, инструкции для агента, валидаторы',
        actions: `<a href="#document-types/new" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          Новый тип
        </a>`,
      })}

      <div class="info-banner mb-4">
        Каждый тип — slug + parser_kind + ожидаемые поля + инструкция для LLM + валидаторы. Editor сохраняет изменения в БД и сбрасывает кэш — следующие job'ы подхватят правки без рестарта.
      </div>

      <div id="dt-list" class="card overflow-hidden">${loadingState()}</div>
    </div>
  `);

  let data;
  try {
    data = await apiJson('/document-types');
  } catch (err) {
    document.getElementById('dt-list').innerHTML = errorState(err.message);
    return;
  }

  if (!data.items.length) {
    document.getElementById('dt-list').innerHTML = `
      <div class="empty-state">
        <p class="empty-state-text">Реестр пустой.</p>
        <p class="text-xs text-slate-400 mt-1">Запусти миграции: <code class="font-mono">npm run migrate</code></p>
      </div>`;
    return;
  }

  const rows = data.items.map((t) => {
    const flags = [
      t.is_builtin ? '<span class="badge badge-emerald">builtin</span>' : '',
      !t.is_active ? '<span class="badge badge-slate">inactive</span>' : '',
    ].filter(Boolean).join(' ');
    const conf = t.confidence_threshold !== null
      ? `<span class="font-mono">${t.confidence_threshold.toFixed(2)}</span>`
      : '<span class="text-slate-400 text-xs">default</span>';
    return `
      <tr class="row-clickable" data-slug="${escapeHtml(t.slug)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(t.slug)}</td>
        <td class="font-medium">${escapeHtml(t.display_name)}</td>
        <td>${parserKindBadge(t.parser_kind)}</td>
        <td>${conf}</td>
        <td class="text-xs">${t.expected_fields.length} fields</td>
        <td class="text-xs">${t.validators.length} validators</td>
        <td class="flex gap-1 flex-wrap">${flags || '<span class="text-slate-300 dark:text-slate-600">—</span>'}</td>
      </tr>`;
  }).join('');

  document.getElementById('dt-list').innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Slug</th><th>Display name</th><th>Parser</th><th>Confidence</th><th>Fields</th><th>Validators</th><th>Flags</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.querySelectorAll('[data-slug]').forEach((row) => {
    row.addEventListener('click', () => { location.hash = `#document-types/${row.dataset.slug}`; });
  });
}

/**
 * Document type editor — used for both "edit existing" (slug=string) and
 * "create new" (slug=null). State lives in a plain JS object that mirrors
 * the API shape; the form re-renders chip lists imperatively when items
 * are added/removed, but text inputs are bound by id and read at save time.
 */
async function renderDocumentTypeEditor(slug) {
  const isCreate = slug === null;
  setView(`
    <div class="page-narrow">
      ${backLink('#document-types')}
      <div id="dt-editor" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  // --- Load existing or seed empty ---
  let t;
  if (isCreate) {
    t = {
      slug: '',
      display_name: '',
      description: '',
      is_active: true,
      is_builtin: false,
      parser_kind: 'llm_extract',
      llm_prompt: '',
      llm_schema: null,
      expected_fields: [],
      validators: [],
      confidence_threshold: null,
      regex_fallback_threshold: null,
      classification_keywords: [],
      metadata: null,
      created_at: null,
      updated_at: null,
    };
  } else {
    try {
      t = await apiJson(`/document-types/${encodeURIComponent(slug)}`);
    } catch (err) {
      document.getElementById('dt-editor').innerHTML = errorState(err.message);
      return;
    }
  }

  // --- State held outside DOM so chip add/remove is easy ---
  const state = {
    expected_fields: [...t.expected_fields],
    validators: [...t.validators],
    classification_keywords: [...t.classification_keywords],
  };

  const root = document.getElementById('dt-editor');
  root.innerHTML = renderEditorForm(t, isCreate);
  bindEditorHandlers(t, isCreate, state, root);

  // Для существующих типов — асинхронно подгрузить статистику и список
  // последних jobs, чтобы пользователь сразу видел реальное качество
  // обработки. Без блокировки editor'а — рендерится поверх через
  // отдельные DOM-узлы.
  if (!isCreate) {
    void loadTypeObservations(slug);
  }
}

/**
 * Подгружает /document-types/:slug/stats и /jobs и врендеривает их
 * в две panel'и: "Recent jobs" (последние 20 jobs этого типа со
 * статусом + confidence) и "Field coverage" (% jobs где каждое
 * expected_field фактически заполнено).
 *
 * Идея: после правки prompt'а или схемы открыл страницу типа и сразу
 * видишь как изменилось покрытие полей по новым jobs.
 */
async function loadTypeObservations(slug) {
  const obsRoot = document.getElementById('dt-observations');
  if (!obsRoot) return;

  obsRoot.innerHTML = `
    <div class="card card-body">${loadingState()}</div>
    <div class="card card-body">${loadingState()}</div>
  `;

  let stats, jobs;
  try {
    [stats, jobs] = await Promise.all([
      apiJson(`/document-types/${encodeURIComponent(slug)}/stats?days=30`),
      apiJson(`/document-types/${encodeURIComponent(slug)}/jobs?limit=20`),
    ]);
  } catch (err) {
    obsRoot.innerHTML = errorState(err.message);
    return;
  }

  obsRoot.innerHTML = `
    ${renderCoveragePanel(stats)}
    ${renderRecentJobsPanel(jobs.items)}
  `;

  obsRoot.querySelectorAll('[data-recent-job-id]').forEach((el) => {
    el.addEventListener('click', () => {
      location.hash = `#jobs/${el.dataset.recentJobId}`;
    });
  });
}

function renderCoveragePanel(stats) {
  const breakdown = stats.terminal_breakdown;
  const total = stats.total_jobs;
  const reviewPct = total === 0 ? 0 : Math.round((breakdown.needs_review / total) * 100);
  const failedPct = total === 0 ? 0 : Math.round((breakdown.failed / total) * 100);
  const donePct = total === 0 ? 0 : Math.round((breakdown.done / total) * 100);
  const avgConfLabel = stats.avg_confidence === null
    ? '—'
    : `${Math.round(stats.avg_confidence * 100)}%`;

  const coverageRows = (stats.expected_fields_coverage || []).map((c) => {
    const pct = Math.round(c.filled_pct * 100);
    const colorClass =
      pct >= 80 ? 'bg-emerald-500' :
      pct >= 50 ? 'bg-amber-500' :
      'bg-rose-500';
    return `
      <div class="grid grid-cols-[10rem_1fr_3.5rem] gap-3 items-center py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
        <span class="font-mono text-xs">${escapeHtml(c.field)}</span>
        <div class="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div class="h-full ${colorClass}" style="width:${pct}%"></div>
        </div>
        <span class="text-xs font-mono tabular-nums text-right text-slate-600 dark:text-slate-400">${pct}% <span class="text-slate-400">(${c.filled}/${c.total})</span></span>
      </div>`;
  }).join('');

  return `
    <div class="card card-body">
      <h3 class="card-title mb-1">Field coverage <span class="text-sm font-normal text-slate-500">за последние ${stats.period_days} дней</span></h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Для каждого <code class="font-mono">expected_field</code> — в скольких jobs это поле фактически
        заполнено в <code class="font-mono">extracted</code>. Это и есть «соответствие API»: если поле
        в схеме обещано, а извлекается в 60% случаев — promt или схему надо тюнить.
      </p>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Всего</div>
          <div class="text-xl font-semibold mt-1">${stats.total_jobs}</div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Done</div>
          <div class="text-xl font-semibold mt-1 text-emerald-600 dark:text-emerald-400">${donePct}% <span class="text-xs text-slate-400">(${breakdown.done})</span></div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Review</div>
          <div class="text-xl font-semibold mt-1 text-amber-600 dark:text-amber-400">${reviewPct}% <span class="text-xs text-slate-400">(${breakdown.needs_review})</span></div>
        </div>
        <div class="card-body bg-slate-50 dark:bg-slate-950 rounded-lg p-3">
          <div class="text-xs text-slate-500 uppercase tracking-wide">Avg confidence</div>
          <div class="text-xl font-semibold mt-1">${avgConfLabel}</div>
        </div>
      </div>

      ${coverageRows
        ? `<div class="border-t border-slate-200 dark:border-slate-800 pt-3">${coverageRows}</div>`
        : '<p class="text-sm text-slate-400">expected_fields не заданы — добавьте в редакторе сверху чтобы измерять покрытие.</p>'}

      ${failedPct > 0
        ? `<div class="warning-banner mt-3 text-xs">${failedPct}% jobs упали со статусом <code class="font-mono">failed</code> — проверьте логи воркера.</div>`
        : ''}
    </div>`;
}

function renderRecentJobsPanel(items) {
  if (items.length === 0) {
    return `
      <div class="card card-body">
        <h3 class="card-title mb-2">Последние документы</h3>
        <p class="text-sm text-slate-400">Пока ни одного job этого типа. Загрузите документ через <a href="#upload" class="text-indigo-600 hover:underline">Upload</a>.</p>
      </div>`;
  }
  const rows = items.map((j) => {
    const issuesBadge = (j.validation_issues?.length ?? 0) > 0
      ? `<span class="badge badge-amber text-[10px]">${j.validation_issues.length} issues</span>`
      : '';
    return `
      <tr class="row-clickable" data-recent-job-id="${escapeHtml(j.job_id)}">
        <td class="font-mono text-xs text-slate-500">${escapeHtml(j.job_id.slice(0, 8))}</td>
        <td>${badge(j.status)}</td>
        <td class="truncate max-w-[14rem]" title="${escapeHtml(j.file_name)}">${escapeHtml(j.file_name)}</td>
        <td>${confidenceBar(j.confidence)}</td>
        <td>${issuesBadge}</td>
        <td class="text-xs text-slate-500" title="${escapeHtml(j.created_at)}">${escapeHtml(relativeTime(j.created_at))}</td>
      </tr>`;
  }).join('');
  return `
    <div class="card overflow-hidden">
      <div class="card-header">
        <h3 class="card-title">Последние документы <span class="text-sm font-normal text-slate-500">(${items.length})</span></h3>
        <a href="#jobs" class="btn-ghost btn-xs">все →</a>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>ID</th><th>Status</th><th>File</th><th>Confidence</th><th>Issues</th><th>Created</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderEditorForm(t, isCreate) {
  const headerBadges = [
    !isCreate && t.is_builtin ? '<span class="badge badge-emerald">builtin</span>' : '',
    !isCreate && !t.is_active ? '<span class="badge badge-slate">inactive</span>' : '',
    isCreate ? '<span class="badge badge-indigo">new</span>' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="card card-body-lg">
      <div class="flex items-center gap-2 mb-2 flex-wrap">${headerBadges}</div>
      <h2 class="text-xl font-semibold">${isCreate ? 'Новый тип документа' : escapeHtml(t.display_name)}</h2>
      ${isCreate ? '' : `<div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(t.slug)}</div>`}
    </div>

    <!-- Basics -->
    <div class="card card-body space-y-4">
      <h3 class="card-title">Основное</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">Slug <span class="text-rose-500">*</span></label>
          <input id="f-slug" type="text" value="${escapeHtml(t.slug)}" ${isCreate ? '' : 'disabled'}
            placeholder="commercial_invoice"
            class="form-input font-mono" />
          <p class="form-help">${isCreate
            ? 'Уникальный ID. Только [A-Za-z0-9_-], не меняется после создания.'
            : 'Slug нельзя изменить — пересоздай тип, если нужно переименовать.'}</p>
        </div>
        <div class="form-row">
          <label class="form-label">Display name <span class="text-rose-500">*</span></label>
          <input id="f-display_name" type="text" value="${escapeHtml(t.display_name)}"
            placeholder="Коммерческий инвойс" class="form-input" />
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Описание</label>
        <textarea id="f-description" rows="2" class="form-textarea" style="font-family: inherit;"
          placeholder="Короткое описание для оператора.">${escapeHtml(t.description || '')}</textarea>
      </div>
      <div class="flex items-center gap-6">
        <label class="inline-flex items-center gap-2">
          <input id="f-is_active" type="checkbox" ${t.is_active ? 'checked' : ''}
            class="rounded border-slate-300 dark:border-slate-700" />
          <span class="text-sm">Активен (классификатор и dropdown'ы включают этот тип)</span>
        </label>
      </div>
    </div>

    <!-- Parser kind -->
    <div class="card card-body space-y-4">
      <h3 class="card-title">Парсер</h3>
      <div class="form-row">
        <label class="form-label">parser_kind</label>
        <select id="f-parser_kind" class="form-select">
          <option value="builtin:invoice_regex" ${t.parser_kind === 'builtin:invoice_regex' ? 'selected' : ''}>builtin:invoice_regex — regex для счёта на оплату</option>
          <option value="builtin:upd_regex" ${t.parser_kind === 'builtin:upd_regex' ? 'selected' : ''}>builtin:upd_regex — regex для УПД / СФ</option>
          <option value="llm_extract" ${t.parser_kind === 'llm_extract' ? 'selected' : ''}>llm_extract — целиком через LLM /v1/extract</option>
        </select>
        <p class="form-help">Builtin'ы используют свои regex'ы + LLM-fallback при низкой уверенности. <code class="font-mono">llm_extract</code> сразу идёт в LLM.</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">confidence_threshold</label>
          <input id="f-confidence_threshold" type="number" min="0" max="1" step="0.05"
            value="${t.confidence_threshold ?? ''}" placeholder="0.6 (env default)" class="form-input font-mono" />
          <p class="form-help">Ниже этого — статус <code class="font-mono">needs_review</code>. Пусто = брать из env.</p>
        </div>
        <div class="form-row">
          <label class="form-label">regex_fallback_threshold</label>
          <input id="f-regex_fallback_threshold" type="number" min="0" max="1" step="0.05"
            value="${t.regex_fallback_threshold ?? ''}" placeholder="0.7" class="form-input font-mono" />
          <p class="form-help">Только для builtin-парсеров. Ниже этого — regex отдаёт ход LLM.</p>
        </div>
      </div>
    </div>

    <!-- Expected fields -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Ожидаемые поля</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">Парсер обязан попытаться извлечь эти поля. Что не нашлось → попадает в <code class="font-mono">missing</code>.</p>
      ${renderChipsInput('expected_fields', 'добавить поле и Enter', 'number, date, total, seller.inn, ...')}
    </div>

    <!-- Validators -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Валидаторы</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Формат: <code class="font-mono">name</code> или <code class="font-mono">name:arg1,arg2</code>. Доступные:
        <code class="font-mono text-xs">inn_checksum</code>, <code class="font-mono text-xs">kpp_format</code>,
        <code class="font-mono text-xs">vehicle_plate</code>, <code class="font-mono text-xs">country_code</code>,
        <code class="font-mono text-xs">date_range</code>, <code class="font-mono text-xs">money_sanity</code>,
        <code class="font-mono text-xs">vat_consistency</code>, <code class="font-mono text-xs">parties_differ</code>,
        <code class="font-mono text-xs">weight_nett_le_gross</code>.
      </p>
      ${renderChipsInput('validators', 'добавить валидатор и Enter', 'inn_checksum:seller.inn')}
    </div>

    <!-- Classification keywords -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Ключи классификатора</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">Регулярки. Если совпали с текстом OCR — классификатор присваивает этот тип. Без подсказки <code class="font-mono">document_hint</code> от клиента.</p>
      ${renderChipsInput('classification_keywords', 'добавить regex и Enter', '\\bсч[её]т-фактура\\b')}
    </div>

    <!-- Agent instruction (llm_prompt) -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">Инструкция для LLM-агента</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">
        Что показывать модели вместе с текстом документа. <strong>Активно</strong> —
        runtime пробрасывает её в inference-service на каждый <code class="font-mono">/v1/extract</code>,
        backend подменяет ею встроенный prompt. Технический контракт ответа (валидный JSON
        c полями <code class="font-mono">extracted / confidence / issues</code>) добавляется
        автоматически — пишите только продуктовую часть.
        Пусто = builtin prompt для типа.
      </p>
      <textarea id="f-llm_prompt" rows="8" class="code-editor"
        placeholder="Ты — парсер транспортной накладной. Извлеки поля строго по JSON Schema. Все суммы — числами. ИНН — 10 или 12 цифр.">${escapeHtml(t.llm_prompt || '')}</textarea>
    </div>

    <!-- LLM schema -->
    <div class="card card-body space-y-2">
      <h3 class="card-title">JSON Schema для /extract</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400">JSON-схема, по которой LLM должна вернуть структуру. Пусто = builtin-схема из <code class="font-mono">document-json-schemas.ts</code>.</p>
      <textarea id="f-llm_schema" rows="14" class="code-editor"
        placeholder='{"type":"object","properties":{"number":{"type":"string"}, ...}}'>${t.llm_schema ? escapeHtml(JSON.stringify(t.llm_schema, null, 2)) : ''}</textarea>
      <p id="f-llm_schema-error" class="form-error hidden"></p>
    </div>

    <!-- Observations: загружается асинхронно для существующих типов -->
    ${!isCreate ? `<div id="dt-observations" class="space-y-4"></div>` : ''}

    <!-- Bookkeeping + actions -->
    ${!isCreate ? `
      <div class="card card-body">
        <h3 class="card-title mb-3">Bookkeeping</h3>
        <dl class="kv">
          <div class="kv-row"><dt class="kv-key">Created</dt><dd class="kv-value">${escapeHtml(t.created_at || '—')}</dd></div>
          <div class="kv-row"><dt class="kv-key">Updated</dt><dd class="kv-value">${escapeHtml(t.updated_at || '—')}</dd></div>
        </dl>
      </div>` : ''}

    <p id="editor-error" class="form-error hidden"></p>

    <div class="flex items-center justify-between gap-2 sticky bottom-0 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm py-3 -mx-8 px-8 border-t border-slate-200 dark:border-slate-800">
      <div>
        ${!isCreate && !t.is_builtin ? `<button id="delete-btn" class="btn-danger btn-md">Удалить</button>` : ''}
        ${!isCreate && t.is_builtin ? `<span class="text-xs text-slate-500">builtin-типы нельзя удалить, можно деактивировать.</span>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <a href="#audit-log" class="btn-ghost btn-sm">История</a>
        <a href="#document-types" class="btn-secondary btn-md">Отмена</a>
        <button id="save-btn" class="btn-primary btn-md">${isCreate ? 'Создать' : 'Сохранить'}</button>
      </div>
    </div>
  `;
}

/**
 * Render a chip-input block. The actual chip rendering is dynamic — done
 * in `redrawChips()` after creation so add/remove updates the DOM without
 * a full form re-render.
 */
function renderChipsInput(field, placeholder, exampleValue) {
  return `
    <div id="chips-${field}" class="chip-input"></div>
    <input id="chips-${field}-add" type="text" placeholder="${escapeHtml(placeholder)} (пример: ${escapeHtml(exampleValue)})"
      class="form-input font-mono text-xs" />`;
}

function bindEditorHandlers(originalRow, isCreate, state, root) {
  const redrawChips = (field) => {
    const container = root.querySelector(`#chips-${field}`);
    if (!container) return;
    if (state[field].length === 0) {
      container.innerHTML = `<span class="text-xs text-slate-400 px-1 py-0.5">—</span>`;
      return;
    }
    container.innerHTML = state[field].map((value, idx) => `
      <span class="chip">
        ${escapeHtml(value)}
        <span class="chip-remove" data-remove="${field}" data-idx="${idx}" title="Удалить">×</span>
      </span>`).join('');
    container.querySelectorAll('[data-remove]').forEach((el) => {
      el.addEventListener('click', () => {
        const f = el.dataset.remove;
        const i = Number(el.dataset.idx);
        state[f].splice(i, 1);
        redrawChips(f);
      });
    });
  };

  ['expected_fields', 'validators', 'classification_keywords'].forEach((field) => {
    redrawChips(field);
    const addInput = root.querySelector(`#chips-${field}-add`);
    if (!addInput) return;
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = addInput.value.trim();
        if (v && !state[field].includes(v)) {
          state[field].push(v);
          redrawChips(field);
        }
        addInput.value = '';
      }
    });
  });

  // Delete button
  const delBtn = root.querySelector('#delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Удалить тип "${originalRow.slug}"? Это необратимо.`)) return;
      try {
        const res = await api(`/document-types/${encodeURIComponent(originalRow.slug)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          const t = await res.text();
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
        }
        location.hash = '#document-types';
      } catch (err) {
        showEditorError(root, err.message);
      }
    });
  }

  // Save / Create
  root.querySelector('#save-btn').addEventListener('click', async () => {
    const errEl = root.querySelector('#editor-error');
    errEl.classList.add('hidden');
    const schemaErrEl = root.querySelector('#f-llm_schema-error');
    schemaErrEl.classList.add('hidden');

    // Parse JSON-schema textarea (empty = null = use builtin)
    const schemaRaw = root.querySelector('#f-llm_schema').value.trim();
    let schema = null;
    if (schemaRaw) {
      try {
        schema = JSON.parse(schemaRaw);
      } catch (err) {
        schemaErrEl.textContent = `JSON Schema: невалидный JSON — ${err.message}`;
        schemaErrEl.classList.remove('hidden');
        return;
      }
    }

    const promptRaw = root.querySelector('#f-llm_prompt').value;
    const confRaw = root.querySelector('#f-confidence_threshold').value;
    const regexThrRaw = root.querySelector('#f-regex_fallback_threshold').value;

    const payload = {
      display_name: root.querySelector('#f-display_name').value.trim(),
      description: root.querySelector('#f-description').value.trim() || null,
      is_active: root.querySelector('#f-is_active').checked,
      parser_kind: root.querySelector('#f-parser_kind').value,
      llm_prompt: promptRaw.trim() || null,
      llm_schema: schema,
      expected_fields: [...state.expected_fields],
      validators: [...state.validators],
      confidence_threshold: confRaw === '' ? null : Number(confRaw),
      regex_fallback_threshold: regexThrRaw === '' ? null : Number(regexThrRaw),
      classification_keywords: [...state.classification_keywords],
    };

    try {
      if (isCreate) {
        const slug = root.querySelector('#f-slug').value.trim();
        if (!slug) throw new Error('slug обязателен');
        if (!payload.display_name) throw new Error('display_name обязателен');
        const data = await apiJson('/document-types', {
          method: 'POST',
          body: JSON.stringify({ slug, ...payload }),
        });
        location.hash = `#document-types/${data.slug}`;
      } else {
        await apiJson(`/document-types/${encodeURIComponent(originalRow.slug)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        // Stay on the same page to confirm save visually
        flashSave(root);
      }
    } catch (err) {
      showEditorError(root, err.message);
    }
  });
}

function showEditorError(root, message) {
  const el = root.querySelector('#editor-error');
  el.textContent = message;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function flashSave(root) {
  const btn = root.querySelector('#save-btn');
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = 'Сохранено ✓';
  btn.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
  btn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-700');
    btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
  }, 1200);
}

// ============================================================
// Providers (LLM keys + OCR engines)
// ============================================================

const PROVIDER_KIND_BADGE = {
  llm: { label: 'LLM', variant: 'badge-violet' },
  ocr: { label: 'OCR', variant: 'badge-sky' },
};

async function renderProvidersList() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Providers',
        subtitle: 'API-ключи и endpoint-ы для LLM (Anthropic, OpenAI, локальные) и OCR (Tesseract, Yandex)',
        actions: `<a href="#providers/new" class="btn-primary btn-md">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4"><path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/></svg>
          Новый
        </a>`,
      })}

      <div class="info-banner mb-4">
        Ключи шифруются (AES-256-GCM) перед записью в БД и расшифровываются мастер-ключом из <code class="font-mono">SECRETS_ENCRYPTION_KEY</code> только в момент использования. В API возвращается только маска <code class="font-mono">••••XXXX</code>. Активный по умолчанию для каждого kind помечается флагом <strong>default</strong>. Изменения подхватываются hot-path'ом без рестарта (TTL 30s).
      </div>

      <div id="providers-list" class="space-y-3">${loadingState()}</div>
    </div>
  `);

  let data;
  try {
    data = await apiJson('/provider-settings');
  } catch (err) {
    document.getElementById('providers-list').innerHTML = errorState(err.message);
    return;
  }

  if (!data.items.length) {
    document.getElementById('providers-list').innerHTML = `
      <div class="card empty-state">
        <p class="empty-state-text">Провайдеров пока нет.</p>
        <a href="#providers/new" class="empty-state-cta">Добавить первый →</a>
      </div>`;
    return;
  }

  // Group by kind for clearer reading
  const byKind = { llm: [], ocr: [] };
  data.items.forEach((p) => {
    if (byKind[p.kind]) byKind[p.kind].push(p);
  });

  const renderRow = (p) => `
    <div class="card card-body cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30 transition" data-id="${escapeHtml(p.id)}">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="font-medium">${escapeHtml(p.display_name)}</span>
            <span class="badge ${PROVIDER_KIND_BADGE[p.kind]?.variant ?? 'badge-slate'}">${PROVIDER_KIND_BADGE[p.kind]?.label ?? p.kind}</span>
            ${p.is_default ? '<span class="badge badge-indigo">default</span>' : ''}
            ${!p.is_active ? '<span class="badge badge-slate">inactive</span>' : ''}
            ${p.has_api_key ? '<span class="badge badge-emerald">key set</span>' : '<span class="badge badge-rose">no key</span>'}
          </div>
          <div class="font-mono text-xs text-slate-500">${escapeHtml(p.id)}</div>
          ${p.description ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-2">${escapeHtml(p.description)}</div>` : ''}
        </div>
        <div class="text-right shrink-0 space-y-1">
          ${p.model ? `<div class="text-xs font-mono text-slate-400">${escapeHtml(p.model)}</div>` : ''}
          ${p.base_url ? `<div class="text-xs font-mono text-slate-400 truncate max-w-[14rem]" title="${escapeHtml(p.base_url)}">${escapeHtml(p.base_url)}</div>` : ''}
          ${p.api_key_masked ? `<div class="text-xs font-mono text-slate-400">key: ${escapeHtml(p.api_key_masked)}</div>` : ''}
        </div>
      </div>
    </div>`;

  document.getElementById('providers-list').innerHTML = `
    <div class="card card-body">
      <h3 class="card-title mb-3">LLM провайдеры <span class="text-sm font-normal text-slate-500">(${byKind.llm.length})</span></h3>
      <div class="space-y-2">
        ${byKind.llm.length ? byKind.llm.map(renderRow).join('') : '<p class="text-sm text-slate-400">— нет</p>'}
      </div>
    </div>
    <div class="card card-body">
      <h3 class="card-title mb-3">OCR движки <span class="text-sm font-normal text-slate-500">(${byKind.ocr.length})</span></h3>
      <div class="space-y-2">
        ${byKind.ocr.length ? byKind.ocr.map(renderRow).join('') : '<p class="text-sm text-slate-400">— нет</p>'}
      </div>
    </div>
  `;

  document.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = `#providers/${row.dataset.id}`;
    });
  });
}

async function renderProviderEditor(id) {
  const isCreate = id === null;
  setView(`
    <div class="page-narrow">
      ${backLink('#providers')}
      <div id="prov-editor" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let p;
  if (isCreate) {
    p = {
      id: '',
      kind: 'llm',
      display_name: '',
      description: '',
      base_url: '',
      api_key_masked: null,
      has_api_key: false,
      model: '',
      is_active: true,
      is_default: false,
      extra: null,
      created_at: null,
      updated_at: null,
    };
  } else {
    try {
      p = await apiJson(`/provider-settings/${encodeURIComponent(id)}`);
    } catch (err) {
      document.getElementById('prov-editor').innerHTML = errorState(err.message);
      return;
    }
  }

  const root = document.getElementById('prov-editor');
  root.innerHTML = renderProviderForm(p, isCreate);
  bindProviderHandlers(p, isCreate, root);
}

function renderProviderForm(p, isCreate) {
  const headerBadges = [
    p.is_default ? '<span class="badge badge-indigo">default</span>' : '',
    p.has_api_key ? '<span class="badge badge-emerald">key set</span>' : '',
    !p.is_active && !isCreate ? '<span class="badge badge-slate">inactive</span>' : '',
    isCreate ? '<span class="badge badge-indigo">new</span>' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="card card-body-lg">
      <div class="flex items-center gap-2 mb-2 flex-wrap">${headerBadges}</div>
      <h2 class="text-xl font-semibold">${isCreate ? 'Новый провайдер' : escapeHtml(p.display_name)}</h2>
      ${isCreate ? '' : `<div class="mt-1 font-mono text-xs text-slate-500">${escapeHtml(p.id)}</div>`}
    </div>

    <div class="card card-body space-y-4">
      <h3 class="card-title">Идентификация</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-row">
          <label class="form-label">ID <span class="text-rose-500">*</span></label>
          <input id="f-id" type="text" value="${escapeHtml(p.id)}" ${isCreate ? '' : 'disabled'}
            placeholder="anthropic" class="form-input font-mono" />
          <p class="form-help">${isCreate ? 'Lowercase, только [a-z0-9_-].' : 'ID нельзя изменить — пересоздай если нужно.'}</p>
        </div>
        <div class="form-row">
          <label class="form-label">Kind</label>
          <select id="f-kind" class="form-select" ${isCreate ? '' : 'disabled'}>
            <option value="llm" ${p.kind === 'llm' ? 'selected' : ''}>llm — LLM провайдер</option>
            <option value="ocr" ${p.kind === 'ocr' ? 'selected' : ''}>ocr — OCR движок</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">Display name <span class="text-rose-500">*</span></label>
        <input id="f-display_name" type="text" value="${escapeHtml(p.display_name)}"
          placeholder="Anthropic Claude" class="form-input" />
      </div>
      <div class="form-row">
        <label class="form-label">Описание</label>
        <textarea id="f-description" rows="2" class="form-textarea" style="font-family: inherit;">${escapeHtml(p.description || '')}</textarea>
      </div>
      <label class="inline-flex items-center gap-2">
        <input id="f-is_active" type="checkbox" ${p.is_active ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-700" />
        <span class="text-sm">Активен</span>
      </label>
    </div>

    <div class="card card-body space-y-4">
      <h3 class="card-title">Connection</h3>
      <div class="form-row">
        <label class="form-label">Base URL</label>
        <input id="f-base_url" type="text" value="${escapeHtml(p.base_url || '')}"
          placeholder="https://api.anthropic.com или http://inference:8000" class="form-input font-mono" />
        <p class="form-help">Пусто = SDK-defaults (для Anthropic/OpenAI) или fallback к <code class="font-mono">LLM_INFERENCE_URL</code> из env.</p>
      </div>
      <div class="form-row">
        <label class="form-label">API key</label>
        <input id="f-api_key" type="password" value="" autocomplete="off"
          placeholder="${p.has_api_key ? `текущий: ${escapeHtml(p.api_key_masked || '')} — оставь пусто чтобы не менять` : 'sk-ant-... или ya-...'}"
          class="form-input font-mono" />
        <p class="form-help">Хранится в БД, в API возвращается только маска. ${p.has_api_key ? 'Пусто = оставить текущий. Чтобы стереть — нажми «Очистить ключ».' : ''}</p>
      </div>
      <div class="form-row">
        <label class="form-label">Model</label>
        <input id="f-model" type="text" value="${escapeHtml(p.model || '')}"
          placeholder="claude-sonnet-4-5 / gpt-4o-mini / qwen2.5-vl-7b-instruct" class="form-input font-mono" />
      </div>
      <div class="flex items-center gap-2 pt-2">
        <button id="test-btn" class="btn-secondary btn-sm" ${isCreate ? 'disabled title="Сначала сохраните"' : ''}>Проверить связь</button>
        <span id="test-result" class="text-xs text-slate-500"></span>
      </div>
    </div>

    <p id="editor-error" class="form-error hidden"></p>

    <div class="flex items-center justify-between gap-2 sticky bottom-0 bg-slate-50/95 dark:bg-slate-950/95 backdrop-blur-sm py-3 -mx-8 px-8 border-t border-slate-200 dark:border-slate-800">
      <div class="flex items-center gap-2">
        ${!isCreate ? `<button id="delete-btn" class="btn-danger btn-md">Удалить</button>` : ''}
        ${!isCreate && p.has_api_key ? `<button id="clear-key-btn" class="btn-ghost btn-sm">Очистить ключ</button>` : ''}
        ${!isCreate && !p.is_default ? `<button id="set-default-btn" class="btn-accent-outline btn-sm">Сделать default</button>` : ''}
      </div>
      <div class="flex items-center gap-2">
        <a href="#audit-log?entity=provider_setting${isCreate ? '' : `&entity_id=${encodeURIComponent(p.id)}`}" class="btn-ghost btn-sm">История</a>
        <a href="#providers" class="btn-secondary btn-md">Отмена</a>
        <button id="save-btn" class="btn-primary btn-md">${isCreate ? 'Создать' : 'Сохранить'}</button>
      </div>
    </div>
  `;
}

function bindProviderHandlers(originalRow, isCreate, root) {
  const errEl = root.querySelector('#editor-error');

  const collectPayload = () => {
    const apiKeyRaw = root.querySelector('#f-api_key').value;
    return {
      kind: root.querySelector('#f-kind').value,
      display_name: root.querySelector('#f-display_name').value.trim(),
      description: root.querySelector('#f-description').value.trim() || null,
      base_url: root.querySelector('#f-base_url').value.trim() || null,
      // Пустой инпут = не менять (в PATCH не отправляем поле api_key)
      api_key: apiKeyRaw === '' ? undefined : apiKeyRaw,
      model: root.querySelector('#f-model').value.trim() || null,
      is_active: root.querySelector('#f-is_active').checked,
    };
  };

  root.querySelector('#save-btn').addEventListener('click', async () => {
    errEl.classList.add('hidden');
    const payload = collectPayload();
    if (!payload.display_name) {
      errEl.textContent = 'display_name обязателен';
      errEl.classList.remove('hidden');
      return;
    }
    try {
      if (isCreate) {
        const id = root.querySelector('#f-id').value.trim();
        if (!id) throw new Error('id обязателен');
        // На create передаём kind + id, api_key если есть
        const body = { id, ...payload };
        if (body.api_key === undefined) delete body.api_key;
        const data = await apiJson('/provider-settings', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        location.hash = `#providers/${data.id}`;
      } else {
        // PATCH: убираем поля, которые на update не меняем
        delete payload.kind;
        if (payload.api_key === undefined) delete payload.api_key;
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        flashSave(root);
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  // Delete
  const delBtn = root.querySelector('#delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Удалить провайдера "${originalRow.id}"?`)) return;
      try {
        const res = await api(`/provider-settings/${encodeURIComponent(originalRow.id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
          throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        location.hash = '#providers';
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Clear API key
  const clearBtn = root.querySelector('#clear-key-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Стереть API key? Провайдер перестанет авторизовываться.')) return;
      try {
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ api_key: null }),
        });
        renderProviderEditor(originalRow.id);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Set default
  const defaultBtn = root.querySelector('#set-default-btn');
  if (defaultBtn) {
    defaultBtn.addEventListener('click', async () => {
      try {
        await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}/set-default`, {
          method: 'POST',
        });
        renderProviderEditor(originalRow.id);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
      }
    });
  }

  // Test connection
  const testBtn = root.querySelector('#test-btn');
  if (testBtn && !isCreate) {
    testBtn.addEventListener('click', async () => {
      const resultEl = root.querySelector('#test-result');
      resultEl.textContent = '…';
      resultEl.className = 'text-xs text-slate-500';
      try {
        const res = await apiJson(`/provider-settings/${encodeURIComponent(originalRow.id)}/test`, {
          method: 'POST',
        });
        if (res.ok) {
          resultEl.textContent = `OK · HTTP ${res.status ?? '?'} · ${res.latency_ms ?? '?'} ms`;
          resultEl.className = 'text-xs text-emerald-600 dark:text-emerald-400 font-medium';
        } else {
          resultEl.textContent = `FAIL · ${res.message || `HTTP ${res.status}`}`;
          resultEl.className = 'text-xs text-rose-600 dark:text-rose-400 font-medium';
        }
      } catch (err) {
        resultEl.textContent = `error · ${err.message}`;
        resultEl.className = 'text-xs text-rose-600 dark:text-rose-400 font-medium';
      }
    });
  }
}

// ============================================================
// Audit log
// ============================================================

const AUDIT_ACTION_BADGE = {
  create: { label: 'create', variant: 'badge-emerald' },
  update: { label: 'update', variant: 'badge-indigo' },
  delete: { label: 'delete', variant: 'badge-rose' },
};
const AUDIT_ENTITY_LABEL = {
  document_type: 'Document type',
  provider_setting: 'Provider',
};

async function renderAuditLog() {
  // Поддерживаем query-параметры в hash для глубоких ссылок типа
  // #audit-log?entity=provider_setting&entity_id=anthropic
  const hashPart = (location.hash || '').split('?')[1] || '';
  const params = new URLSearchParams(hashPart);
  const filterEntity = params.get('entity') || '';
  const filterEntityId = params.get('entity_id') || '';

  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Audit log',
        subtitle: 'История админ-изменений document_types и provider_settings',
      })}

      <div class="info-banner mb-4">
        Срок хранения — настраивается через <code class="font-mono">AUDIT_LOG_RETENTION_DAYS</code>
        (дефолт 365 дней). Старые записи фоново удаляются раз в сутки;
        текущее значение видно в <a href="#settings" class="font-medium underline">Settings → Storage &amp; sweepers</a>.
      </div>

      <div class="flex flex-wrap items-center gap-3 mb-4">
        <select id="audit-entity" class="form-select" style="width: auto;">
          <option value="" ${filterEntity === '' ? 'selected' : ''}>Всё</option>
          <option value="document_type" ${filterEntity === 'document_type' ? 'selected' : ''}>Document types</option>
          <option value="provider_setting" ${filterEntity === 'provider_setting' ? 'selected' : ''}>Providers</option>
        </select>
        <input id="audit-entity-id" type="text" placeholder="entity id (slug или provider id)"
          value="${escapeHtml(filterEntityId)}" class="form-input" style="width: 14rem;" />
        <button id="audit-refresh" class="btn-secondary btn-sm">Обновить</button>
      </div>

      <div id="audit-list" class="space-y-2">${loadingState()}</div>
    </div>
  `);

  const entityEl = document.getElementById('audit-entity');
  const entityIdEl = document.getElementById('audit-entity-id');
  const refreshEl = document.getElementById('audit-refresh');

  async function load() {
    const qs = new URLSearchParams();
    if (entityEl.value) qs.set('entity', entityEl.value);
    if (entityIdEl.value.trim()) qs.set('entity_id', entityIdEl.value.trim());
    qs.set('limit', '100');
    try {
      const data = await apiJson(`/audit-log?${qs.toString()}`);
      renderRows(data.items);
    } catch (err) {
      document.getElementById('audit-list').innerHTML = errorState(err.message);
    }
  }

  function renderRows(items) {
    if (!items.length) {
      document.getElementById('audit-list').innerHTML = `
        <div class="card empty-state">
          <p class="empty-state-text">История пуста.</p>
        </div>`;
      return;
    }
    document.getElementById('audit-list').innerHTML = items.map(renderAuditRow).join('');
  }

  function renderAuditRow(row) {
    const action = AUDIT_ACTION_BADGE[row.action] ?? { label: row.action, variant: 'badge-slate' };
    const entityLabel = AUDIT_ENTITY_LABEL[row.entity] ?? row.entity;
    const diff = row.diff ?? {};
    const diffRows = Object.entries(diff).map(([k, v]) => `
      <div class="audit-diff-row">
        <span class="text-slate-500 truncate" title="${escapeHtml(k)}">${escapeHtml(k)}</span>
        <span class="audit-diff-from truncate" title='${escapeHtml(JSON.stringify(v.from))}'>${escapeHtml(formatDiffValue(v.from))}</span>
        <span class="audit-diff-to truncate" title='${escapeHtml(JSON.stringify(v.to))}'>${escapeHtml(formatDiffValue(v.to))}</span>
      </div>`).join('');

    return `
      <details class="card">
        <summary class="card-body cursor-pointer list-none hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
          <div class="flex items-center justify-between gap-4 flex-wrap">
            <div class="flex items-center gap-2 flex-wrap min-w-0">
              <span class="badge ${action.variant}">${action.label}</span>
              <span class="text-sm font-medium">${entityLabel}</span>
              <span class="font-mono text-xs text-slate-500">${escapeHtml(row.entity_id)}</span>
            </div>
            <div class="flex items-center gap-3 text-xs text-slate-500">
              <span>by <span class="font-medium">${escapeHtml(row.actor)}</span></span>
              <span title="${escapeHtml(row.at)}">${escapeHtml(relativeTime(row.at))}</span>
            </div>
          </div>
          ${Object.keys(diff).length ? `
            <div class="mt-2 text-xs text-slate-500">${Object.keys(diff).length} fields changed</div>
          ` : ''}
        </summary>
        <div class="card-section">
          ${Object.keys(diff).length ? `
            <div class="audit-diff-row font-medium text-slate-500 uppercase tracking-wider" style="font-size: 10px;">
              <span>field</span><span>before</span><span>after</span>
            </div>
            ${diffRows}
          ` : '<p class="text-xs text-slate-400">No field-level diff.</p>'}
          <details class="mt-3">
            <summary class="text-xs text-slate-400 cursor-pointer">raw before/after</summary>
            <div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div class="text-xs text-slate-500 mb-1">before</div>
                <div class="bg-slate-50 dark:bg-slate-950 p-2 rounded text-xs">${row.before ? jsonTree(row.before) : '<span class="text-slate-400">—</span>'}</div>
              </div>
              <div>
                <div class="text-xs text-slate-500 mb-1">after</div>
                <div class="bg-slate-50 dark:bg-slate-950 p-2 rounded text-xs">${row.after ? jsonTree(row.after) : '<span class="text-slate-400">—</span>'}</div>
              </div>
            </div>
          </details>
        </div>
      </details>`;
  }

  entityEl.addEventListener('change', load);
  entityIdEl.addEventListener('change', load);
  entityIdEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  refreshEl.addEventListener('click', load);

  await load();
}

function formatDiffValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ============================================================
// Tenants: organizations / projects / users (admin)
// ============================================================
//
// Минимальная сводная страница multi-tenant фундамента: три таблицы и
// inline-формы создания/редактирования. Сегодня доступно super_admin'у
// (это совпадает с единственным юзером, привязанным к API_KEY).
// Полноценный workspace switcher и granular role enforcement —
// следующая волна.

async function renderTenants() {
  setView(`
    <div class="page">
      ${pageHeader({
        title: 'Tenants',
        subtitle: 'Организации, проекты и пользователи. Сейчас доступно super_admin\'у.',
      })}

      <div class="info-banner mb-4">
        Эти таблицы — фундамент multi-tenant платформы. <strong>System</strong> /
        <strong>Default</strong> — встроенные дефолты (нельзя удалить).
        Все существующие job-ы привязаны к ним. Новые job-ы без явного
        <code class="font-mono">project_id</code> тоже падают сюда. Role-based
        фильтрация в UI/API сейчас работает как super_admin (видно всё) —
        per-user enforcement подключим следующей волной вместе с personal access tokens.
      </div>

      <div id="tenants-orgs" class="mb-6">${loadingState()}</div>
      <div id="tenants-projects" class="mb-6">${loadingState()}</div>
      <div id="tenants-users">${loadingState()}</div>
    </div>
  `);

  let orgs, projects, users;
  try {
    [orgs, projects, users] = await Promise.all([
      apiJson('/organizations'),
      apiJson('/projects'),
      apiJson('/users'),
    ]);
  } catch (err) {
    document.getElementById('tenants-orgs').innerHTML = errorState(err.message);
    return;
  }

  document.getElementById('tenants-orgs').innerHTML = renderOrgsTable(orgs.items);
  document.getElementById('tenants-projects').innerHTML = renderProjectsTable(projects.items, orgs.items);
  document.getElementById('tenants-users').innerHTML = renderUsersTable(users.items, orgs.items);

  // Org create form
  document.getElementById('org-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await apiJson('/organizations', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name') ?? '').trim(),
          type: String(form.get('type') ?? 'external_company'),
        }),
      });
      renderTenants();
    } catch (err) { alert(err.message); }
  });

  // Project create form
  document.getElementById('project-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await apiJson('/projects', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: String(form.get('organization_id')),
          name: String(form.get('name') ?? '').trim(),
          description: String(form.get('description') ?? '').trim() || null,
        }),
      });
      renderTenants();
    } catch (err) { alert(err.message); }
  });

  // Token: generate/rotate. Plaintext возвращается ОДИН РАЗ — показываем
  // в модальном prompt'е, после закрытия его не вернуть.
  document.querySelectorAll('[data-token-gen]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.tokenGen;
      if (!confirm('Сгенерировать новый токен? Старый перестанет работать.')) return;
      try {
        const res = await apiJson(`/users/${encodeURIComponent(userId)}/token`, { method: 'POST' });
        // Plaintext виден ровно один раз — показываем юзеру с инструкцией скопировать.
        const copied = await copyToClipboard(res.plaintext);
        alert(
          `Personal access token создан${copied ? ' и скопирован в буфер обмена' : ''}:\n\n${res.plaintext}\n\n` +
          'Сохраните его сейчас — после закрытия этого окна вы его НЕ увидите. ' +
          'В заголовке Authorization: Bearer <token>.',
        );
        renderTenants();
      } catch (err) { alert(err.message); }
    });
  });
  document.querySelectorAll('[data-token-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.tokenRevoke;
      if (!confirm('Отозвать токен пользователя? После этого его API-запросы будут отклоняться.')) return;
      try {
        const res = await api(`/users/${encodeURIComponent(userId)}/token`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        renderTenants();
      } catch (err) { alert(err.message); }
    });
  });

  // User create form
  document.getElementById('user-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const orgVal = String(form.get('organization_id') ?? '');
    try {
      await apiJson('/users', {
        method: 'POST',
        body: JSON.stringify({
          display_name: String(form.get('display_name') ?? '').trim(),
          email: String(form.get('email') ?? '').trim() || undefined,
          role: String(form.get('role') ?? 'manager'),
          organization_id: orgVal === '' ? null : orgVal,
        }),
      });
      renderTenants();
    } catch (err) { alert(err.message); }
  });
}

function renderOrgsTable(items) {
  const rows = items.map((o) => `
    <tr>
      <td class="font-mono text-xs text-slate-500">${escapeHtml(o.id.slice(0, 8))}</td>
      <td class="font-medium">${escapeHtml(o.name)}</td>
      <td><span class="badge badge-slate">${escapeHtml(o.type)}</span></td>
      <td>${o.status === 'active' ? '<span class="badge badge-emerald">active</span>' : '<span class="badge badge-slate">archived</span>'}</td>
      <td class="text-xs text-slate-500" title="${escapeHtml(o.created_at)}">${escapeHtml(relativeTime(o.created_at))}</td>
    </tr>`).join('');
  return `
    <div class="card overflow-hidden">
      <div class="card-header">
        <h3 class="card-title">Organizations <span class="text-sm font-normal text-slate-500">(${items.length})</span></h3>
      </div>
      <table class="data-table">
        <thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <form id="org-create-form" class="card-body border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-[1fr_12rem_auto] gap-2 items-end">
        <div class="form-row"><label class="form-label text-xs">Имя организации</label><input name="name" type="text" required class="form-input" placeholder="ООО Ромашка" /></div>
        <div class="form-row"><label class="form-label text-xs">Тип</label>
          <select name="type" class="form-select">
            <option value="external_company">external_company</option>
            <option value="internal_division">internal_division</option>
            <option value="test">test</option>
          </select>
        </div>
        <button class="btn-primary btn-md">Создать</button>
      </form>
    </div>`;
}

function renderProjectsTable(items, orgs) {
  const orgName = (id) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8);
  const rows = items.map((p) => `
    <tr>
      <td class="font-mono text-xs text-slate-500">${escapeHtml(p.id.slice(0, 8))}</td>
      <td class="font-medium">${escapeHtml(p.name)}</td>
      <td>${escapeHtml(orgName(p.organization_id))}</td>
      <td class="text-xs text-slate-500 truncate max-w-[16rem]">${escapeHtml(p.description ?? '')}</td>
      <td>${p.status === 'active' ? '<span class="badge badge-emerald">active</span>' : '<span class="badge badge-slate">archived</span>'}</td>
    </tr>`).join('');
  const orgOptions = orgs.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
  return `
    <div class="card overflow-hidden">
      <div class="card-header">
        <h3 class="card-title">Projects <span class="text-sm font-normal text-slate-500">(${items.length})</span></h3>
      </div>
      <table class="data-table">
        <thead><tr><th>ID</th><th>Name</th><th>Organization</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <form id="project-create-form" class="card-body border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-[14rem_1fr_1fr_auto] gap-2 items-end">
        <div class="form-row"><label class="form-label text-xs">Организация</label><select name="organization_id" class="form-select" required>${orgOptions}</select></div>
        <div class="form-row"><label class="form-label text-xs">Имя проекта</label><input name="name" type="text" required class="form-input" placeholder="Бухгалтерия" /></div>
        <div class="form-row"><label class="form-label text-xs">Описание</label><input name="description" type="text" class="form-input" /></div>
        <button class="btn-primary btn-md">Создать</button>
      </form>
    </div>`;
}

function renderUsersTable(items, orgs) {
  const orgName = (id) => id ? (orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8)) : '—';
  const roleBadge = (role) => {
    const variant =
      role === 'super_admin' ? 'badge-rose' :
      role === 'org_admin' ? 'badge-indigo' :
      role === 'manager' ? 'badge-sky' :
      'badge-slate';
    return `<span class="badge ${variant}">${escapeHtml(role)}</span>`;
  };
  const rows = items.map((u) => `
    <tr>
      <td class="font-medium">${escapeHtml(u.display_name)}</td>
      <td class="font-mono text-xs text-slate-500">${escapeHtml(u.email ?? '—')}</td>
      <td>${escapeHtml(orgName(u.organization_id))}</td>
      <td>${roleBadge(u.role)}</td>
      <td>${u.status === 'active' ? '<span class="badge badge-emerald">active</span>' : '<span class="badge badge-rose">blocked</span>'}</td>
      <td>
        ${u.has_api_token
          ? '<span class="badge badge-emerald">token set</span>'
          : '<span class="badge badge-slate">no token</span>'}
      </td>
      <td class="flex gap-1">
        <button class="btn-secondary btn-xs" data-token-gen="${escapeHtml(u.id)}" title="Сгенерировать новый personal access token">⟳ token</button>
        ${u.has_api_token ? `<button class="btn-ghost btn-xs" data-token-revoke="${escapeHtml(u.id)}" title="Отозвать">×</button>` : ''}
      </td>
    </tr>`).join('');
  const orgOptions = '<option value="">(super_admin без организации)</option>' + orgs.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
  return `
    <div class="card overflow-hidden">
      <div class="card-header">
        <h3 class="card-title">Users <span class="text-sm font-normal text-slate-500">(${items.length})</span></h3>
      </div>
      <table class="data-table">
        <thead><tr><th>Name</th><th>Email</th><th>Organization</th><th>Role</th><th>Status</th><th>Token</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <form id="user-create-form" class="card-body border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-[1fr_1fr_14rem_10rem_auto] gap-2 items-end">
        <div class="form-row"><label class="form-label text-xs">Имя</label><input name="display_name" type="text" required class="form-input" /></div>
        <div class="form-row"><label class="form-label text-xs">Email</label><input name="email" type="email" class="form-input" /></div>
        <div class="form-row"><label class="form-label text-xs">Организация</label><select name="organization_id" class="form-select">${orgOptions}</select></div>
        <div class="form-row"><label class="form-label text-xs">Роль</label>
          <select name="role" class="form-select">
            <option value="manager">manager</option>
            <option value="viewer">viewer</option>
            <option value="org_admin">org_admin</option>
            <option value="super_admin">super_admin</option>
          </select>
        </div>
        <button class="btn-primary btn-md">Создать</button>
      </form>
    </div>`;
}

// ============================================================
// Settings
// ============================================================

async function renderSettings() {
  setView(`
    <div class="page-narrow">
      ${pageHeader({ title: 'Settings', subtitle: 'Конфигурация сервиса и LLM-провайдеров' })}
      <div id="settings-content" class="space-y-4">${loadingState()}</div>
    </div>
  `);

  let settings;
  let providers;
  try {
    [settings, providers] = await Promise.all([
      apiJson('/settings'),
      apiJson('/providers/status'),
    ]);
  } catch (err) {
    document.getElementById('settings-content').innerHTML = errorState(err.message);
    return;
  }

  document.getElementById('settings-content').innerHTML = `
    ${renderProvidersCard(providers)}
    ${renderOcrCard(settings)}
    ${renderStorageCard(settings)}
    ${renderLimitsCard(settings)}
    ${renderEndpointsCard()}
    ${renderSessionCard()}
  `;

  document.getElementById('logout-from-settings')?.addEventListener('click', () => {
    auth.token = null;
    showLogin();
  });
}

function renderProvidersCard(providers) {
  const head = (status, body) => `
    <div class="card card-body">
      <div class="flex items-center justify-between mb-3">
        <h3 class="card-title">LLM upstream <span class="text-sm font-normal text-slate-500">(inference-service)</span></h3>
        <div class="flex items-center gap-2">
          ${status}
          <a href="#providers" class="btn-ghost btn-xs">→ Provider keys</a>
        </div>
      </div>
      ${body}
    </div>`;

  if (providers.upstream === 'not_configured') {
    return head(
      '<span class="badge badge-slate">not connected</span>',
      `<p class="text-sm text-slate-600 dark:text-slate-400">inference-service не подключён (<code class="font-mono text-xs">LLM_INFERENCE_URL</code> пустой). Phase 2 парсеры (ТТН/CMR/АКТ) деградируют до пустых результатов и needs_review.</p>`,
    );
  }
  if (providers.upstream === 'unreachable') {
    return head(
      '<span class="badge badge-rose">unreachable</span>',
      `<div class="error-banner text-sm">
        <p class="font-medium">inference-service недоступен</p>
        ${providers.error ? `<p class="font-mono text-xs mt-1">${escapeHtml(providers.error)}</p>` : ''}
      </div>`,
    );
  }

  const available = providers.available || {};
  const active = providers.active;
  const rows = Object.entries(available).map(([name, info]) => {
    const isActive = name === active;
    const configBadge = info.configured
      ? '<span class="badge badge-emerald">configured</span>'
      : '<span class="badge badge-slate">not configured</span>';
    const activeBadge = isActive ? '<span class="badge badge-indigo">active</span>' : '';
    return `
      <div class="flex items-start gap-4 p-3 rounded-lg ${isActive ? 'bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900' : 'bg-slate-50/50 dark:bg-slate-950/30'}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="font-mono text-sm font-medium">${escapeHtml(name)}</span>
            ${activeBadge}
            ${configBadge}
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(info.description || '')}</div>
          ${info.model ? `<div class="text-xs text-slate-400 dark:text-slate-500 font-mono mt-0.5">${escapeHtml(info.model)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  return head(
    '<span class="badge badge-emerald">connected</span>',
    `<p class="text-xs text-slate-500 dark:text-slate-400 mb-3">Активный бэкенд переключается через <code class="font-mono">BACKEND=</code> в env inference-service. Требует рестарта контейнера.</p>
     <div class="space-y-2">${rows || '<p class="text-sm text-slate-400">провайдеров нет</p>'}</div>`,
  );
}

function renderOcrCard(settings) {
  const t = settings.thresholds;
  const eng = settings.ocr_engines;
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">OCR pipeline</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Confidence-пороги (от 0.0 до 1.0). Если уверенность OCR-движка выше
        порога — результат принимается, цепочка останавливается; иначе пробуется
        следующий движок. <code class="font-mono">needs_review</code> — финальный
        порог: ниже него job уходит на ручную проверку.
      </p>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">pdf-parse accept</dt><dd class="kv-value">${t.pdf_text}</dd></div>
        <div class="kv-row"><dt class="kv-key">tesseract accept</dt><dd class="kv-value">${t.tesseract}</dd></div>
        <div class="kv-row"><dt class="kv-key">vision-llm accept</dt><dd class="kv-value">${t.vision_llm}</dd></div>
        <div class="kv-row"><dt class="kv-key">needs_review threshold</dt><dd class="kv-value">${t.needs_review}</dd></div>
        <div class="kv-row"><dt class="kv-key">regex-fallback threshold</dt><dd class="kv-value">${t.regex_fallback}</dd></div>
        <div class="kv-row"><dt class="kv-key">tesseract langs</dt><dd class="kv-value">${escapeHtml(eng.tesseract_langs)}</dd></div>
      </dl>
      <div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
        <div class="kv-row">
          <span class="kv-key text-sm">vision-llm engine</span>
          ${eng.vision_llm.enabled
            ? '<span class="badge badge-emerald">enabled</span>'
            : '<span class="badge badge-slate">disabled</span>'}
        </div>
        ${eng.vision_llm.url ? `<div class="text-xs font-mono text-slate-400">${escapeHtml(eng.vision_llm.url)}</div>` : ''}
        <div class="kv-row">
          <span class="kv-key text-sm">yandex-vision engine</span>
          ${eng.yandex_vision.enabled
            ? '<span class="badge badge-amber">enabled</span>'
            : '<span class="badge badge-slate">disabled</span>'}
        </div>
        ${eng.yandex_vision.enabled ? `
          <div class="warning-banner text-xs">
            <strong>⚠</strong> ${escapeHtml(eng.yandex_vision.pii_warning)}
          </div>` : ''}
      </div>
    </div>`;
}

function renderStorageCard(settings) {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Storage &amp; sweepers</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">backend</dt><dd class="kv-value">${escapeHtml(settings.storage.backend)}</dd></div>
        <div class="kv-row"><dt class="kv-key">dir</dt><dd class="kv-value">${escapeHtml(settings.storage.dir)}</dd></div>
        <div class="kv-row"><dt class="kv-key">file retention</dt><dd class="kv-value">${settings.storage.retention_days} days</dd></div>
        <div class="kv-row"><dt class="kv-key">worker concurrency</dt><dd class="kv-value">${settings.worker.concurrency}</dd></div>
        <div class="kv-row"><dt class="kv-key">pending sweep</dt><dd class="kv-value">${settings.sweepers.pending_interval_ms / 1000}s (grace ${settings.sweepers.pending_grace_seconds}s)</dd></div>
        <div class="kv-row"><dt class="kv-key">cleanup sweep</dt><dd class="kv-value">${settings.sweepers.file_cleanup_interval_ms / 60000} min</dd></div>
        <div class="kv-row"><dt class="kv-key">audit retention</dt><dd class="kv-value">${settings.sweepers.audit_log_retention_days} days (sweep every ${Math.round(settings.sweepers.audit_log_interval_ms / 3600000)}h)</dd></div>
      </dl>
    </div>`;
}

function renderLimitsCard(settings) {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Limits &amp; secrets</h3>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div class="kv-row"><dt class="kv-key">max upload</dt><dd class="kv-value">${settings.limits.max_upload_mb} MB</dd></div>
        <div class="kv-row"><dt class="kv-key">max metadata</dt><dd class="kv-value">${(settings.limits.max_metadata_bytes / 1024).toFixed(0)} KB</dd></div>
        <div class="kv-row"><dt class="kv-key">API_KEY</dt><dd>${settings.auth.api_key_configured ? '<span class="badge badge-emerald">configured</span>' : '<span class="badge badge-rose">not set</span>'}</dd></div>
        <div class="kv-row"><dt class="kv-key">webhook HMAC</dt><dd>${settings.webhook.hmac_secret_configured ? '<span class="badge badge-emerald">configured</span>' : '<span class="badge badge-rose">default (change me)</span>'}</dd></div>
        <div class="kv-row"><dt class="kv-key">webhook attempts</dt><dd class="kv-value">${settings.webhook.max_attempts}</dd></div>
      </dl>
    </div>`;
}

function renderEndpointsCard() {
  const link = (path) => `<a href="${path}" target="_blank" class="text-indigo-600 dark:text-indigo-400 hover:underline">${path}</a>`;
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Endpoints</h3>
      <dl class="kv">
        <div class="kv-row"><dt class="kv-key">API base</dt><dd class="kv-value">${escapeHtml(API)}</dd></div>
        <div class="kv-row"><dt class="kv-key">Swagger UI</dt><dd class="kv-value">${link('/docs')}</dd></div>
        <div class="kv-row"><dt class="kv-key">OpenAPI JSON</dt><dd class="kv-value">${link('/docs/json')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Health</dt><dd class="kv-value">${link('/health')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Ready</dt><dd class="kv-value">${link('/ready')}</dd></div>
        <div class="kv-row"><dt class="kv-key">Metrics</dt><dd class="kv-value">${link('/metrics')}</dd></div>
      </dl>
    </div>`;
}

function renderSessionCard() {
  return `
    <div class="card card-body">
      <h3 class="card-title mb-3">Session</h3>
      <dl class="kv mb-4">
        <div class="kv-row"><dt class="kv-key">Token</dt><dd class="kv-value">${auth.token ? '••••••••' + escapeHtml(auth.token.slice(-6)) : '—'}</dd></div>
      </dl>
      <button id="logout-from-settings" class="btn-secondary btn-sm">Выйти</button>
    </div>`;
}

// ============================================================
// Reference Lists — CRUD для справочников
// ============================================================
//
// Список типов справочников (cargo_units, nomenclature, …) и их записей.
// Org-scoped: берём organization_id из текущего workspace.
// Синхронизация через POST /sync обычно идёт от внешней системы (WMS/ERP),
// здесь — только просмотр и ручное редактирование.

async function renderReferenceLists() {
  const orgId = workspace.current?.organization_id ?? '';
  setView(`<div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Reference lists</h1>
        <p class="page-subtitle">Справочники для привязки документов к бизнес-сущностям</p>
      </div>
    </div>
    <div id="rl-content">${loadingState()}</div>
  </div>`);

  if (!orgId) {
    document.getElementById('rl-content').innerHTML = `<div class="info-banner">Выберите workspace чтобы видеть справочники.</div>`;
    return;
  }

  try {
    const types = await apiJson(`/reference-list-types?organization_id=${encodeURIComponent(orgId)}`);

    if (types.length === 0) {
      document.getElementById('rl-content').innerHTML = `
        <div class="card">
          <div class="empty-state">
            <p class="empty-state-text">Справочники не созданы</p>
            <p class="text-sm text-slate-400 mt-2">Справочники создаются при первой синхронизации из WMS/ERP через <code class="font-mono">POST /api/v1/reference-list-types</code></p>
          </div>
        </div>`;
      return;
    }

    const rows = types.map((t) => `
      <tr class="row-clickable" onclick="location.hash='#reference-lists/${encodeURIComponent(t.slug)}'">
        <td class="px-4 py-3 font-mono text-sm">${escapeHtml(t.slug)}</td>
        <td class="px-4 py-3 text-sm">${escapeHtml(t.label)}</td>
        <td class="px-4 py-3 text-xs text-slate-500">${escapeHtml(t.search_hint ?? '—')}</td>
        <td class="px-4 py-3 text-xs text-slate-400 font-mono">${relativeTime(t.created_at)}</td>
        <td class="px-4 py-3">
          <a href="#reference-lists/${encodeURIComponent(t.slug)}" class="btn-secondary btn-xs">Записи →</a>
        </td>
      </tr>`).join('');

    document.getElementById('rl-content').innerHTML = `
      <div class="card overflow-hidden">
        <div class="card-header">
          <h2 class="card-title">Типы справочников (${types.length})</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table">
            <thead><tr>
              <th>Slug</th><th>Название</th><th>Подсказка поиска</th><th>Создан</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    document.getElementById('rl-content').innerHTML = errorState(err.message);
  }
}

async function renderReferenceListEntries(slug) {
  const orgId = workspace.current?.organization_id ?? '';
  setView(`<div class="page">
    ${backLink('#reference-lists')}
    <div class="page-header">
      <div>
        <h1 class="page-title font-mono">${escapeHtml(slug)}</h1>
        <p class="page-subtitle">Записи справочника</p>
      </div>
    </div>
    <div id="rle-search" class="mb-4 flex gap-2">
      <input id="rle-q" type="search" class="form-input max-w-xs" placeholder="Поиск…" />
    </div>
    <div id="rle-content">${loadingState()}</div>
  </div>`);

  if (!orgId) {
    document.getElementById('rle-content').innerHTML = `<div class="info-banner">Выберите workspace.</div>`;
    return;
  }

  let q = '';
  let offset = 0;
  const limit = 50;

  async function loadEntries() {
    const content = document.getElementById('rle-content');
    if (!content) return;
    content.innerHTML = loadingState();
    try {
      const qs = new URLSearchParams({
        organization_id: orgId,
        limit: String(limit),
        offset: String(offset),
        active_only: 'false',
        ...(q ? { q } : {}),
      });
      const data = await apiJson(`/reference-list-types/${encodeURIComponent(slug)}/entries?${qs}`);
      const { items } = data;

      if (items.length === 0 && offset === 0) {
        content.innerHTML = `<div class="card"><div class="empty-state"><p class="empty-state-text">Нет записей</p></div></div>`;
        return;
      }

      const rows = items.map((e) => `
        <tr>
          <td class="px-4 py-3 text-xs font-mono text-slate-500">${escapeHtml(e.external_id ?? '—')}</td>
          <td class="px-4 py-3 text-sm">${escapeHtml(e.display_name)}</td>
          <td class="px-4 py-3 text-xs font-mono text-slate-500 max-w-[16rem] truncate">${escapeHtml(e.search_keys.join(', '))}</td>
          <td class="px-4 py-3">
            ${e.is_active
              ? '<span class="badge badge-emerald">Active</span>'
              : '<span class="badge badge-slate">Inactive</span>'}
          </td>
          <td class="px-4 py-3 text-xs text-slate-400">${relativeTime(e.synced_at ?? e.updated_at)}</td>
        </tr>`).join('');

      const paginationHtml = `
        <div class="flex items-center gap-3 px-4 py-3 text-sm text-slate-500">
          <span>Показано ${offset + 1}–${offset + items.length}</span>
          ${offset > 0 ? `<button id="rle-prev" class="btn-secondary btn-xs">← Назад</button>` : ''}
          ${items.length === limit ? `<button id="rle-next" class="btn-secondary btn-xs">Вперёд →</button>` : ''}
        </div>`;

      content.innerHTML = `
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="data-table">
              <thead><tr>
                <th>External ID</th><th>Название</th><th>Ключи поиска</th><th>Статус</th><th>Синхр.</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${paginationHtml}
        </div>`;

      document.getElementById('rle-prev')?.addEventListener('click', () => {
        offset = Math.max(0, offset - limit);
        void loadEntries();
      });
      document.getElementById('rle-next')?.addEventListener('click', () => {
        offset += limit;
        void loadEntries();
      });
    } catch (err) {
      content.innerHTML = errorState(err.message);
    }
  }

  document.getElementById('rle-q')?.addEventListener('input', (e) => {
    q = e.target.value.trim();
    offset = 0;
    clearTimeout(window._rleSearchTimer);
    window._rleSearchTimer = setTimeout(() => void loadEntries(), 300);
  });

  await loadEntries();
}

// ============================================================
// Boot
// ============================================================
applyTheme();
if (auth.isAuthed()) {
  hideLogin();
  void initWorkspace();
  if (!location.hash) location.hash = '#jobs';
  route();
} else {
  showLogin();
}
