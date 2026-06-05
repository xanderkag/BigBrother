# ТЗ: Распознавание и извлечение полей документов (parsdocs)

> **Назначение документа.** Полная техническая спецификация парсинга для
> передачи разработчику. Описывает: архитектуру пайплайна, общие конвенции
> (типы, нормализацию, валидаторы, confidence), классификацию и пер-типовые
> схемы извлечения по всем поддерживаемым типам документов.
>
> **Источник истины (код):**
> - Схемы builtin-типов: `doc-service/src/types/document-json-schemas.ts`,
>   `doc-service/src/types/documents.ts`
> - Валидаторы: `doc-service/src/pipeline/validation/validators.ts`,
>   `.../validation/index.ts`, `.../validation/registry.ts`
> - Классификатор: `shared/classifier-rules.json`,
>   `doc-service/src/pipeline/classifier/`
> - Типы из БД (custom/ВЭД): `doc-service/migrations/*.sql` (таблица `document_types`)
> - Контракт выдачи: `doc-service/docs/openapi/v1.yaml`
>
> Версия ТЗ: черновик 2026-06-05. Статус: на проработку разработчиком.

---

## 0. Глоссарий и статусы

| Термин | Значение |
|---|---|
| `document_type` (slug) | машинный код типа документа (`invoice`, `ttn`, …) |
| `parser_kind` | способ парсинга: `builtin:invoice_regex`, `builtin:upd_regex`, `llm_extract` |
| `tier` | зрелость типа: `stable` / `beta` / `experimental` (не влияет на рантайм, метка качества) |
| `extracted` | итоговый JSON извлечённых полей |
| `confidence` | агрегированная достоверность (OCR × classifier × parser), 0..1 |
| `_field_confidence` | пер-полевая калиброванная достоверность (dot-path → 0..1) |
| `needs_review` | статус «нужна проверка оператором» |

**Статусы job:** `pending` → `processing` → терминальный (`done` / `needs_review` / `failed`).

---

## 1. Архитектура пайплайна

```
ingest (upload | file_url)
  → OCR / text-extraction (выбор движка по mime)
    → classify (regex-правила + LLM-fallback)
      → parse (builtin regex | LLM /extract по JSON-схеме типа)
        → normalize (даты, ИНН, госномер, валюты, числа)
          → validate (доменные инварианты → _issues[])
            → confidence calibration (агрегат + per-field)
              → webhook delivery (+ polling GET /jobs/:id)
```

### 1.1. OCR / text-extraction движки (`ocr_engine`)

| Движок | Когда применяется |
|---|---|
| `pdf-text` | PDF с текстовым слоем — самый дешёвый fast-path |
| `tesseract` | растровые сканы (нет текстового слоя) |
| `vision-llm` | fallback (Qwen-VL / Claude vision) при низком качестве текста; для сканов СФ |
| `xlsx` | Excel-файлы (в т.ч. multi-sheet → multi-doc) |
| `docx` | Word-файлы |
| `yandex` | Yandex Vision — **отключён в проде** (риск 152-ФЗ), оставлен для совместимости |
| `transcribe` | ASR (речь→текст): транскрипт аудио заменяет OCR, далее тот же пайплайн (флаг `ASR_ENABLED`) |

**Hybrid-routing:** для чистых текстовых PDF — быстрый text-путь (в SLA), для
сканов/СФ/низкой OCR-уверенности — vision-fallback. Флаг `prefer_vision` у
типа форсирует vision (см. миграции `*_prefer_vision`, `*_force_llm`).

### 1.2. Multi-document (один файл → несколько документов)

Если исходный файл содержит несколько документов разных типов (счёт + ТТН +
акт в одном PDF; XLSX с несколькими листами) — пайплайн разбивает его на
сегменты по страницам/листам. В выдаче:
- `extracted` = доминирующий документ (крупнейший сегмент),
- `documents[]` = массив всех сегментов с `page_range`, `document_type`,
  `confidence`, `extracted`, `field_confidence`.

---

## 2. Общие конвенции извлечения

### 2.1. Принципы

1. **Все поля опциональны.** Модель/парсер заполняет только то, что нашёл.
   При отсутствии — поле опускается или `null`. **Никогда не выдумывать
   значение** (honest null).
2. **Унифицированный массив строк — всегда `items[]`** (исторические имена
   `positions`/`services`/`cargo` нормализуются в `items[]` на чтении).
3. **parsdocs нормализует** только то, что описано в §2.3. Часть сигналов
   (транспортные поля строк) отдаются «как написано» — канонизирует consumer.
4. **Числа — числами** (не строками), деньги без разделителей тысяч, точка
   как десятичный разделитель.
5. **Даты — ISO `YYYY-MM-DD`** после нормализации.

### 2.2. Общие под-схемы (переиспользуются в типах)

Источник: `SCHEMA_FRAGMENTS` в `document-json-schemas.ts`.

**`Party` — контрагент** (продавец/покупатель/отправитель/…):

| Поле | Тип | Описание / формат |
|---|---|---|
| `name` | string | Наименование |
| `inn` | string | ИНН: 10 цифр (ЮЛ) или 12 (ИП), checksum |
| `kpp` | string | КПП: 9 символов `NNNNCCNNN` |
| `ogrn` | string | ОГРН: 13 цифр (ЮЛ) / 15 (ИП) |
| `address` | string | Адрес |
| `bank` | string | Наименование банка |
| `bik` | string | БИК: 9 цифр |
| `account` | string | Расчётный счёт: 20 цифр |
| `corr_account` | string | Корр. счёт: 20 цифр |
| `phone` | string | Телефон `+7XXXXXXXXXX` |

**`Party (с country)`** — для CMR/ВЭД: `name`, `address`, `country` (ISO 3166-1 alpha-2).

**`Party (банковский, ВЭД)`** — `name`, `inn`, `kpp`, `account`, `bank_name`, `bic`, `correspondent_account`.

**`items[i]` — каноническая строка позиции** (источник `ITEM_PROPERTIES`, ~30 полей; парсер берёт релевантное подмножество):

| Поле | Тип | Описание |
|---|---|---|
| `line_no` | integer | Порядковый номер строки |
| `code` | string | Внутренний артикул / код товара |
| `barcode` | string | Штрих-код (EAN-13/UPC/GTIN) |
| `name` | string | Наименование товара/услуги |
| `hs_code` | string | Код ТН ВЭД (10 цифр РФ/ЕАЭС, 8 ЕС) |
| `country_of_origin` | string | Страна происхождения, ISO 3166-1 alpha-2 |
| `unit` | string | Ед. изм. (шт, кг, м, л, упак…) |
| `qty` | number | Количество |
| `qty_per_package` | number | Единиц в упаковке |
| `packages` | number | Кол-во упаковок/мест |
| `weight_net` | number | Вес нетто, кг |
| `weight_gross` | number | Вес брутто, кг |
| `price` | number | Цена за единицу без НДС |
| `vat_rate` | number | Ставка НДС строки (0/10/20) |
| `vat_amount` | number | Сумма НДС по строке |
| `total_without_vat` | number | Стоимость без НДС |
| `total_with_vat` | number | Стоимость с НДС |
| `currency` | string | Валюта строки (ISO 4217), если ≠ шапки |
| `notes` | string | Комментарий в строке |
| **Транспортные сигналы строки** (счета перевозчиков; отдаются как есть, без нормализации): |
| `vehicle_plate` | string | Госномер ТС рейса |
| `order_ref` | string | Номер заказа/заявки |
| `route_from` / `route_to` | string | Пункты рейса |
| `trip_date` | string | Дата рейса (ISO) |
| `container_no` | string | Контейнер (ISO 6346) |
| `bl_no` | string | Коносамент (B/L) |
| `cmr_no` | string | Номер CMR |
| `ttn_no` | string | Номер ТТН |
| `declaration_no` | string | Номер ДТ (декларация) |
| `driver_name` | string | ФИО водителя |
| `category` | enum | Категория услуги: `transportation`/`loading`/`unloading`/`storage`/`escort`/`permit_fee`/`customs_clearance`/`demurrage`/`insurance`/`documents`/`route_approval`/`crane_loading`/`pilot_driver`/`other` |

**`vat_summary[]` — разбивка НДС по ставкам:** `{ rate, base, vat }` (на каждую встречающуюся ставку).

**`flags` — булевы признаки:** `is_export`, `is_advance` (аванс/предоплата), `vat_agent` (покупатель — налоговый агент), `usn` (продавец на УСН).

### 2.3. Нормализация (что parsdocs приводит к канону)

| Сущность | Правило нормализации |
|---|---|
| Дата | → ISO `YYYY-MM-DD` |
| ИНН | строка цифр; проверяется checksum (см. §2.4) |
| Госномер ТС | UPPERCASE, без пробелов (для `vehicle.plate`) |
| Валюта | ISO 4217 (RUB/USD/EUR/CNY) |
| Страна | ISO 3166-1 alpha-2 (латиница: `RU`, не `РУ`) |
| Деньги | number, точка-десятичный, без пробелов-разделителей |
| Вес | в килограммах (если в тексте «35 т» → 35000) |

> Транспортные сигналы внутри `items[]` (container_no, bl_no, plate per-line
> и т.п.) **НЕ нормализуются** — отдаются как в документе.

### 2.4. Валидаторы (доменные инварианты)

Каждый валидатор — чистая функция: возвращает `null` (ок) либо строку-описание,
которая попадает в `extracted._issues[]`. Валидаторы **не бросают исключений и
не мутируют данные**. Наличие `_issues[]`, как правило, переводит job в
`needs_review`. Источник: `validators.ts`. Привязка к типу — поле `validators[]`
в `document_types` (формат `имя:путь.к.полю`).

| Валидатор | Правило (точное) |
|---|---|
| `inn_checksum:<path>` | Контрольная сумма ИНН по приказу ФНС № САЭ-3-09/16@. 10 цифр: веса `[2,4,10,3,5,9,4,6,8]`, контроль = `(Σ%11)%10` = 10-я цифра. 12 цифр: две контрольных цифры (веса `[7,2,4,10,3,5,9,4,6,8]` и `[3,7,2,4,10,3,5,9,4,6,8]`). |
| `kpp_format:<path>` | Регэксп `^\d{4}[A-Z\d]{2}\d{3}$` (9 символов NNNNCCNNN). |
| `vehicle_plate:<path>` | После UPPERCASE+strip пробелов: `^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$` (только кириллица-двойники латиницы; спецномера не поддержаны). |
| `date_range:<path>` | Формат `YYYY-MM-DD`, валидный календарь (30.02 ловится round-trip'ом), диапазон `2010-01-01` … `сегодня+30 дней`. |
| `money_sanity:<path>` | Конечное число, `≥ 0`, `≤ 1 000 000 000 000` (1 трлн). |
| `vat_consistency` | `|total×rate/(100+rate) − vat| ≤ max(1.0 ₽, total×0.5%)`. При `rate=0` НДС обязан быть `0`. |
| `positions_sum` | `|Σ items[].total − total| ≤ max(1.0 ₽, total×1%)`. Если у части строк нет суммы — проверка пропускается. |
| `parties_differ:<a>,<b>` | ИНН двух сторон не должны совпадать (иначе вероятна OCR-ошибка). |
| `country_code:<path>` | `^[A-Z]{2}$` (ISO 3166-1 alpha-2, формат, без сверки со списком). |
| `weight_nett_le_gross` / nett≤gross | Масса нетто ≤ масса брутто. |

### 2.5. Confidence и needs_review

| Диапазон confidence | Поведение (рекомендация SLAI ТЗ) |
|---|---|
| `≥ 0.85` | авто-обработка (`done`), можно авто-привязку |
| `0.60 … 0.85` | пометить «требует проверки» |
| `< 0.60` | `status = needs_review`, очередь оператора |

Пороги настраиваемы пер-тип (см. `document_types` resolution config). `_field_confidence`
калибруется: checksum-валидные значения (ИНН, КПП) → ~1.0; нормализованные
(госномер, ISO-даты) получают boost.

### 2.6. Классификация типа документа

1. **Regex-правила** (`shared/classifier-rules.json` + keyword-паттерны в БД у
   каждого типа): набор паттернов с весами (`weight`). Сумма весов по типу →
   кандидат. NB: `\b` не работает с кириллицей в JS-regex → используются
   lookaround по `[а-яёa-z]`.
2. **LLM-fallback** — если regex не дал уверенного победителя.
3. **Подсказка** `document_hint` в `POST /jobs` (включая `raw_ocr` для OCR-only).
4. При конфликте выигрывает паттерн с большим `weight` (напр. `transport_invoice`
   weight 1.1 > `TTN` 1.0 при совпадении ссылки на Пост. № 272).

---

## 3. Пер-типовые спецификации

Уровни зрелости: 🟢 stable · 🟡 beta · 🔴 experimental.

Для каждого типа: назначение · parser_kind · классификация · схема полей ·
обязательные поля (`expected_fields`) · валидаторы · примечания.

---

### 3.1. 🟢 `invoice` — Счёт на оплату

- **parser_kind:** `builtin:invoice_regex` (regex + LLM-fallback при низкой уверенности)
- **Классификация:** `счёт на оплату` / `счёт №` (weight 0.9); широкий `счёт` (weight 0.6)
- **expected_fields:** `number`, `date`, `seller`, `buyer`, `total`, `items`
- **Валидаторы:** `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`, `money_sanity:total`, `money_sanity:vat`

**Схема полей (шапка):**

| Поле | Тип | Описание |
|---|---|---|
| `number` | string | Номер документа |
| `date` | string | Дата (ISO) |
| `seller` | Party | Продавец |
| `buyer` | Party | Покупатель |
| `shipper` | Party | Грузоотправитель (если ≠ продавца) |
| `consignee` | Party | Грузополучатель (если ≠ покупателя) |
| `currency` | string | Валюта, ISO 4217 (default RUB) |
| `exchange_rate` | number | Курс к валюте учёта (если ≠ RUB) |
| `total` | number | Итог к оплате |
| `total_without_vat` | number | Итог без НДС |
| `vat` | number | НДС всего |
| `vat_rate` | number | Основная ставка НДС (20/10/0) |
| `vat_summary[]` | array | Разбивка НДС по ставкам |
| `flags` | object | is_export/is_advance/vat_agent/usn |
| `payment_terms` | string | Условия оплаты |
| `period_from` / `period_to` | string | Период оказания услуг (ISO) |
| `contract_no` / `contract_date` | string | Договор-основание |
| `due_date` | string | Срок оплаты (ISO) |
| `payment_method` | enum | `cash`/`bank_transfer`/`prepayment`/`postpayment`/`card`/`other` |
| `items[]` | array | Позиции (см. §2.2) |

**Расширенный транспортный блок** (счета перевозчиков, негабарит — SLAI EXT-LINE):
плоские `order_ref`, `vehicle{plate,model,trailer,axles}`, `route_from/route_to`,
`permit_no` + nested `transport{ vehicle, driver{name,license,phone}, route{from,to,distance_km,leg_kind∈auto/rail/sea/air/customs}, trip_date, permit{number,issued_by,valid_to}, cargo{description,weight_kg,dimensions{length_m,width_m,height_m},dimensions_raw,oversized}, escort{required,type,area} }`. Источник: `INVOICE_SCHEMA`.

---

### 3.2. 🟢 `tax_invoice` — Счёт-фактура

- **Внутренний slug:** `factInvoice` (исходящий — `tax_invoice`)
- **parser_kind:** `builtin:upd_regex` + LLM-fallback. Для СФ форсируется LLM/vision (миграции `tax_invoice_force_llm`, `prefer_vision`) — сканы СФ сыпались на text-парсере.
- **Классификация:** `счет-фактура` / `счёт-фактура` (weight 1.0)
- **expected_fields:** `number`, `date`, `seller`, `buyer`, `total`, `vat`, `vat_summary`, `items`
- **Валидаторы:** `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`
- **Схема:** `INVOICE_SCHEMA` (как §3.1). Важно: возможны несколько ставок НДS одновременно → заполнять `vat_summary[]`.

---

### 3.3. 🟢 `upd` — УПД (универсальный передаточный документ)

- **Внутренний slug:** `UPD`
- **parser_kind:** `builtin:upd_regex` + LLM-fallback
- **Классификация:** `универсальный передаточный документ` / `УПД` (weight 1.0)
- **expected_fields:** `number`, `date`, `seller`, `buyer`, `total`, `vat`, `items`
- **Валидаторы:** `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`
- **Схема:** `INVOICE_SCHEMA` (как §3.1).

---

### 3.4. 🟢 `ttn` — Товарно-транспортная накладная (форма 1-Т)

- **Внутренний slug:** `TTN`
- **parser_kind:** `llm_extract` (табличный документ, без regex)
- **Классификация:** `транспортная накладная` / `товарно-транспортная накладная` / `ТТН` (weight 1.0)
- **expected_fields:** `number`, `date`, `shipper`, `consignee`, `cargo`, `vehicle`, `items`
- **Валидаторы:** `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `vehicle_plate:vehicle.plate`, `date_range`, `parties_differ:shipper.inn,consignee.inn`, nett≤gross

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата (ISO) |
| `shipper` | Party | Грузоотправитель |
| `consignee` | Party | Грузополучатель |
| `payer` | Party | Плательщик (если ≠ отправителя) |
| `cargo` | object | Сводно: `name`, `quantity`, `weight_gross`, `weight_nett`, `places` |
| `items[]` | array | Таблица позиций (раздел 1 ТТН-1.2) |
| `vehicle` | object | `plate`, `trailer_plate`, `driver`, `driver_license` |
| `loading_point` / `unloading_point` | string | Адреса погрузки/разгрузки |
| `transport_docs[]` | array<string> | Связанные документы (CMR, СФ, путевой лист) |

---

### 3.5. 🟢 `cmr` — Международная транспортная накладная (CMR)

- **Внутренний slug:** `CMR`
- **parser_kind:** `llm_extract` (мультиязычная RU/EN/DE/PL)
- **Классификация:** `CMR` / `международная товарно-транспортная` (weight 1.0)
- **expected_fields:** `number`, `date`, `sender`, `recipient`, `carrier`, `items`
- **Валидаторы:** `country_code:sender.country`, `country_code:recipient.country`, `date_range`

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата (ISO) |
| `sender` | Party+country | Отправитель (ячейка 1) |
| `recipient` | Party+country | Получатель (ячейка 2) |
| `carrier` | object | Перевозчик (ячейка 16): `name`, `address` |
| `cargo` | object | `description`, `packages`, `weight` (брутто, кг), `volume` (м³) |
| `items[]` | array | Позиции (разделы 6-12) |
| `loading_place` | string | Место погрузки (ячейка 4) |
| `delivery_place` | string | Место разгрузки (ячейка 3) |
| `incoterms` | string | EXW/FCA/CIP/DAP/DDP/FOB/CIF/… |
| `transport_docs[]` | array<string> | Связанные (invoice, packing_list) |

---

### 3.6. 🟢 `services_act` — Акт оказанных услуг / выполненных работ

- **Внутренний slug:** `AKT`
- **parser_kind:** `llm_extract`
- **Классификация:** `акт (оказанных|выполненных|сдачи)` / `акт об оказании` (weight 0.95)
- **expected_fields:** `number`, `date`, `party_a`, `party_b`, `total`, `items`
- **Валидаторы:** `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `date_range`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total`, `money_sanity:vat`

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата (ISO) |
| `party_a` | Party | Исполнитель |
| `party_b` | Party | Заказчик |
| `currency` | string | ISO 4217 (default RUB) |
| `total`, `total_without_vat`, `vat`, `vat_rate` | number | Суммы (НДС=0 для УСН) |
| `vat_summary[]` | array | Разбивка НДС |
| `flags` | object | Признаки |
| `period_from` / `period_to` | string | Период услуг (ISO) |
| `items[]` | array | Перечень услуг/работ |
| `parent_contract_number` / `parent_contract_date` | string | Договор-основание |

---

### 3.7. 🔴 `waybill` — Путевой лист

- **parser_kind:** `llm_extract` (нет товарной части)
- **Классификация:** `путевой лист` / `форма 4-С` / `форма 4-П` / `форма ПЛ-1` (weight 1.0)
- **expected_fields:** `number`, `date`, `organization`, `vehicle`, `driver`, `route`, `odometer_start`
- **Валидаторы:** `inn_checksum:organization.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата |
| `form` | string | `4-С`/`4-П`/`ПЛ-1`/иная |
| `organization` | Party | Владелец ТС |
| `vehicle` | object | `plate`, `model`, `type`, `vin`, `registration_certificate` |
| `trailer` | object | `plate`, `model` |
| `driver` | object | `fio`, `license`, `tab_number`, `passport` |
| `route` | object | `departure_point`, `destination_point`, `intermediate_stops[]`, `purpose` |
| `departure_time` / `return_time` | string | Выезд/возврат |
| `odometer_start` / `odometer_end` / `distance_total` | number | Спидометр, пробег (км) |
| `fuel` | object | `fuel_type`, `rate_per_100km`, `issued_volume`, `remaining_start/end`, `consumed_volume` |
| `medical_check` | object | `passed`, `timestamp`, `doctor_signature` |
| `technical_check` | object | `passed`, `timestamp`, `mechanic_signature` |
| `cargo_description`, `cargo_weight` | string/number | Груз общим описанием/весом |
| `notes` | string | Заметки |

---

### 3.8. 🔴 `transport_invoice` — Транспортная накладная (форма 2013)

- **parser_kind:** `llm_extract`. Форма утв. Пост. Прав. РФ № 272 от 15.04.2011 (заменила 1-Т). Без товарного раздела.
- **Классификация:** ссылка на Пост. № 272 / `приложение № 4 к Правилам перевозок грузов` / `условия перевозки … стоимость услуг перевозки` (weight **1.1** — приоритет над TTN)
- **expected_fields:** `number`, `date`, `shipper`, `consignee`, `carrier`, `vehicle`, `driver`, `loading_point`, `unloading_point`, `cargo_summary`
- **Валидаторы:** `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата ТН |
| `shipper` (гр.1) / `consignee` (гр.2) / `carrier` (гр.10) / `payer` / `forwarder` (гр.9) | Party | Стороны |
| `cargo_description` | string | Описание груза (гр.3) — текст, не таблица |
| `items[]` | array | Опц. приложение со списком позиций |
| `cargo_summary` (гр.4) | object | `places`, `weight_gross`, `weight_nett`, `volume_m3`, `dangerous_class` |
| `conditions` (гр.8) | object | `temperature_min_c`, `temperature_max_c`, `humidity`, `special_marks` |
| `declared_value` (гр.5) | number | Заявленная стоимость груза |
| `delivery_terms` (гр.6/7) | object | `pickup_datetime`, `delivery_datetime` |
| `vehicle` (гр.11/13) | object | `plate`, `model`, `trailer_plate`, `trailer_model`, `weight_unladen` |
| `driver` | object | `fio`, `license`, `phone` |
| `loading_point` (гр.6) / `unloading_point` (гр.7) | object | `address`, `city`, `country` (ISO2) |
| `service_cost` (гр.15) | object | `amount`, `currency`, `vat_rate`, `vat_amount`, `amount_with_vat` |
| `transport_docs[]` | array<string> | Прилагаемые документы |
| `distance_km` | number | Расстояние перевозки |

---

### 3.9. 🔴 `transport_request` — Заявка на перевозку

- **parser_kind:** `llm_extract`. Первичка между заказчиком и перевозчиком ДО перевозки. На открытом рынке `vehicle`/`driver` могут быть `null`.
- **Классификация:** `заявка (№|на перевозку|на транспортные услуги|на автоперевозку|на транспортно-экспедиционн)` / `заявка-договор на перевозку` (weight 1.0)
- **expected_fields:** `number`, `date`, `client`, `carrier`, `route`, `cargo`, `rate` (vehicle/driver не обязательны)
- **Валидаторы:** `inn_checksum:client.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`

**Схема полей:**

| Поле | Тип | Описание |
|---|---|---|
| `number`, `date` | string | Номер, дата заявки |
| `client` | Party | Заказчик (грузовладелец) |
| `carrier` | Party | Перевозчик/экспедитор |
| `route` | object | `loading` / `unloading` (object **или** array для multi-stop: `name`,`address`,`city`,`datetime`,`contact`), `intermediate_stops[]` |
| `cargo` | object | `name`, `weight_t`, `volume_m3`, `places`, `temperature`, `dangerous_class` (ADR/ДОПОГ), `customs_info` |
| `vehicle` | object | `plate`, `model`, `vin`, `year`, `capacity_t` (null на открытом рынке) |
| `trailer` | object | `plate`, `model`, `type` (изотерм/тент/рефрижератор/контейнеровоз/цистерна), `volume_m3` |
| `driver` | object | `fio`, `license`, `passport`, `phone` (null на открытом рынке) |
| `rate` | object | `amount`, `currency`, `vat_included`, `vat_rate`, `payment_terms` |
| `additional_terms` | string | Доп. условия/штрафы |
| `contact_responsible` | object | `fio`, `phone`, `email` |
| `parent_contract_number` / `parent_contract_date` | string | Договор-основание |

---

<!-- BEGIN: автогенерируемая секция custom/ВЭД типов (агент извлекает из миграций) -->

### 3.10+ — Остальные типы (ВЭД, складские, договорные)

> _Раздел дополняется: точные определения 21 типа извлекаются из
> `doc-service/migrations/*.sql`. Будут добавлены: `payment_order`,
> `commercial_invoice`, `packing_list`, `proforma_invoice`, `price_list`,
> `cert_of_origin`, `eac_conformity_certificate`, `customs_declaration`,
> `bill_of_lading`, `wire_transfer_application`, `weighing_act`, `UKD`,
> `transfer_note`, `cash_receipt`, `contract_specification`, `contract`,
> `contract_addendum`, `power_of_attorney`, `warehouse_receipt`,
> `warehouse_return`, `material_requisition`._

<!-- END: автогенерируемая секция -->

---

## 4. Контракт выдачи и доставка

- **Вход:** `POST /api/v1/jobs` (multipart **или** `file_url`) + опц. `document_hint`, `metadata`, `redact_pii`.
- **Выход:** webhook `POST` на `webhook_url` при терминальном статусе + polling `GET /api/v1/jobs/{id}`.
- **Payload:** `version`, `job_id`, `status`, `document_type`, `confidence`, `ocr_engine`, `extracted`, `_field_confidence`, `metadata`, `error`, опц. `documents[]`. Подробно — `doc-service/docs/openapi/v1.yaml`.
- **Подпись webhook:** HMAC-SHA256, заголовок `X-Parsdocs-Signature` (+ alias `X-Extractor-Signature`).
- **Версионирование:** добавление полей — обратно совместимо (v1); rename/delete — v2 с параллельной работой ≥ 6 мес.

## 5. Acceptance-критерии (целевые, из SLAI ТЗ v1.0)

| Тип | Критичные поля (≥ 95 %) | Прочие (≥ 80 %) |
|---|---|---|
| invoice | `seller.inn`, `buyer.inn`, `number`, `total` (с НДС) | items[], банк-реквизиты |
| transport_request | `client.inn`, `carrier.inn`, адреса маршрута (≥90%), `vehicle.plate` норм. (≥95%), даты ISO (≥85%) | — |
| ttn | shipper/consignee/carrier ИНН, `vehicle.plate`, `total_weight_kg` ±1кг (≥95%), ФИО водителя/маршрут (≥90%) | — |

**SLA (целевые, поэтапно):** MVP ≤ 90 сек/doc, прод ≤ 30 сек; throughput 5→60 doc/min; размер до 50 МБ, до 30 стр.; доступность 95 %→99,5 %.

## 6. Открытые вопросы / зоны доработки для разработчика

- Пер-типовые пороги `needs_review` (resolution config) — выверить значения по типам.
- 🔴 experimental-типы не имеют типизации (Zod) и не замерены на golden-set — нужен замер качества перед обещанием точности.
- Latency vision-маршрута (P50 ~186 c) — оптимизация (vLLM/меньше DPI) до выхода на SLA прод.
- Калибровка `_field_confidence` по типам вне invoice-семейства.
