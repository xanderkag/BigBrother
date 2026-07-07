// JSON Schema descriptors for the LLM /extract endpoint, one per document
// type. Hand-written rather than derived from the zod schemas in
// `documents.ts`: the LLM consumes JSON Schema shape, our runtime uses
// zod, and the two have different goals — the JSON Schema is a *prompt*
// (it tells the model what to look for), so it's tuned for clarity over
// strict validation.
//
// All fields are optional: the model is instructed in the prompt to omit
// fields it cannot find rather than guessing. Required fields would force
// the model to invent values.
//
// ── Phase A схемы v2 ────────────────────────────────────────────────────
// Унификация:
//   - Массив строк всегда называется `items[]` (раньше: positions/services/cargo).
//     Старые имена обрабатывает нормализатор normalize-extracted.ts при чтении
//     job'а в API — backward-compat.
//   - Shape строки расширен до 18 полей (см. ITEM_PROPERTIES) под реальный
//     B2B-учёт: code, barcode, hs_code, country, units, веса, разбивка НДС
//     per-line, валюта строки, line_no, заметки.
//   - Шапка получила vat_summary[], currency, exchange_rate, shipper/consignee
//     отдельно от seller/buyer, флаги (is_export, is_advance, vat_agent),
//     incoterms, ссылку на другие документы.

import type { DocumentType } from './documents.js';

const DATE_DESCRIPTION = 'Дата в формате YYYY-MM-DD';
const INN_DESCRIPTION = 'ИНН организации (10 цифр) или ИП (12 цифр)';
const KPP_DESCRIPTION = 'КПП организации (9 цифр)';

// PD-CONTRACT-1 Q2 / §2.1 (SLAI 2026-06-13): order_refs — #1 match-signal
// после контейнера. Свободный массив ЛЮБЫХ ссылок на заказ/PO, упомянутых
// в документе. Один и тот же description для всех типов где заказы реальны
// (invoice / tax_invoice / upd / ttn / cmr / bill_of_lading). Проектор
// match-signals.ts собирает их в `_match_signals.order_refs`.
const ORDER_REFS = {
  type: 'array',
  description:
    'Номера заказов/PO, упомянутые в документе («Заказ №», «Order Ref», «Our ref.», PO number, «по заказу №»). Как есть, без трактовки. Пустой массив, если нет.',
  items: { type: 'string' },
} as const;

// SLAI Q15 (2026-06-22): doc-level контейнеры для перевозочных типов
// (TTN/CMR/Акт), чтобы документ привязывался по грузовой единице. Форма как
// у BL_SCHEMA.containers (минимальная: number). Проектор match-signals.ts
// собирает их в `_match_signals.containers` через collectContainers().
const CONTAINERS = {
  type: 'array',
  description:
    'Номера контейнеров (ISO 6346: 4 буквы + 7 цифр, напр. MSCU1234567). ' +
    'ОБЯЗАТЕЛЬНО извлекай КАЖДЫЙ номер контейнера, упомянутый в документе — ' +
    'в строке «Контейнер: …», в графе тары/груза или в тексте про перевозку. ' +
    'По одному объекту на контейнер. Если контейнеров нет — опусти поле.',
  items: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'Номер контейнера, формат ISO 6346 (напр. MSCU1234567)' },
    },
  },
} as const;

// SLAI Q15 (2026-06-23): doc-level СКАЛЯРНЫЙ алиас контейнера. phi4 надёжнее
// заполняет плоскую строку, чем массив объектов CONTAINERS — а в перевозочных
// типах (ТТН/CMR/Акт) контейнер обычно один. collectContainers() читает и
// `containers[].number`, и этот top-level `container_number` (дедуп общий через
// uniqStrings), поэтому оба поля безопасно держать рядом.
const CONTAINER_NUMBER = {
  type: 'string',
  description:
    'Номер контейнера (ISO 6346: 4 буквы + 7 цифр, напр. MSCU1234567), если в документе ' +
    'упомянут ОДИН контейнер — извлеки из «Контейнер: …» / текста про перевозку груза. ' +
    'Если контейнеров несколько — заполни массив containers[]. Нет контейнера — опусти поле.',
} as const;

const PARTY = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Наименование' },
    inn: { type: 'string', description: INN_DESCRIPTION },
    kpp: { type: 'string', description: KPP_DESCRIPTION },
    // EXT-LINE-3 (SLAI 2026-06-03): ОГРН (13 цифр ЮЛ / 15 цифр ИП) — нужен
    // SLAI matcher для дозаполнения реквизитов контрагента из их БД.
    ogrn: { type: 'string', description: 'ОГРН организации (13 цифр для ЮЛ, 15 для ИП)' },
    address: { type: 'string' },
    // F19 (2026-05-17): банковские реквизиты для invoice / payment_order /
    // других платёжных документов. Все поля optional — модель заполняет
    // только то что нашла в документе. Для документов без банк-блока
    // (CMR, путевой лист) останутся пустыми.
    bank: { type: 'string', description: 'Наименование банка' },
    bik: { type: 'string', description: 'БИК банка (9 цифр)' },
    account: { type: 'string', description: 'Расчётный счёт (20 цифр)' },
    corr_account: { type: 'string', description: 'Корреспондентский счёт банка (20 цифр)' },
    phone: { type: 'string', description: 'Контактный телефон в формате +7XXXXXXXXXX' },
  },
} as const;

const PARTY_WITH_COUNTRY = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { type: 'string' },
    country: { type: 'string', description: 'Двухбуквенный код ISO 3166 (RU, DE, PL и т.п.)' },
  },
} as const;

const PARTY_BANK = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    inn: { type: 'string', description: INN_DESCRIPTION },
    kpp: { type: 'string', description: KPP_DESCRIPTION },
    account: { type: 'string', description: 'Расчётный счёт (20 цифр)' },
    bank_name: { type: 'string' },
    bic: { type: 'string', description: 'БИК (9 цифр)' },
    correspondent_account: { type: 'string' },
  },
} as const;

/**
 * Канонический shape одной строки items[i]. Все поля опциональны — модель
 * заполняет только то что нашла. Парсеры по builtin-типу используют подмножество;
 * Generic LLM-парсер получает весь шаблон через llm_schema.
 */
const ITEM_PROPERTIES = {
  line_no: { type: 'integer', description: 'Порядковый номер строки в документе' },
  code: { type: 'string', description: 'Внутренний артикул / код товара' },
  barcode: { type: 'string', description: 'Штрих-код (EAN-13, UPC, GTIN)' },
  name: { type: 'string', description: 'Наименование товара/услуги' },
  hs_code: {
    type: 'string',
    description: 'Код ТН ВЭД (10 цифр для РФ/ЕАЭС, 8 цифр для ЕС). Только для импорта/таможни.',
  },
  country_of_origin: { type: 'string', description: 'Страна происхождения, ISO 3166-1 alpha-2' },
  unit: { type: 'string', description: 'Единица измерения (шт, кг, м, л, упак, …)' },
  qty: { type: 'number', description: 'Количество' },
  qty_per_package: { type: 'number', description: 'Количество единиц в упаковке' },
  packages: { type: 'number', description: 'Количество упаковок/мест' },
  weight_net: { type: 'number', description: 'Вес нетто в килограммах' },
  weight_gross: { type: 'number', description: 'Вес брутто в килограммах' },
  price: { type: 'number', description: 'Цена за единицу без НДС' },
  vat_rate: { type: 'number', description: 'Ставка НДС именно этой строки (0, 10, 20)' },
  vat_amount: { type: 'number', description: 'Сумма НДС по строке' },
  total_without_vat: { type: 'number', description: 'Стоимость без НДС' },
  total_with_vat: { type: 'number', description: 'Стоимость с НДС' },
  currency: { type: 'string', description: 'Валюта строки, если отличается от шапки. ISO 4217 (RUB, USD, EUR, CNY)' },
  notes: { type: 'string', description: 'Произвольные комментарии в строке' },
  // ── Фискальные коды строки (счёт-фактура / УКД / УПД, форма ФНС-2026) ──────
  // Машино-стабильные коды для детерминированного матчинга единиц и таможни +
  // обязательная с 2026 прослеживаемость. Опциональны — модель заполняет если есть.
  okei_code: {
    type: 'string',
    description: 'Код единицы измерения по ОКЕИ (напр. "796" = шт). Машино-стабильный id единицы для сопоставления номенклатуры в ERP.',
  },
  excise_amount: { type: 'number', description: 'Сумма акциза по строке («в т.ч. сумма акциза»). Для подакцизных товаров; иначе опустить.' },
  traceability_reg_number: {
    type: 'string',
    description: 'Рег. номер партии прослеживаемости (графа 11 счёта-фактуры) / номер ДТ. Ключ таможенного и заказного сопоставления.',
  },
  product_type_code: { type: 'string', description: 'Код вида товара (графа 1а счёта-фактуры, ЕАЭС). Отличается от hs_code.' },
  // ── Транспортные атрибуты строки (фрахт-счета SLAI, 2026-05-20) ──────────
  // В счетах перевозчиков каждая строка items[] — это отдельный рейс. Атрибуты
  // рейса обычно зашиты прямо в текст name, например:
  //   «Перевозка груза. Заказ: T-2025-006. Маршрут: Москва → Краснодар. Госномер: А123ВС797.»
  // Модель должна РАСПАРСИТЬ их из name в отдельные поля — по ним SLAI
  // привязывает строку к конкретной машине и заказу. Если в строке нет
  // транспортных данных (обычный товарный счёт) — оставить null.
  vehicle_plate: {
    type: 'string',
    description:
      'Госномер ТС этого рейса. Извлечь из текста строки после «Госномер:»/«Машина:»/«а/м». ' +
      'Формат РФ: буква+3 цифры+2 буквы+регион (А123ВС797). Нормализовать в верхний регистр без пробелов.',
  },
  order_ref: {
    type: 'string',
    description:
      'Номер заказа/заявки на перевозку. Извлечь из текста строки после «Заказ:»/«Заявка:»/«№ заявки». Пример: T-2025-006.',
  },
  route_from: {
    type: 'string',
    description: 'Пункт отправления рейса. Из «Маршрут: A → B» — это A. Пример: Москва.',
  },
  route_to: {
    type: 'string',
    description: 'Пункт назначения рейса. Из «Маршрут: A → B» — это B. Пример: Краснодар.',
  },
  trip_date: {
    type: 'string',
    description: 'Дата рейса/перевозки этой строки в ISO YYYY-MM-DD, если указана. Иначе null.',
  },
  // ── EXT-LINE (SLAI 2026-05-29): per-line transport signals для матчинга
  // позиции счёта на плечо перевозки. Все — опциональные string, null если в
  // строке физически нет. Парсдокс НЕ нормализует (upper-case, удаление
  // пробелов, валидация формата) — SLAI делает сам. Если поле есть только в
  // шапке документа (один контейнер на весь счёт) — модель МОЖЕТ продублировать
  // в каждую строку (упрощает матчинг), но не обязана.
  container_no: {
    type: 'string',
    description:
      'Номер морского контейнера (ISO 6346 — 4 буквы + 7 цифр, опц. чек-цифра). ' +
      'Извлечь как написан в документе. Пример: "MSCU1234567".',
  },
  bl_no: {
    type: 'string',
    description:
      'Номер коносамента (Bill of Lading, морская перевозка). Извлечь из строки ' +
      'после «B/L», «коносамент №», «Bill of Lading». Пример: "MEDUH7654321".',
  },
  cmr_no: {
    type: 'string',
    description:
      'Номер CMR-накладной (международная автоперевозка). Извлечь после «CMR №», ' +
      '«накладная CMR». Пример: "0123456".',
  },
  ttn_no: {
    type: 'string',
    description:
      'Номер товарно-транспортной накладной (внутри-РФ). Извлечь после «ТТН №», ' +
      '«накладная №», если контекст внутренней перевозки. Пример: "ТТН-2026-00125".',
  },
  declaration_no: {
    type: 'string',
    description:
      'Номер таможенной декларации (ДТ, для счетов брокеров). Извлечь после «ДТ №», ' +
      '«декларация №». Формат РФ: XXXXXXXX/DDMMYY/XXXXXXX. Пример: "10131010/120526/0001234".',
  },
  driver_name: {
    type: 'string',
    description:
      'ФИО водителя как написано в строке. Извлечь после «Водитель:», «ФИО водителя:». ' +
      'Пример: "Иванов И.И.". Best-effort, дополнительный сигнал.',
  },
  // ── EXT-LINE-3 (SLAI 2026-06-03): категория услуги для line-level matching.
  // Совпадает с SLAI service-type enum (transportation/loading/escort/...).
  category: {
    type: 'string',
    enum: [
      'transportation',
      'loading',
      'unloading',
      'storage',
      'escort',
      'permit_fee',
      'customs_clearance',
      'demurrage',
      'insurance',
      'documents',
      'route_approval',
      'crane_loading',
      'pilot_driver',
      'other',
    ],
    description:
      'Категория услуги/работы (для матчинга позиции в SLAI). Один из: ' +
      'transportation (перевозка), loading/unloading (ПРР), storage (хранение), ' +
      'escort (сопровождение), permit_fee (сбор за разрешение), customs_clearance, ' +
      'demurrage (простой), insurance, documents, route_approval, crane_loading, ' +
      'pilot_driver, other (fallback).',
  },
} as const;

const ITEMS_ARRAY = {
  type: 'array',
  description:
    'Список позиций документа. Каждая строка — товар/услуга/груз. ' +
    'Если в документе нет таблицы позиций, оставить пустым массивом.',
  items: { type: 'object', properties: ITEM_PROPERTIES },
} as const;

/**
 * Разбивка НДС по ставкам — для документов где могут быть несколько ставок
 * одновременно (счёт-фактура с НДС 10% и 20% на разные позиции).
 */
const VAT_SUMMARY = {
  type: 'array',
  description: 'Разбивка по ставкам НДС: одна запись на каждую ставку, встречающуюся в документе',
  items: {
    type: 'object',
    properties: {
      rate: { type: 'number', description: 'Ставка в процентах (0, 10, 20)' },
      base: { type: 'number', description: 'Налогооблагаемая база по этой ставке' },
      vat: { type: 'number', description: 'Сумма НДС по этой ставке' },
    },
  },
} as const;

const FLAGS = {
  type: 'object',
  description: 'Булевы признаки документа',
  properties: {
    is_export: { type: 'boolean', description: 'Документ оформлен на экспорт' },
    is_advance: { type: 'boolean', description: 'Аванс / предоплата (счёт-фактура на аванс)' },
    vat_agent: { type: 'boolean', description: 'Покупатель — налоговый агент по НДС' },
    usn: { type: 'boolean', description: 'Продавец на упрощённой системе налогообложения' },
  },
} as const;

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер документа' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    seller: PARTY,
    buyer: PARTY,
    // Грузоотправитель / грузополучатель отличны от продавца/покупателя для
    // трёхсторонних отгрузок. Если совпадают — модели поручено оставить null.
    shipper: { ...PARTY, description: 'Грузоотправитель (если отличается от продавца)' },
    consignee: { ...PARTY, description: 'Грузополучатель (если отличается от покупателя)' },
    currency: { type: 'string', description: 'Валюта документа, ISO 4217 (по умолчанию RUB)' },
    exchange_rate: { type: 'number', description: 'Курс к валюте учёта (если currency ≠ RUB)' },
    total: { type: 'number', description: 'Итоговая сумма к оплате' },
    total_without_vat: { type: 'number', description: 'Итог без НДС' },
    vat: { type: 'number', description: 'Сумма НДС всего' },
    vat_rate: { type: 'number', description: 'Основная ставка НДС в процентах (20, 10, 0)' },
    vat_summary: VAT_SUMMARY,
    flags: FLAGS,
    // ── EXT-PAY (extraction-gap audit 2026-06-26): платёжно-сверочный блок.
    // payee/payment_purpose — ключи банковской автосверки (получатель платежа
    // часто ≠ seller на агентских/маркетплейс-счетах). Остальное — реальная
    // сумма к оплате и контроль ошибок OCR в цифрах.
    payee: {
      ...PARTY_BANK,
      description:
        'Получатель платежа (банковский) — из блока «Получатель / Банк получателя». ' +
        'На агентских и маркетплейс-счетах деньги идут сюда, а не на seller. Главный ключ банковской сверки.',
    },
    payment_purpose: {
      type: 'string',
      description: 'Назначение платежа — точная строка из «Назначение платежа», которую банк отразит в платёжном поручении (ключ автосверки).',
    },
    amount_due: { type: 'number', description: 'Сумма к оплате (ИТОГО К ОПЛАТЕ) — может отличаться от total при учёте доставки/предоплаты.' },
    vat_included_amount: { type: 'number', description: 'Сумма НДС, включённого в total («в том числе НДС»), когда НДС не выделен отдельной строкой.' },
    shipping_amount: { type: 'number', description: 'Стоимость доставки отдельной строкой («Услуги по доставке»).' },
    prepayment_amount: { type: 'number', description: 'Внесённая предоплата/аванс — уменьшает сумму к оплате.' },
    amount_in_words: { type: 'string', description: 'Итоговая сумма прописью — кросс-проверка числового total (ловит ошибки OCR в цифрах).' },
    line_count: { type: 'integer', description: 'Заявленное число позиций («Всего наименований N») — проверка полноты items[].' },
    payment_terms: { type: 'string', description: 'Условия оплаты (например "до 15.12.2025")' },
    // ── EXT-LINE (SLAI 2026-05-29): document-level header-fallback. SLAI
    // использует когда у конкретной строки нет своих сигналов («счёт за май →
    // плечо завершилось в мае»). Парсдокс заполняет если в шапке есть, иначе null.
    period_from: {
      type: 'string',
      description: 'Дата начала периода оказания услуг (ISO YYYY-MM-DD). Из «Период с ... по ...».',
    },
    period_to: {
      type: 'string',
      description: 'Дата конца периода оказания услуг (ISO YYYY-MM-DD).',
    },
    contract_no: {
      type: 'string',
      description: 'Номер договора между seller и buyer. Из «по договору №», «на основании договора №». Пример: "Д-2025-118".',
    },
    contract_date: {
      type: 'string',
      description: 'Дата договора (ISO YYYY-MM-DD).',
    },
    // ── EXT-LINE-2 (SLAI 2026-06-03): транспортные doc-level сигналы
    // для перевозочных счетов (негабарит/мультимодал). SLAI matcher
    // использует для автопривязки счёт → заказ/плечо без human-in-loop.
    // Также задействуют target_entity_hint (см. orchestrator.ts).
    order_ref: {
      type: 'string',
      description: 'Номер заявки/основания перевозки. Шаблон [A-Z]{2,5}-\\d{4}-\\d{3,4}. Из блока «Основание: перевозка ... заявка NEG-2026-001».',
    },
    order_refs: ORDER_REFS,
    vehicle: {
      type: 'object',
      description: 'Транспортное средство если упомянуто в счёте (для счетов за перевозку).',
      properties: {
        plate: { type: 'string', description: 'Гос. номер ТС (формат А777ОО777 / К123АВ77).' },
        // EXT-LINE-4 (SLAI 2026-06-03): доп. метаданные ТС для негабарита.
        model: { type: 'string', description: 'Модель тягача. Пример: "MAN TGS 33.480".' },
        trailer: { type: 'string', description: 'Модель прицепа/трала. Пример: "Goldhofer STZ-VL5".' },
        axles: { type: 'integer', description: 'Количество осей (для негабарита — определяет тип трала).' },
      },
    },
    route_from: {
      type: 'string',
      description: 'Город отправления из блока «Маршрут плеча» («г. Москва → г. Челябинск»).',
    },
    route_to: {
      type: 'string',
      description: 'Город назначения из блока «Маршрут плеча».',
    },
    permit_no: {
      type: 'string',
      description: 'Номер спецразрешения (для негабаритных перевозок). Из «согласно спецразрешению № 77-2026-12345».',
    },
    // ── EXT-LINE-3 (SLAI 2026-06-03 P0): платёжный блок.
    due_date: {
      type: 'string',
      description: 'Срок оплаты счёта (ISO YYYY-MM-DD). Из «оплатить до DD.MM.YYYY», «срок оплаты DD.MM.YYYY».',
    },
    payment_method: {
      type: 'string',
      enum: ['cash', 'bank_transfer', 'prepayment', 'postpayment', 'card', 'other'],
      description: 'Способ оплаты. Один из: cash (нал), bank_transfer (б/н), prepayment (предоплата), postpayment (постоплата), card, other.',
    },
    // ── EXT-LINE-4 (SLAI 2026-06-03 P1): транспортный nested-блок.
    // Дублирует часть плоских полей выше (order_ref, vehicle.plate, route_*,
    // permit_no) — оставлены для backwards compat с EXT-LINE-2. Новые
    // структурированные поля (cargo, escort, permit details, route.leg_kind)
    // живут только тут.
    transport: {
      type: 'object',
      description: 'Транспортный nested-блок для перевозочных счетов (дублирует плоские поля + расширяет).',
      properties: {
        vehicle: {
          type: 'object',
          properties: {
            plate: { type: 'string', description: 'Гос. номер ТС (А777ОО777).' },
            model: { type: 'string' },
            trailer: { type: 'string' },
            axles: { type: 'integer' },
          },
        },
        driver: {
          type: 'object',
          description: 'Водитель (doc-level зеркало items[].driver_name + опц. license/phone).',
          properties: {
            name: { type: 'string' },
            license: { type: 'string', description: 'Номер водительского удостоверения' },
            phone: { type: 'string' },
          },
        },
        route: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            distance_km: { type: 'number', description: 'Расстояние только если явно указано в тексте PDF (не вычисляем).' },
            leg_kind: {
              type: 'string',
              enum: ['auto', 'rail', 'sea', 'air', 'customs'],
              description: 'Тип плеча: auto (авто), rail (ЖД), sea (море), air (авиа), customs (таможня).',
            },
          },
        },
        trip_date: {
          type: 'string',
          description: 'Дата выезда / начала рейса (ISO YYYY-MM-DD). Из «от DD.MM.YYYY», «выезд DD.MM.YYYY».',
        },
        permit: {
          type: 'object',
          properties: {
            number: { type: 'string', description: 'Номер спецразрешения (77-2026-12345).' },
            issued_by: { type: 'string', description: 'Кем выдано (Росавтодор, региональный орган).' },
            valid_to: { type: 'string', description: 'Действительно до (ISO YYYY-MM-DD).' },
          },
        },
        cargo: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Описание груза («трансформатор силовой ТДЦ-400000/500»).' },
            weight_kg: { type: 'number', description: 'Вес в килограммах. Если в тексте «35 т» → 35000.' },
            dimensions: {
              type: 'object',
              description: 'Габариты в метрах. Если не парсится в struct — оставить null, raw в dimensions_raw.',
              properties: {
                length_m: { type: 'number' },
                width_m: { type: 'number' },
                height_m: { type: 'number' },
              },
            },
            dimensions_raw: { type: 'string', description: 'Исходная строка габаритов если не распарсилась.' },
            oversized: { type: 'boolean', description: 'Негабаритный груз (есть упоминание «негабарит»/«крупногабарит»/«тяжеловес»).' },
          },
        },
        escort: {
          type: 'object',
          description: 'Сопровождение перевозки (спец-фича негабарита).',
          properties: {
            required: { type: 'boolean' },
            type: { type: 'string', description: 'Тип сопровождения: «ГИБДД-патруль», «машина прикрытия», «лоцман»' },
            area: { type: 'string', description: 'Зона сопровождения: «московский участок», «весь маршрут»' },
          },
        },
      },
    },
    items: ITEMS_ARRAY,
    document_stage: {
      type: 'string',
      enum: ['draft', 'proforma', 'final'],
      description:
        'Стадия документа. draft — если есть явный маркер черновика (watermark «DRAFT», «ПРОЕКТ», «предварительный»); final — если явно «FINAL»/«ORIGINAL»/чистовик. Нет явного маркера — опусти (по умолчанию трактуется как final).',
    },
  },
} as const;

const TTN_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер ТТН (например МСК-2026/045)' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Грузоотправитель' },
    consignee: { ...PARTY, description: 'Грузополучатель' },
    payer: { ...PARTY, description: 'Плательщик (если отличается от отправителя)' },
    // EXT-TTN-1 (SLAI 2026-06-04 Q-TTN-CMR-BL-SCHEMA P0): perevozchik отдельно
    // от грузоотправителя — SLAI matcher.matchToTransfer ищет именно carrier.inn
    // для привязки к плечу (Transfer).
    carrier: {
      ...PARTY,
      description: 'Перевозчик (компания-исполнитель перевозки). Может отличаться от shipper. Critical для matcher.matchToTransfer.',
    },
    // Был один объект `cargo` — теперь массив items[] (реальная ТТН-1.2 раздел 1
    // содержит таблицу). Сводный cargo оставлен для backward-compat и для случая
    // когда документ описывает один груз одной строкой.
    cargo: {
      type: 'object',
      description: 'Сводная характеристика груза (используется когда в ТТН одна позиция или нужен общий итог)',
      properties: {
        name: { type: 'string', description: 'Краткое наименование («Кран башенный»)' },
        description: { type: 'string', description: 'Полное описание груза («Кран башенный, 1 шт»)' },
        quantity: { type: 'number' },
        weight_gross: { type: 'number', description: 'Масса брутто, кг' },
        weight_nett: { type: 'number', description: 'Масса нетто, кг' },
        weight_kg: { type: 'number', description: 'Унифицированный вес в кг (alias для weight_gross)' },
        places: { type: 'number', description: 'Количество грузовых мест (паллет/ящиков)' },
        units_count: { type: 'integer', description: 'Число единиц груза (для штучных позиций)' },
        places_count: { type: 'integer', description: 'Alias для places' },
        volume_m3: { type: 'number', description: 'Объём в кубометрах' },
        dangerous_class: {
          type: 'string',
          description: 'Класс опасности ADR (1, 2.1, 3, 6.1, 8 и т.д.). Null если не опасный.',
        },
      },
    },
    items: ITEMS_ARRAY,
    vehicle: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'Гос. номер ТС (формат А123ВС777). Critical для matcher.matchToTransfer.' },
        trailer_plate: { type: 'string', description: 'Номер прицепа' },
        model: { type: 'string', description: 'Модель тягача (MAN/Volvo/КАМАЗ ...)' },
      },
    },
    // EXT-TTN-1 P0: driver как отдельный объект (раньше был просто vehicle.driver:string)
    driver: {
      type: 'object',
      description: 'Водитель — для SLAI auto-matcher.',
      properties: {
        fullName: { type: 'string', description: 'ФИО водителя как написано в ТТН («Иванов Иван Иванович»)' },
        license: { type: 'string', description: 'Номер водительского удостоверения' },
        phone: { type: 'string', description: 'Телефон водителя (если указан, +7XXXXXXXXXX)' },
      },
    },
    // EXT-TTN-1 P0: structured route — для matcher.matchToTransfer (поиск плеча).
    route: {
      type: 'object',
      description: 'Маршрут перевозки. from_city/to_city — нормализованные имена городов для SLAI matcher.',
      properties: {
        from: { type: 'string', description: 'Полный адрес погрузки («Москва, ул. Тверская, 1»)' },
        to: { type: 'string', description: 'Полный адрес разгрузки («Казань, ул. Баумана, 5»)' },
        from_city: { type: 'string', description: 'Город отправления нормализованный («Москва»)' },
        to_city: { type: 'string', description: 'Город назначения нормализованный («Казань»)' },
      },
    },
    // Backwards compat: loading_point/unloading_point оставлены как алиасы.
    loading_point: { type: 'string', description: 'Alias для route.from (адрес погрузки)' },
    unloading_point: { type: 'string', description: 'Alias для route.to (адрес разгрузки)' },
    loading_date: { type: 'string', description: 'Дата погрузки (ISO YYYY-MM-DD). Может отличаться от document_date.' },
    unloading_date: { type: 'string', description: 'Дата разгрузки (ISO YYYY-MM-DD).' },
    seal_number: {
      type: 'string',
      description: 'Номер пломбы. Critical для matcher.matchToCargoUnit (контейнер/прицеп).',
    },
    additional_terms: {
      type: 'string',
      description: 'Свободный текст условий внизу ТТН (особые отметки, оговорки).',
    },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (CMR, счёт-фактура, путевой лист)',
      items: { type: 'string' },
    },
    // ── extraction-gap audit 2026-06-26: расчёт перевозки + путевой лист.
    cost_of_carriage: { type: 'number', description: 'Стоимость перевозки (раздел расчётов 1-Т), руб. — для сверки фрахта.' },
    total_in_words: { type: 'string', description: 'Итоговая сумма прописью — контроль ошибок OCR.' },
    distance_km: { type: 'number', description: 'Расстояние перевозки в км, если явно указано (не вычисляем).' },
    trip_ticket_number: { type: 'string', description: 'Номер путевого листа, связывающего ТТН с рейсом/ТС.' },
    order_refs: ORDER_REFS,
    containers: CONTAINERS,
    container_number: CONTAINER_NUMBER,
  },
} as const;

const CMR_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер CMR (например CMR-RU-2026-1234)' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    // EXT-TTN-1 (SLAI 2026-06-04): canonical naming consignor/consignee
    // как в IRU CMR convention (ячейки 1 и 2). Старые sender/recipient
    // оставлены ниже как алиасы для backwards compat.
    consignor: { ...PARTY_WITH_COUNTRY, description: 'Отправитель / consignor (ячейка 1)' },
    consignee: { ...PARTY_WITH_COUNTRY, description: 'Получатель / consignee (ячейка 2)' },
    sender: { ...PARTY_WITH_COUNTRY, description: 'Alias для consignor (legacy).' },
    recipient: { ...PARTY_WITH_COUNTRY, description: 'Alias для consignee (legacy).' },
    carrier: {
      ...PARTY,
      description: 'Перевозчик (ячейка 16). Critical для matcher.matchToTransfer.',
    },
    successive_carrier: {
      ...PARTY,
      description: 'Последующий перевозчик (ячейка 17), если перевозка multi-leg.',
    },
    cargo: {
      type: 'object',
      description: 'Характеристика груза (разделы 6-12 CMR)',
      properties: {
        marks: { type: 'string', description: 'Маркировка (ячейка 6)' },
        description: { type: 'string', description: 'Описание груза (ячейка 9)' },
        packages: {
          type: 'array',
          description: 'Упаковка (ячейки 7-8): тип + количество. Может быть несколько разнотипных.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Тип («паллет», «коробок», «cases»)' },
              count: { type: 'integer', description: 'Количество мест данного типа' },
            },
          },
        },
        packages_total: { type: 'integer', description: 'Общее число мест (sum по packages[].count). Alias для legacy.' },
        packages_kind: { type: 'string', description: 'Вид упаковки одной строкой (CTN/PLT/…), если груз однородный (VANGA-VED-1 §3.1).' },
        weight: { type: 'number', description: 'Вес брутто, кг (legacy alias)' },
        gross_weight_kg: { type: 'number', description: 'Вес брутто в кг С ПАЛЛЕТАМИ (ячейка 11).' },
        // VANGA-VED-1 §3.1/§4: транзитная сверка требует различать брутто
        // с паллетами и без. Реальные данные: нетто 16026.96, брутто-без
        // 17653.02, брутто-с 18528.02 — три разных числа, нельзя путать.
        gross_weight_without_pallets: { type: 'number', description: 'Вес брутто без паллет, кг (VANGA-VED-1 §3.1).' },
        pallets_weight: { type: 'number', description: 'Вес паллет, кг (gross_weight − gross_weight_without_pallets).' },
        pallets: { type: 'integer', description: 'Количество паллет (не путать с packages/мест).' },
        volume: { type: 'number', description: 'Объём, м³ (legacy alias)' },
        volume_m3: { type: 'number', description: 'Объём в м³ (ячейка 12)' },
      },
    },
    items: ITEMS_ARRAY,
    // EXT-TTN-1: structured places — canonical name «place_of_loading / place_of_delivery».
    place_of_loading: { type: 'string', description: 'Место погрузки (ячейка 4)' },
    place_of_delivery: { type: 'string', description: 'Место разгрузки (ячейка 3)' },
    loading_place: { type: 'string', description: 'Alias для place_of_loading (legacy).' },
    delivery_place: { type: 'string', description: 'Alias для place_of_delivery (legacy).' },
    // ── VANGA-VED-1 §3.1: транзитный CMR-комплект (реальные данные БКТ Транзит) ──
    place_of_taking_over: { type: 'string', description: 'Место принятия груза к перевозке (ячейка 4, если отличается от place_of_loading).' },
    taking_over_date: { type: 'string', description: 'Дата принятия груза к перевозке, ISO YYYY-MM-DD.' },
    border_crossing: { type: 'string', description: 'Погранпереход / КПП выезда (например EU/LTVK2000).' },
    driver: {
      type: 'object',
      description: 'Водитель, если указан в CMR.',
      properties: {
        fio: { type: 'string', description: 'ФИО водителя как в документе (script-флаг проставляется нормализатором).' },
      },
    },
    declared_value: {
      type: 'object',
      description: 'Объявленная стоимость груза (ячейка 13).',
      properties: {
        amount: { type: 'number', description: 'Сумма.' },
        currency: { type: 'string', description: 'Валюта, ISO 4217.' },
      },
    },
    hs_codes: {
      type: 'array',
      description: 'Коды ТН ВЭД на уровне документа (ячейка 10 «Статист. №»), если перечислены в шапке. Позиционные — в items[].hs_code.',
      items: { type: 'string' },
    },
    carrier_reservations: { type: 'string', description: 'Оговорки и замечания перевозчика (ячейка 18).' },
    vehicle: {
      type: 'object',
      description: 'Транспортное средство (ячейка 25).',
      properties: {
        plate: { type: 'string', description: 'Гос. номер ТС' },
        trailer_plate: { type: 'string', description: 'Номер прицепа' },
      },
    },
    issued_at: {
      type: 'object',
      description: 'Место и дата выдачи CMR (ячейка 21).',
      properties: {
        place: { type: 'string' },
        date: { type: 'string', description: 'ISO YYYY-MM-DD' },
      },
    },
    incoterms: {
      type: 'string',
      description: 'Условия поставки Incoterms (EXW, FCA, CIP, DAP, DDP, FOB, CIF, …)',
    },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (invoice, packing_list)',
      items: { type: 'string' },
    },
    // ── extraction-gap audit 2026-06-26: приёмка груза (ячейка 24) —
    // отличает «доставлен» от «в пути» для SLAI matcher.
    goods_received: {
      type: 'object',
      description: 'Приёмка груза получателем (ячейка 24 CMR): факт и дата выдачи.',
      properties: {
        date: { type: 'string', description: 'Дата приёмки груза (ISO YYYY-MM-DD).' },
        place: { type: 'string', description: 'Место приёмки.' },
        signed_by: { type: 'string', description: 'Кто принял (ФИО/должность), если указано.' },
      },
    },
    order_refs: ORDER_REFS,
    containers: CONTAINERS,
    container_number: CONTAINER_NUMBER,
  },
} as const;

// EXT-TTN-1 (SLAI 2026-06-04 Q-TTN-CMR-BL-SCHEMA P1): новая схема для
// коносамента (B/L). Multi-container — массив containers[], vessel/voyage
// для морских перевозок. Critical поля для SLAI matcher:
//   - bl.number + bl.vessel → найти Transfer (морское плечо)
//   - containers[].number → найти CargoUnit (контейнер)
const BL_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер коносамента (например MSCUSE12345678).' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Отправитель (грузоотправитель).' },
    consignee: { ...PARTY, description: 'Получатель.' },
    notify_party: {
      ...PARTY,
      description: 'Уведомляемая сторона (notify party) — кому сообщить о прибытии груза.',
    },
    vessel: {
      type: 'object',
      description: 'Морское судно.',
      properties: {
        name: { type: 'string', description: 'Название судна («MSC LUCERNE»)' },
        voyage: { type: 'string', description: 'Номер рейса («VOY-2026-12W»)' },
        imo: { type: 'string', description: 'IMO-номер судна (если указан)' },
      },
    },
    port_of_loading: { type: 'string', description: 'Порт погрузки (POL, «Shanghai»)' },
    port_of_discharge: { type: 'string', description: 'Порт выгрузки (POD, «Vladivostok»)' },
    place_of_receipt: {
      type: 'string',
      description: 'Место приёма груза (если отличается от POL, для intermodal — «Shanghai CY»)',
    },
    place_of_delivery: {
      type: 'string',
      description: 'Место доставки (если отличается от POD, для intermodal — «Moscow»)',
    },
    containers: {
      type: 'array',
      description: 'Контейнеры. Может быть несколько. Critical для matcher.matchToCargoUnit.',
      items: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Номер контейнера (ISO 6346: 4 буквы + 7 цифр, MSCU1234567)' },
          seal: { type: 'string', description: 'Номер пломбы (ABC123)' },
          type: { type: 'string', description: 'Тип контейнера (20DC, 40HC, 40RF, 45HC, ...)' },
          tare_kg: { type: 'number', description: 'Вес тары в кг' },
          gross_weight_kg: { type: 'number', description: 'Вес брутто этого контейнера' },
        },
      },
    },
    cargo: {
      type: 'object',
      description: 'Сводная характеристика груза.',
      properties: {
        description: { type: 'string', description: 'Описание («Industrial equipment»)' },
        gross_weight_kg: { type: 'number', description: 'Общий вес брутто, кг' },
        volume_m3: { type: 'number', description: 'Объём в м³' },
        packages_count: { type: 'integer', description: 'Общее количество мест' },
        package_type: { type: 'string', description: 'Тип упаковки («cases», «pallets», «cartons»)' },
      },
    },
    freight_terms: {
      type: 'string',
      enum: ['PREPAID', 'COLLECT', 'PAYABLE_AT_DESTINATION'],
      description: 'Условия фрахта.',
    },
    incoterm: {
      type: 'string',
      description: 'Incoterm с указанием места («FOB Shanghai», «CIF Vladivostok»)',
    },
    booking_number: {
      type: 'string',
      description: 'Номер букинга у линии (если указан в B/L).',
    },
    // ── extraction-gap audit 2026-06-26: дата экспорта + перевозчик + реквизиты выпуска.
    // shipped_on_board питает канонический match-signal dates.shipped_on_board (PD-CONTRACT-1).
    shipped_on_board: {
      type: 'string',
      description: 'Дата «Shipped on board» (ISO YYYY-MM-DD) — фактическая погрузка на судно. Дата экспорта и ключ для L/C.',
    },
    carrier: { type: 'string', description: 'Перевозчик / морская линия (MAERSK, MSC, COSCO, FESCO). Часто указан в подписи внизу: «on behalf of the Ocean Carrier, X». Не экспедитор и не грузоотправитель.' },
    service_name: { type: 'string', description: 'Название сервиса/линии перевозки, если указано (например «Fesco China Direct Line»).' },
    place_of_issue: { type: 'string', description: 'Место выдачи коносамента.' },
    date_of_issue: { type: 'string', description: 'Дата выдачи коносамента (ISO YYYY-MM-DD), если отличается от date.' },
    number_of_original_bls: { type: 'integer', description: 'Количество оригиналов B/L (обычно 3).' },
    bl_type: { type: 'string', description: 'Тип: Master / House / Sea Waybill.' },
    master_bl_number: {
      type: 'string',
      description:
        'Номер МАСТЕР-коносамента (ocean/master B/L), если этот документ — House B/L (HBL) под мастером. На самом Master B/L НЕ заполнять.',
    },
    release_type: {
      type: 'string',
      enum: ['original', 'telex_release', 'seaway_waybill', 'surrendered'],
      description:
        'Состояние выпуска B/L: original (выданы бумажные оригиналы), telex_release (телекс-релиз / surrendered по телексу), seaway_waybill (морская накладная, без оборотного оригинала), surrendered (оригиналы сданы перевозчику). Заполняй ТОЛЬКО при явном маркере в документе (штамп/текст «TELEX RELEASE», «SURRENDERED», «SEA WAYBILL», «3/3 ORIGINALS»). Нет маркера — опусти.',
    },
    document_stage: {
      type: 'string',
      enum: ['draft', 'proforma', 'final'],
      description:
        'Стадия документа. draft — если есть явный маркер черновика (watermark «DRAFT», «ПРОЕКТ», «предварительный»); final — если явно «FINAL»/«ORIGINAL»/чистовик. Нет явного маркера — опусти (по умолчанию трактуется как final).',
    },
    scac_code: { type: 'string', description: 'SCAC-код перевозчика (4 буквы), если указан.' },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (commercial invoice, packing list, certificate of origin)',
      items: { type: 'string' },
    },
    order_refs: ORDER_REFS,
  },
} as const;

// F16 (SLAI ТЗ): заявка на перевозку.
// Документ-первичка между заказчиком логистики (client) и исполнителем
// (carrier/экспедитором). Создаётся ДО фактической перевозки, фиксирует
// договорённости: что везём, откуда-куда, какой машиной/водителем,
// в какие сроки, за какую ставку.
//
// Часто использует «открытый рынок» — поля vehicle/trailer/driver
// могут быть пустыми (carrier подбирает машину позже). Multi-stop —
// route.loading и route.unloading могут быть массивами.
//
// См. SLAI ТЗ v1.0 раздел 3.2 для примера JSON и acceptance критериев.
const TRANSPORT_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер заявки' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    client: {
      ...PARTY,
      description: 'Заказчик логистических услуг (грузовладелец)',
    },
    carrier: {
      ...PARTY,
      description: 'Исполнитель — перевозчик или экспедитор',
    },
    route: {
      type: 'object',
      description:
        'Маршрут перевозки. Для multi-stop точки могут быть массивами; ' +
        'для одного pickup → одного drop — объектами.',
      properties: {
        loading: {
          // Либо одна точка (object), либо несколько (array of objects).
          // JSON Schema oneOf — но мы оставляем permissive (LLM выберет
          // адекватный тип по контексту).
          type: ['object', 'array'],
          description: 'Точка(и) погрузки',
          properties: {
            name: { type: 'string', description: 'Название склада/площадки' },
            address: { type: 'string' },
            city: { type: 'string' },
            datetime: { type: 'string', description: 'Срок подачи под погрузку (ISO 8601)' },
            contact: { type: 'string', description: 'Контактное лицо на точке + телефон' },
          },
        },
        unloading: {
          type: ['object', 'array'],
          description: 'Точка(и) разгрузки',
          properties: {
            name: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            datetime: { type: 'string', description: 'Срок доставки' },
            contact: { type: 'string' },
          },
        },
        intermediate_stops: {
          type: 'array',
          items: { type: 'object' },
          description: 'Промежуточные остановки (перегрузка / consolidation)',
        },
      },
    },
    cargo: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Наименование груза' },
        weight_t: { type: 'number', description: 'Масса груза в тоннах' },
        volume_m3: { type: 'number', description: 'Объём груза в м³' },
        places: { type: 'number', description: 'Количество мест (паллет/коробов)' },
        temperature: {
          type: 'string',
          description: 'Температурный режим как написан ("+4°C ÷ +6°C", "-18°C", "охлаждённый")',
        },
        dangerous_class: { type: 'string', description: 'Класс ADR/ДОПОГ если опасный груз' },
        customs_info: {
          type: 'string',
          description: 'Таможенная информация для международных перевозок',
        },
      },
    },
    vehicle: {
      type: 'object',
      description:
        'Транспортное средство. NULL если открытый рынок (carrier подбирает машину после заявки)',
      properties: {
        plate: { type: 'string', description: 'Гос.номер тягача (А123БВ77 или 3-знач регион)' },
        model: { type: 'string', description: 'Марка и модель (MAN TGX 18.440, ...)' },
        vin: { type: 'string' },
        year: { type: 'number', description: 'Год выпуска' },
        capacity_t: { type: 'number', description: 'Грузоподъёмность, тонн' },
      },
    },
    trailer: {
      type: 'object',
      description: 'Прицеп/полуприцеп (опционально)',
      properties: {
        plate: { type: 'string' },
        model: { type: 'string' },
        type: {
          type: 'string',
          description: 'Тип кузова: "изотерм", "тент", "рефрижератор", "контейнеровоз", "цистерна"',
        },
        volume_m3: { type: 'number' },
      },
    },
    driver: {
      type: 'object',
      description: 'Водитель. NULL если открытый рынок',
      properties: {
        fio: { type: 'string' },
        license: { type: 'string', description: 'Номер вод.удостоверения' },
        passport: { type: 'string', description: 'Серия+номер паспорта' },
        phone: { type: 'string' },
      },
    },
    rate: {
      type: 'object',
      description: 'Стоимость перевозки',
      properties: {
        amount: { type: 'number', description: 'Сумма к оплате' },
        currency: { type: 'string', description: 'ISO 4217 (RUB по умолчанию)' },
        vat_included: { type: 'boolean', description: '`true` если сумма включает НДС' },
        vat_rate: { type: 'number', description: 'Ставка НДС перевозчика (0 / 10 / 20)' },
        payment_terms: {
          type: 'string',
          description:
            'Условия оплаты как написаны ("Безнал, 10 банковских дней", "100% предоплата", "По факту"))',
        },
      },
    },
    additional_terms: {
      type: 'string',
      description: 'Дополнительные условия / штрафы / договорные пункты',
    },
    contact_responsible: {
      type: 'object',
      description: 'Ответственный за заявку (логист со стороны заказчика)',
      properties: {
        fio: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
      },
    },
    parent_contract_number: { type: 'string', description: 'Номер договора-основания' },
    parent_contract_date: { type: 'string', description: 'Дата договора-основания' },
  },
} as const;

// F17 (SLAI ТЗ): транспортная накладная формы 2013 (новая ТН).
// Утверждена Постановлением Правительства РФ № 272 от 15.04.2011 и
// заменила собой форму 1-Т (ТТН) с 2013 года. Используется когда
// автомобильный перевозчик не является продавцом и нужен отдельный
// документ перевозки.
//
// Отличия от старой ТТН (форма 1-Т):
//   - НЕТ товарного раздела (раздел 1 ТТН-1.2)
//   - Графа «Условия перевозки» (вода, температура, опасный груз)
//   - Графа 15 «Стоимость услуг перевозки»
//   - Графы 6 и 7 «Сроки доставки»
//   - 4 точки подписей: отправитель / водитель-приём / водитель-сдача / получатель
//
// Слаg = `transport_invoice` (наш каноничный), SLAI шлёт его так же.
const TRANSPORT_INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер ТН' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Грузоотправитель (графа 1)' },
    consignee: { ...PARTY, description: 'Грузополучатель (графа 2)' },
    carrier: { ...PARTY, description: 'Перевозчик (графа 10)' },
    payer: { ...PARTY, description: 'Плательщик за перевозку (если отличается от отправителя)' },
    cargo_description: {
      type: 'string',
      description: 'Общее описание груза (графа 3). НЕ таблица — описание текстом',
    },
    items: {
      ...ITEMS_ARRAY,
      description:
        'Если в ТН есть приложение со списком позиций (необязательно для формы 2013). ' +
        'Чаще груз указан одной строкой в cargo_description',
    },
    cargo_summary: {
      type: 'object',
      description: 'Сводные характеристики груза (графа 4)',
      properties: {
        places: { type: 'number', description: 'Количество грузовых мест' },
        weight_gross: { type: 'number', description: 'Масса брутто, кг' },
        weight_nett: { type: 'number', description: 'Масса нетто, кг' },
        volume_m3: { type: 'number', description: 'Объём груза, м³' },
        dangerous_class: { type: 'string', description: 'Класс опасности (если ADR/ДОПОГ)' },
      },
    },
    conditions: {
      type: 'object',
      description: 'Условия перевозки (графа 8) — климат, температура, особые требования',
      properties: {
        temperature_min_c: { type: 'number' },
        temperature_max_c: { type: 'number' },
        humidity: { type: 'string' },
        special_marks: { type: 'string', description: 'Особые отметки (хрупкое, не кантовать, …)' },
      },
    },
    declared_value: {
      type: 'number',
      description: 'Заявленная стоимость груза (графа 5) — для определения ответственности перевозчика',
    },
    delivery_terms: {
      type: 'object',
      description: 'Графы 6 (приём груза) и 7 (выдача груза)',
      properties: {
        pickup_datetime: { type: 'string', description: 'Срок подачи под погрузку' },
        delivery_datetime: { type: 'string', description: 'Срок доставки' },
      },
    },
    vehicle: {
      type: 'object',
      description: 'ТС (графы 11 + 13)',
      properties: {
        plate: { type: 'string', description: 'Гос.номер тягача (А123БВ77)' },
        model: { type: 'string', description: 'Модель ТС' },
        trailer_plate: { type: 'string', description: 'Номер прицепа/полуприцепа' },
        trailer_model: { type: 'string' },
        weight_unladen: { type: 'number', description: 'Снаряжённая масса ТС' },
      },
    },
    driver: {
      type: 'object',
      properties: {
        fio: { type: 'string', description: 'ФИО водителя' },
        license: { type: 'string', description: 'Серия и номер вод.удостоверения' },
        phone: { type: 'string' },
      },
    },
    loading_point: {
      type: 'object',
      description: 'Точка погрузки (графа 6)',
      properties: {
        address: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string', description: 'ISO 3166 alpha-2 (RU, KZ, BY)' },
      },
    },
    unloading_point: {
      type: 'object',
      description: 'Точка разгрузки (графа 7)',
      properties: {
        address: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string' },
      },
    },
    service_cost: {
      type: 'object',
      description: 'Стоимость услуг перевозки (графа 15)',
      properties: {
        amount: { type: 'number', description: 'Сумма к оплате перевозчику' },
        currency: { type: 'string', description: 'ISO 4217 (RUB по умолчанию)' },
        vat_rate: { type: 'number', description: 'Ставка НДС перевозчика, %' },
        vat_amount: { type: 'number' },
        amount_with_vat: { type: 'number' },
      },
    },
    forwarder: {
      ...PARTY,
      description: 'Экспедитор (графа 9), если перевозка осуществляется через экспедитора',
    },
    transport_docs: {
      type: 'array',
      description: 'Прилагаемые документы (паспорт груза, сертификат, СНТ, …)',
      items: { type: 'string' },
    },
    distance_km: { type: 'number', description: 'Расстояние перевозки в километрах' },
  },
} as const;

// F18 (SLAI ТЗ): путевой лист.
// Это документ для водителя на грузовое (форма 4-С), легковое (4-П) или
// такси (ПЛ-1). Подтверждает выезд ТС на маршрут, расход топлива,
// прохождение пред-/после-рейсового медосмотра водителя и техосмотра ТС.
// В отличие от ТТН — не имеет товарной части (груз указывается общим
// объёмом / весом / маршрутом, без перечисления позиций).
const WAYBILL_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Номер путевого листа' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    form: {
      type: 'string',
      description: 'Форма путевого листа: "4-С" (грузовой), "4-П" (легковой), "ПЛ-1" (такси) или иная',
    },
    organization: {
      ...PARTY,
      description: 'Организация-владелец ТС (юр.лицо или ИП)',
    },
    vehicle: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'Госномер ТС (А123БВ77 или с трёхзначным регионом)' },
        model: { type: 'string', description: 'Марка/модель ТС (KamAZ-5320, MAN TGX 18.440, ...)' },
        type: {
          type: 'string',
          description: 'Тип ТС: "грузовой", "легковой", "автобус", "тягач", "самосвал", ...',
        },
        vin: { type: 'string' },
        registration_certificate: { type: 'string', description: 'Серия и номер СТС/ПТС' },
      },
    },
    trailer: {
      type: 'object',
      description: 'Прицеп (опционально)',
      properties: {
        plate: { type: 'string' },
        model: { type: 'string' },
      },
    },
    driver: {
      type: 'object',
      properties: {
        fio: { type: 'string', description: 'ФИО водителя' },
        license: { type: 'string', description: 'Номер вод.удостоверения (XX XX 123456)' },
        tab_number: { type: 'string', description: 'Табельный номер сотрудника' },
        passport: { type: 'string', description: 'Серия и номер паспорта (если указан)' },
      },
    },
    route: {
      type: 'object',
      properties: {
        departure_point: { type: 'string', description: 'Откуда (адрес/название точки)' },
        destination_point: { type: 'string', description: 'Куда' },
        intermediate_stops: {
          type: 'array',
          items: { type: 'string' },
          description: 'Промежуточные остановки (адреса/названия)',
        },
        purpose: {
          type: 'string',
          description: 'Цель поездки: "перевозка груза", "доставка", "командировка", и т.п.',
        },
      },
    },
    departure_time: {
      type: 'string',
      description: 'Время выезда из гаража (YYYY-MM-DDTHH:MM:SS или HH:MM)',
    },
    return_time: { type: 'string', description: 'Время возврата в гараж' },
    odometer_start: { type: 'number', description: 'Показания спидометра при выезде, км' },
    odometer_end: { type: 'number', description: 'Показания спидометра при возврате, км' },
    distance_total: { type: 'number', description: 'Пробег за рейс, км' },
    fuel: {
      type: 'object',
      properties: {
        fuel_type: { type: 'string', description: 'Тип топлива: "ДТ" (дизель), "АИ-92", "АИ-95", "газ", "ГБО"' },
        rate_per_100km: { type: 'number', description: 'Норма расхода, л/100км' },
        issued_volume: { type: 'number', description: 'Выдано топлива, л' },
        remaining_start: { type: 'number', description: 'Остаток в баке при выезде, л' },
        remaining_end: { type: 'number', description: 'Остаток в баке при возврате, л' },
        consumed_volume: { type: 'number', description: 'Фактически израсходовано, л' },
      },
    },
    medical_check: {
      type: 'object',
      description: 'Предрейсовый медосмотр водителя',
      properties: {
        passed: { type: 'boolean' },
        timestamp: { type: 'string', description: 'Время прохождения медосмотра' },
        doctor_signature: { type: 'string', description: 'ФИО медработника' },
      },
    },
    technical_check: {
      type: 'object',
      description: 'Предрейсовый техосмотр ТС',
      properties: {
        passed: { type: 'boolean' },
        timestamp: { type: 'string' },
        mechanic_signature: { type: 'string', description: 'ФИО механика' },
      },
    },
    cargo_description: {
      type: 'string',
      description:
        'Краткое описание груза без перечисления позиций. Если есть детальная номенклатура — она в отдельной ТТН',
    },
    cargo_weight: { type: 'number', description: 'Общая масса груза, кг (если указано)' },
    notes: { type: 'string', description: 'Произвольные заметки в путевом листе' },
  },
} as const;

const AKT_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    party_a: { ...PARTY, description: 'Исполнитель' },
    party_b: { ...PARTY, description: 'Заказчик' },
    currency: { type: 'string', description: 'Валюта (ISO 4217, по умолчанию RUB)' },
    total: { type: 'number' },
    total_without_vat: { type: 'number' },
    vat: { type: 'number', description: 'Сумма НДС (0 для УСН)' },
    vat_rate: { type: 'number' },
    vat_summary: VAT_SUMMARY,
    flags: FLAGS,
    // ── extraction-gap audit 2026-06-26: контент акта + триггер закрытия/оплаты.
    total_in_words: { type: 'string', description: 'Итоговая сумма прописью — контроль ошибок OCR.' },
    service_description: { type: 'string', description: 'Описание оказанных услуг/работ (основной контент акта, если нет таблицы позиций).' },
    no_claims_flag: { type: 'boolean', description: '«Претензий по объёму/качеству/срокам не имеет» — триггер закрытия акта и оплаты.' },
    place_of_compilation: { type: 'string', description: 'Место составления акта (город).' },
    period_from: { type: 'string', description: 'Период оказания услуг с (YYYY-MM-DD)' },
    period_to: { type: 'string', description: 'Период оказания услуг по (YYYY-MM-DD)' },
    items: { ...ITEMS_ARRAY, description: 'Перечень оказанных услуг / работ' },
    parent_contract_number: { type: 'string', description: 'Номер договора-основания' },
    parent_contract_date: { type: 'string', description: 'Дата договора-основания' },
    order_refs: ORDER_REFS,
    containers: CONTAINERS,
    container_number: CONTAINER_NUMBER,
  },
} as const;

export const DOCUMENT_JSON_SCHEMAS: Record<DocumentType, Record<string, unknown>> = {
  invoice: INVOICE_SCHEMA,
  factInvoice: INVOICE_SCHEMA,
  UPD: INVOICE_SCHEMA,
  TTN: TTN_SCHEMA,
  CMR: CMR_SCHEMA,
  AKT: AKT_SCHEMA,
};

/**
 * F18: схемы для типов выходящих за `DOCUMENT_TYPES` (builtin'ы).
 * `waybill` живёт только через миграцию + DB-row в `document_types`, в этой
 * мапе — для UI/документации/тестов. Production-pipeline их подхватывает
 * через `documentTypesRepo` (не через hardcoded fallback).
 */
export const EXTENDED_SCHEMAS: Record<string, Record<string, unknown>> = {
  waybill: WAYBILL_SCHEMA,
  transport_invoice: TRANSPORT_INVOICE_SCHEMA,
  transport_request: TRANSPORT_REQUEST_SCHEMA,
  // EXT-TTN-1 (SLAI 2026-06-04): полноценная схема коносамента для morских
  // перевозок. Раньше bill_of_lading резолвился через generic-llm с {}
  // схемой и LLM возвращал гадание.
  bill_of_lading: BL_SCHEMA,
};

export const EXPECTED_FIELDS: Record<DocumentType, string[]> = {
  invoice: ['number', 'date', 'seller', 'buyer', 'total', 'items'],
  factInvoice: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'vat_summary', 'items'],
  UPD: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'items'],
  TTN: ['number', 'date', 'shipper', 'consignee', 'carrier', 'cargo', 'vehicle', 'driver', 'route', 'items'],
  CMR: ['number', 'date', 'consignor', 'consignee', 'carrier', 'place_of_loading', 'place_of_delivery', 'cargo', 'items'],
  AKT: ['number', 'date', 'party_a', 'party_b', 'total', 'items'],
};

/**
 * F18: expected_fields для типов вне `DocumentType`. Эти поля используются
 * для acceptance criteria SLAI ТЗ — `params.missing[]` в pipeline result.
 */
export const EXTENDED_EXPECTED_FIELDS: Record<string, string[]> = {
  waybill: ['number', 'date', 'organization', 'vehicle', 'driver', 'route', 'odometer_start'],
  // F17: ТН формы 2013 — обязательные поля для acceptance
  transport_invoice: [
    'number',
    'date',
    'shipper',
    'consignee',
    'carrier',
    'vehicle',
    'driver',
    'loading_point',
    'unloading_point',
    'cargo_summary',
  ],
  // F16: заявка на перевозку — критичные поля для SLAI matcher acceptance ≥ 90%
  // (vehicle/driver могут быть null для открытого рынка → не в обязательных)
  transport_request: [
    'number',
    'date',
    'client',
    'carrier',
    'route',
    'cargo',
    'rate',
  ],
};

/**
 * Re-export shared sub-schemas so DB-stored схемы (миграция 0014) могут
 * ссылаться на них из админ-UI / документации, не дублируя описания.
 *
 * Сейчас они инлайнятся в `llm_schema` в SQL, но если кто-то захочет
 * собрать схему из кусков (например через UI conf-builder) — эти куски
 * доступны как single-source-of-truth.
 */
export const SCHEMA_FRAGMENTS = {
  PARTY,
  PARTY_WITH_COUNTRY,
  PARTY_BANK,
  ITEM_PROPERTIES,
  ITEMS_ARRAY,
  VAT_SUMMARY,
  FLAGS,
} as const;
