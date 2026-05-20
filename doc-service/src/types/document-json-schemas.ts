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

const PARTY = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Наименование' },
    inn: { type: 'string', description: INN_DESCRIPTION },
    kpp: { type: 'string', description: KPP_DESCRIPTION },
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
    payment_terms: { type: 'string', description: 'Условия оплаты (например "до 15.12.2025")' },
    items: ITEMS_ARRAY,
  },
} as const;

const TTN_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    shipper: { ...PARTY, description: 'Грузоотправитель' },
    consignee: { ...PARTY, description: 'Грузополучатель' },
    payer: { ...PARTY, description: 'Плательщик (если отличается от отправителя)' },
    // Был один объект `cargo` — теперь массив items[] (реальная ТТН-1.2 раздел 1
    // содержит таблицу). Сводный cargo оставлен для backward-compat и для случая
    // когда документ описывает один груз одной строкой.
    cargo: {
      type: 'object',
      description: 'Сводная характеристика груза (используется когда в ТТН одна позиция или нужен общий итог)',
      properties: {
        name: { type: 'string' },
        quantity: { type: 'number' },
        weight_gross: { type: 'number', description: 'Масса брутто, кг' },
        weight_nett: { type: 'number', description: 'Масса нетто, кг' },
        places: { type: 'number', description: 'Количество грузовых мест' },
      },
    },
    items: ITEMS_ARRAY,
    vehicle: {
      type: 'object',
      properties: {
        plate: { type: 'string', description: 'Гос. номер ТС (формат А123БВ77)' },
        trailer_plate: { type: 'string', description: 'Номер прицепа' },
        driver: { type: 'string', description: 'ФИО водителя' },
        driver_license: { type: 'string', description: 'Номер водительского удостоверения' },
      },
    },
    loading_point: { type: 'string', description: 'Адрес погрузки' },
    unloading_point: { type: 'string', description: 'Адрес разгрузки' },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (CMR, счёт-фактура, путевой лист)',
      items: { type: 'string' },
    },
  },
} as const;

const CMR_SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    date: { type: 'string', description: DATE_DESCRIPTION },
    sender: { ...PARTY_WITH_COUNTRY, description: 'Отправитель (ячейка 1)' },
    recipient: { ...PARTY_WITH_COUNTRY, description: 'Получатель (ячейка 2)' },
    carrier: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
      },
      description: 'Перевозчик (ячейка 16)',
    },
    cargo: {
      type: 'object',
      description: 'Сводная характеристика (для разделов 6-12 CMR)',
      properties: {
        description: { type: 'string' },
        packages: { type: 'number', description: 'Количество мест' },
        weight: { type: 'number', description: 'Вес брутто, кг' },
        volume: { type: 'number', description: 'Объём, м³' },
      },
    },
    items: ITEMS_ARRAY,
    loading_place: { type: 'string', description: 'Место погрузки (ячейка 4)' },
    delivery_place: { type: 'string', description: 'Место разгрузки (ячейка 3)' },
    incoterms: {
      type: 'string',
      description: 'Условия поставки Incoterms (EXW, FCA, CIP, DAP, DDP, FOB, CIF, …)',
    },
    transport_docs: {
      type: 'array',
      description: 'Связанные документы (invoice, packing_list)',
      items: { type: 'string' },
    },
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
    period_from: { type: 'string', description: 'Период оказания услуг с (YYYY-MM-DD)' },
    period_to: { type: 'string', description: 'Период оказания услуг по (YYYY-MM-DD)' },
    items: { ...ITEMS_ARRAY, description: 'Перечень оказанных услуг / работ' },
    parent_contract_number: { type: 'string', description: 'Номер договора-основания' },
    parent_contract_date: { type: 'string', description: 'Дата договора-основания' },
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
};

export const EXPECTED_FIELDS: Record<DocumentType, string[]> = {
  invoice: ['number', 'date', 'seller', 'buyer', 'total', 'items'],
  factInvoice: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'vat_summary', 'items'],
  UPD: ['number', 'date', 'seller', 'buyer', 'total', 'vat', 'items'],
  TTN: ['number', 'date', 'shipper', 'consignee', 'cargo', 'vehicle', 'items'],
  CMR: ['number', 'date', 'sender', 'recipient', 'carrier', 'items'],
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
