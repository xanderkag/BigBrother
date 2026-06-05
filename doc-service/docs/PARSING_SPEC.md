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

### Раздел B — Платёжные и учётные документы РФ

#### 3.10. 🟡 `payment_order` — Платёжное поручение

- **parser_kind:** `llm_extract`. Форма 0401060, жёсткая структура.
- **Классификация:** `платёжное/платежное поручение` (w 5.0), `П.П. №` (3.0), `Поступ. в банк плат.` / `Списано со сч. плат.` (3.0). _Bare `БИК\d{9}` убран (false-positive на 1С-шаблонах)._
- **expected_fields:** `number`, `date`, `amount`, `payer.inn`, `payer.account`, `payee.inn`, `payee.account`, `purpose`
- **Валидаторы:** `inn_checksum:payer.inn`, `inn_checksum:payee.inn`, `parties_differ:payer.inn,payee.inn`, `kpp_format:payer.kpp`, `kpp_format:payee.kpp`, `money_sanity:amount`, `date_range`
- **Схема:** `number`, `date`, `date_charged` (дата списания), `amount`, `amount_text` (прописью), `payment_kind` (электронно/телеграфно/почтой), `priority` (1-5); `payer{name,inn,kpp,account(20),bic(9),bank_name,correspondent_account}`, `payee{…те же поля}`; `purpose` (назначение целиком, вкл. текст про НДС).
- **LLM-промпт (ключевое):** ИНН плательщика и получателя — РАЗНЫЕ, не путать; БИК 9 цифр; р/с 20 цифр; сумму прописью — одной строкой.

#### 3.11. 🟡 `cash_receipt` — Кассовый чек (ККТ, 54-ФЗ)

- **parser_kind:** `llm_extract`
- **Классификация (ужесточена — только фискальные признаки):** `кассовый чек` (6.0), `ФН \d{16}` (5.0), `ФД \d` (5.0), `ФПД? \d` (4.0), `54-ФЗ` (3.0). _Убраны общие `КАССА`, `ИТОГ…\d` (ложные на счетах)._
- **expected_fields:** `date`, `merchant.inn`, `total`, `items`
- **Валидаторы:** `inn_checksum:merchant.inn`, `money_sanity:total`, `date_range`
- **Схема:** `fn_number` (ФН), `fd_number` (ФД), `fpd` (фискальный признак), `shift_number`, `receipt_number`, `date`, `time`, `merchant{name,inn,address}`, `operation_kind` (приход/возврат прихода/расход/…), `payment_method`, `total`, `vat_amount`, `vat_rate`, `items[]` (каноническая строка §2.2).
- **LLM-промпт:** обязательно искать ФН (16 цифр), ФД, ФП — идентификаторы в ОФД; признак расчёта вверху чека.

#### 3.12. 🔴 `UKD` — Корректировочный УПД (УКД)

- **parser_kind:** `llm_extract`. Исправление выставленного УПД (цена/кол-во/возврат). Статус 1 — с НДС, 2 — без.
- **Классификация:** `УКД` (6.0), `корректировочн… (счет|документ)` (5.0), `универсальн… корректировочн…` (5.0), `к счёт-фактуре № …` (4.0), `(увеличение|уменьшение) стоимости` (3.0)
- **expected_fields:** `number`, `date`, `status`, `base_doc_number`, `base_doc_date`, `seller_name`, `seller_inn`, `buyer_name`, `buyer_inn`, `currency`, `total_before`, `total_after`, `vat_before`, `vat_after`
- **Валидаторы:** не заданы (рекомендуется добавить `inn_checksum` для seller/buyer)
- **Схема (плоская):** перечисленные expected_fields + `correction_kind` (увеличение/уменьшение/null). `status` — integer (1/2).

---

### Раздел C — ВЭД (международная торговля и логистика)

> Общее для ВЭД: страны — ISO 3166-1 alpha-2 (латиницей: `CN`, не «China»);
> валюта — ISO 4217; коды ТН ВЭД — 10 цифр (РФ/ЕАЭС) / 8 (ЕС). Большинство
> используют каноническую строку `items[]` (§2.2).

#### 3.13. 🟡 `commercial_invoice` — Commercial Invoice (коммерческий инвойс)

- **parser_kind:** `llm_extract`. Мультиязычный.
- **Классификация:** `commercial invoice` / `коммерческий инвойс` (5.0), `инвойс №…` (4.0), `INVOICE No…` (3.0), `Incoterms \d{4}` (2.0), `exporter…consignee` (3.0), `country of origin` (0.8 — намеренно ниже, чтобы выигрывал price_list)
- **expected_fields:** `number`, `date`, `shipper`, `consignee`, `total_value`, `items`
- **Валидаторы:** `country_code:exporter.country`, `country_code:consignee.country`, `money_sanity:total_amount`, `date_range`
- **Схема:** `number`, `date`, `currency`, `exchange_rate`, `incoterms`, `place_of_delivery`, `port_of_loading`, `port_of_discharge`; `shipper/consignee/notify_party {name,address,country}`; `total_value`, `total_weight_net`, `total_weight_gross`, `total_packages`; `items[]` (каноническая §2.2, ключевые: `name`, `hs_code`, `country_of_origin`, `qty`, `price`, `weight_net/gross`, `packages`).

#### 3.14. 🟡 `proforma_invoice` — Инвойс-проформа

- **parser_kind:** `llm_extract`. Предварительный инвойс до отгрузки (для предоплаты/согласования); не фискальный.
- **Классификация:** `proforma invoice` (5.0), `инвойс-проформа` (4.0), `предварительный инвойс` (4.0)
- **expected_fields:** `number`, `date`, `seller.{name,address,country}`, `buyer.{name,address,country}`, `currency`, `total_amount`, `incoterms`, `payment_terms`, `items`
- **Валидаторы:** не заданы
- **Схема (плоская):** `number`, `date`, `seller_name/address/country`, `buyer_name/address/country`, `currency`, `total_amount`, `incoterms` (FOB/CIF/EXW + город), `payment_terms`; `items[]`: `description`, `qty`, `unit_price`, `line_total`.

#### 3.15. 🟡 `packing_list` — Packing List (упаковочный лист)

- **parser_kind:** `llm_extract`. Обычно в комплекте с commercial_invoice.
- **Классификация:** `packing list` / `упаковочный лист` (5.0), `packing specification` (4.0)
- **expected_fields:** `number`, `date`, `shipper`, `consignee`, `total_packages`, `items`
- **Валидаторы:** `weight_nett_le_gross`, `date_range`
- **Схема:** `number`, `date`, `invoice_reference`; `shipper/consignee {name,address,country}`; `total_packages`, `total_weight_net`, `total_weight_gross`, `total_volume`; `items[]` (§2.2 + `package_type`, `dimensions` L×W×H, `volume` м³).

#### 3.16. 🟡 `bill_of_lading` — Коносамент (B/L)

- **parser_kind:** `llm_extract`. Морская/мультимодальная накладная.
- **Классификация:** `bill of lading` / `коносамент` / `multimodal transport bill` (5.0), `B/L No…` (4.0), `Master B/L` / `House B/L` (4.0)
- **expected_fields:** `bl_number`, `date`, `shipper`, `consignee`, `port_of_loading`, `port_of_discharge`, `items`
- **Валидаторы:** `country_code:shipper.country`, `country_code:consignee.country`, `date_range`
- **Схема:** `bl_number`, `date`; `shipper/consignee/notify_party {name,address,country}`; `vessel_name`, `voyage_number`, `carrier`, `port_of_loading`, `port_of_discharge`, `place_of_receipt`, `place_of_delivery`, `freight_payable` (prepaid/collect), `freight_amount`, `currency`, `incoterms`; `items[]` (§2.2 + `marks_and_numbers`, `container_number`).

#### 3.17. 🟡 `customs_declaration` — Таможенная декларация (ДТ / ГТД)

- **parser_kind:** `llm_extract`. Форма 0014001, табличная, много граф.
- **Классификация:** `декларация на товары` / `ГТД` (5.0), `ДТ № \d{8}` (4.0), `грузовая таможенная декларация` (4.0), `ТД-ИК/ЭК\d` (4.0)
- **expected_fields:** `declaration_number`, `date`, `declarant.inn`, `declaration_type`, `items`
- **Валидаторы:** `inn_checksum:declarant.inn`, `inn_checksum:sender.inn`, `inn_checksum:recipient.inn`, `money_sanity:total_value`, `money_sanity:customs_value`, `date_range`
- **Схема (с привязкой к графам ДТ):** `declaration_number` (гр.7), `declaration_type` (гр.1: ЭК/ИМ), `date`; `declarant/sender/recipient {name,inn,country,address}`; `trading_country` (гр.11), `currency` (гр.22), `exchange_rate` (гр.23), `transport_mode` (гр.25), `procedure_code` (гр.37), `total_amount`, `total_weight_net/gross`; `items[]` (§2.2 + `line_no` гр.32, `name` гр.31, `hs_code` гр.33, `country_of_origin` гр.34, `weight_net` гр.38, `weight_gross` гр.35, `invoice_value` гр.42, `customs_value` гр.45, `statistical_value` гр.46).
- **LLM-промпт:** регномер — пост ФТС/дата/порядковый; ТН ВЭД 10 цифр; виды платежей 1010 (сбор)/2010 (пошлина)/5010 (НДС).

#### 3.18. 🟡 `cert_of_origin` — Сертификат происхождения

- **parser_kind:** `llm_extract`. Формы СТ-1 (СНГ), Form A (GSP), Form E (Китай). Подтверждает страну происхождения для тарифных льгот. _Не путать с `eac_conformity_certificate`._
- **Классификация:** `сертификат происхождения` / `certificate of origin` (5.0), `form (CT-1|СТ-1|A|E)` (3.0), `country of origin` (1.5)
- **expected_fields:** `number`, `issue_date`, `form_type`, `exporter.{name,address,country}`, `consignee.{name,address,country}`, `product.{description,hs_code,origin_country}`, `invoice_ref`
- **Валидаторы:** не заданы
- **Схема (плоская):** `number`, `issue_date`, `form_type` (CT-1/Form A/Form E), `exporter_name/country`, `consignee_name/country`, `product_description`, `hs_code` (10 цифр), `origin_country` (ISO2), `invoice_ref`.

#### 3.19. 🟡 `eac_conformity_certificate` — Сертификат соответствия ЕАЭС (EAC)

- **parser_kind:** `llm_extract`. ТР ТС / ТР ЕАЭС. Номер вида «N RU Д-CN.РА01.В.54075/24». Покрывает и **декларацию** о соответствии (`doc_kind`).
- **Классификация:** `сертификат соответствия` (3.0), номер `N RU Д-CN.…` (8.0 — самый сильный сигнал), `технический регламент` (4.0), `ТР ТС` / `ТР ЕАЭС` (5.0), `EAC conformity` (4.0)
- **expected_fields:** `number`, `issue_date`, `expiry_date`, `manufacturer.{name,address,country}`, `applicant.{name,inn,address}`, `product.{name,tn_ved_code}`, `tech_regulation`, `certification_body.{name,id}`
- **Валидаторы:** не заданы
- **Схема (плоская):** `number`, `doc_kind` (certificate/declaration), `issue_date`, `expiry_date`, `applicant_name/inn/address`, `manufacturer_name/country`, `product_description`, `tn_ved_code` (10 цифр), `tech_regulation` (ссылки «ТР ТС 010/2011»), `certification_body`.
- **LLM-промпт:** заголовок «ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ» → `declaration`, «СЕРТИФИКАТ…» → `certificate`; ИНН заявителя 10 цифр.

#### 3.20. 🟡 `wire_transfer_application` — Заявление на перевод (ВЭД)

- **parser_kind:** `llm_extract`. Валютный перевод по контракту ВЭД (формы ВТБ № 284, Сбер, Альфа). SWIFT/IBAN. _Отличие от `payment_order`: трансграничный._
- **Классификация:** `заявление на перевод` (5.0), `application for (remittance|transfer)` (3.0), `SWIFT … [A-Z]{4}…` (2.0), `beneficiary customer` (3.0), `sender to receiver information` (2.0), `Currency Code` (1.5), `банк-посредник` (1.5)
- **expected_fields:** `number`, `date`, `currency`, `amount`, `amount_words`, `sender.{name,inn,account}`, `beneficiary.{name,address,country,iban}`, `beneficiary_bank.{swift,name,address}`, `purpose`, `contract_ref`, `invoice_ref`
- **Валидаторы:** не заданы
- **Схема (плоская):** `number`, `date`, `currency`, `amount`, `amount_words`, `sender_name/inn/account`, `beneficiary_name/address/country/iban`, `beneficiary_bank_name/swift` (8/11 симв.), `purpose` (англ.), `contract_ref`, `invoice_ref`.

#### 3.21. 🟡 `weighing_act` — Акт взвешивания контейнера

- **parser_kind:** `llm_extract`. Взвешивание груженого/порожнего контейнера на весах порта (ВМТП/ВСК/FESCO). Доказательство веса для таможни/страховщика.
- **Классификация:** `акт взвешивания` (5.0), `вес груженого/порожнего контейнера` (3.0), `свидетельство о поверке` (2.0), `(брутто|нетто|тара)…кг` (1.5)
- **expected_fields:** `number`, `date`, `container.number`, `weight.{gross_kg,tare_kg,net_kg,declared_gross_kg,declared_net_kg}`, `scales.id`, `performer.fio`, `port.name`
- **Валидаторы:** не заданы (рекомендуется: net ≤ gross)
- **Схема (плоская):** `number`, `date`, `container_number` (4 буквы + 7 цифр), `scales_id`, `weight_gross_kg`, `weight_tare_kg`, `weight_net_kg`, `declared_gross_kg`, `declared_net_kg`, `performer_fio`, `port_name`. Все веса — числа, кг.

#### 3.22. 🟡 `price_list` — Прайс-лист

- **parser_kind:** `llm_extract`. Reference data (не платёжный).
- **Классификация:** `прайс-лист` / `price list` (5.0), `прейскурант` (3.0), `(артикул|article|sku)…(цена|price)` (1.5)
- **expected_fields:** `number`, `date`, `supplier.{name,country}`, `currency`, `valid_from`, `valid_to`, `items`
- **Валидаторы:** не заданы
- **Схема:** `number`, `date`, `supplier_name/country`, `currency`, `valid_from`, `valid_to`; `items[]`: `sku`, `name`, `price`, `unit`, `min_qty`.
- **LLM-промпт:** при > 50 позиций — извлечь первые 50 + `metadata.total_items`.

---

### Раздел D — Договорные документы

> Общее: длинные документы (5-30 стр.); извлекаются **реквизиты, не положения**.
> Глубокая вложенность вредит качеству (Qwen 32B возвращал `{}`) → схемы у
> `contract`/`*_specification` намеренно уплощены.

#### 3.23. 🟡 `contract` — Договор

- **parser_kind:** `llm_extract`. Любой вид (поставки/услуг/подряда/аренды/агентский/лицензионный) — различается через `subject_kind`.
- **Классификация:** `ДОГОВОР №` / `КОНТРАКТ №` (5.0), `Предмет договора/контракта` (5.0), `Договор поставки/оказания услуг/подряда/аренды/купли-продажи` (5.0), `Права и обязанности Сторон` (4.0), `Срок действия договора` (4.0), `Подписи Сторон` (4.0), `настоящий договор о нижеследующем` (4.0)
- **expected_fields:** `number`, `date`, `party_a.inn`, `party_b.inn`, `subject`, `total_amount`
- **Валидаторы:** `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `kpp_format:party_a.kpp`, `kpp_format:party_b.kpp`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `date_range`
- **Схема (уплощённая):** `number`, `date`, `title`, `subject_kind` (supply/services/works/rent/purchase/agency/license/other), `subject` (1-2 предложения), `party_a_name/inn/role`, `party_b_name/inn/role`, `currency`, `total_amount`, `payment_terms`, `delivery_terms`, `effective_date`, `expiration_date`.
- **LLM-промпт:** НЕ пересказывать ответственность/форс-мажор/споры; роли — Поставщик/Покупатель/Заказчик/Исполнитель/Арендодатель/Арендатор.

#### 3.24. 🟡 `contract_addendum` — Дополнительное соглашение

- **parser_kind:** `llm_extract`. Стороны те же, что в родительском договоре. `changes[]` — список модификаций.
- **Классификация:** `Дополнительное соглашение` / `Доп. соглашение` (5.0), `Соглашение об изменении` / `о расторжении` (4.0), `О внесении изменений в Договор/Контракт` (4.0)
- **expected_fields:** `number`, `date`, `parent_contract_number`, `parent_contract_date`, `party_a.inn`, `party_b.inn`
- **Валидаторы:** `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `date_range`
- **Схема (вложенная):** `number`, `date`, `title`, `parent_contract_number`, `parent_contract_date`, `addendum_kind` (amendment/termination/extension/price_change/renaming/other); `party_a{role,name,inn,kpp,representative_name}`, `party_b{…}`; `changes[]{clause («п. 3.1»), action (modify/replace/add/remove), old_text, new_text}`; `new_total_amount`, `new_expiration_date`, `effective_date`.

#### 3.25. 🟡 `contract_specification` — Спецификация / Приложение к договору

- **parser_kind:** `llm_extract`. Самое частое приложение — таблица позиций с ценами + ссылка на родительский договор.
- **Классификация:** `Спецификация № … к Договору/Контракту` (5.0), `Приложение № … к Договору/Контракту` (5.0), `Спецификация № …` (5.0 — standalone), `Приложение к Договору` (4.0), `Спецификация товара` / `Спецификация к Договору` (4.0)
- **expected_fields:** `number`, `date`, `parent_contract_number`, `parent_contract_date`, `items`, `total_amount`
- **Валидаторы:** `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `positions_sum`, `date_range`
- **Схема:** `number`, `date`, `parent_contract_number`, `parent_contract_date`; `seller/buyer {name,inn,kpp,address}`; `currency`, `total_amount`, `vat`, `vat_rate`, `delivery_terms`, `payment_terms`; `items[]` (§2.2 + `delivery_term` по позиции).

---

### Раздел E — Складские / внутренние учётные документы

> Все 🔴 experimental, parser_kind `llm_extract`, validators: только `date_range`.
> Глобальные (видны всем тенантам). Ключевые слова — простые литералы (substring,
> без весов). LLM-промпт не задан — используется generic-extract по llm_schema.

#### 3.26. 🔴 `transfer_note` — Перемещение товаров (ТОРГ-13)

- **tier:** 🟡 beta (исключение в этом разделе)
- **Классификация:** `перемещение товаров` / `накладная на перемещение` (6.0), `ТОРГ-13` (5.0), `отправитель…получатель…склад` (3.0), `(склад|места хранения)…(откуда|куда|источник|назначение)` (3.0)
- **expected_fields:** `number`, `date`, `organization_name`, `organization_inn`, `source_warehouse`, `target_warehouse`, `responsible_fio`, `items`
- **Схема:** + `items[]`: `name`, `code`, `qty`, `unit`, `price`, `total`. _Есть LLM-промпт (внутреннее перемещение между складами)._

#### 3.27. 🔴 `power_of_attorney` — Доверенность (М-2 / М-2а)

- **Классификация (литералы):** `доверенность`, `м-2`, `доверяю`, `уполномочивает`, `представлять интересы`
- **expected_fields:** `number`, `date`, `principal`, `representative`, `valid_until`, `authority`
- **Схема:** `number`, `date`, `valid_until`; `principal{name,inn,kpp,address}` (доверитель); `representative{fio,position,passport}`; `supplier{name}`; `basis` (счёт/договор), `authority`; `positions[]{name,qty,unit}`.

#### 3.28. 🔴 `warehouse_receipt` — Приём-передача ТМЦ на хранение (МХ-1)

- **Классификация (литералы):** `мх-1`, `акт о приёме-передаче`, `на хранение`, `поклажедатель`, `хранитель`
- **expected_fields:** `number`, `date`, `depositor`, `custodian`, `positions`, `total`
- **Схема:** `number`, `date`; `depositor{name,inn,kpp}` (поклажедатель); `custodian{name,inn,kpp}` (хранитель); `storage_place`, `storage_term`; `positions[]{name,code,qty,unit,price,total}`; `total`.

#### 3.29. 🔴 `warehouse_return` — Возврат ТМЦ с хранения (МХ-3)

- **Классификация (литералы):** `мх-3`, `акт о возврате`, `с хранения`, `возврат тмц`
- **expected_fields:** `number`, `date`, `depositor`, `custodian`, `positions`
- **Схема:** `number`, `date`; `depositor{name,inn,kpp}`, `custodian{name,inn,kpp}`; `base_doc_number` (исходный МХ-1), `base_doc_date`; `positions[]{name,code,qty,unit,price,total}`; `total`.

#### 3.30. 🔴 `material_requisition` — Требование-накладная (М-11)

- **Классификация (литералы):** `м-11`, `требование-накладная`, `требование`, `отпуск материалов`
- **expected_fields:** `number`, `date`, `sender`, `receiver`, `positions`, `warehouse`
- **Схема:** `number`, `date`, `organization_name`, `warehouse` (склад-отправитель); `sender{name,responsible_fio}`, `receiver{name,responsible_fio}`; `basis`; `positions[]{name,code,qty,unit,price,total}`.

---

### 3.* Примечания по версионированию определений (важно разработчику)

- Определения типов лежат в БД (`document_types`) и менялись миграциями. Источник
  истины — **последняя** миграция, тронувшая поле. Ключевые перекрытия:
  - `payment_order`, `contract`, `contract_addendum` **не** переведены на
    канонический `items[]` (миграция `…15`) — у них собственные `positions`/
    плоские схемы.
  - `commercial_invoice`, `bill_of_lading`: llm_schema из `…15` (канон `items[]`),
    но llm_prompt переписан в `…26`.
  - `contract`: и схема, и промпт переписаны в `…26` (уплощены — глубокая
    вложенность ломала Qwen 32B).
  - Кириллические `\b` в ключевых словах глобально заменены на `(?:^|\W)` /
    `(?:\W|$)` миграцией `…26_…boundary_global` (JS-regex `\b` не работает с
    кириллицей). `UKD` создан позже (`…28`) и сохраняет литеральный `\b`.

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
