# Типы документов parsdocs

> Источник правды по поддерживаемым типам. Добавил тип в Registry — допиши сюда той же датой.
> Обновлено: 2026-05-20.

## Обзор

- Всего в Registry: **26** (6 builtin typed + 20 custom).
- Покрытие SLAI ТЗ: Фаза 1 — 10/10 ✅, ВЭД Фаза 2 — 8/8 ✅ (golden-set валидация ждёт).
- У каждого типа: **tier** (зрелость) + **scope** (global или org-owned).
- Tier-распределение: **stable** 6, **beta** 16, **experimental** 4 (`transport_request`, `transport_invoice`, `waybill`, `UKD`).
- Scope: на момент написания все 26 типов **global** (`organization_id IS NULL`). org-owned типы заводятся тенантами после деплоя CP7.

## Как читать

- **Internal slug** — то, что лежит в БД (`document_types.slug`), пишется в логи, classifier, `document_hint`. Историческое имя (UPPERCASE / camelCase у части builtin'ов).
- **Outbound slug** — то, что уходит в webhook/API. Трансляция в `normalizeSlugForApi()` (`src/types/slug-normalize.ts`). Если в таблице aliasing'а нет — internal == outbound.
- **Парсер** (`parser_kind`):
  - `builtin:invoice_regex` — Zod-схема + regex, LLM-fallback при regex confidence < `regex_fallback_threshold`.
  - `builtin:upd_regex` — то же, общий regex для УПД/счёт-фактуры.
  - `llm_extract` — LLM `/v1/extract` по `llm_schema` + `llm_prompt` (GenericLlmParser, без хардкод-кода).
  - `llm_extract_multipass` — multipass-вариант для тяжёлых многостраничных документов (см. migration `parser_kind_multipass`).
- **Tier**: `stable` / `beta` / `experimental`. Runtime НЕ принимает решений на основе tier — это бейдж для UI/SLAI.
- **Scope**: `global` (виден всем тенантам) / `org-owned` (виден только своему тенанту + super_admin). Builtin всегда global (CHECK `chk_builtin_is_global`).
- **Извлекаемые поля** ниже приведены по `expected_fields` + `llm_schema` из миграции. `expected_fields` участвует в `ParseResult.missing[]`.
- **Валидаторы** (`validators`): `inn_checksum:<path>` (чек-сумма ФНС), `kpp_format:<path>`, `vat_consistency`, `vehicle_plate:<path>`, `country_code:<path>` (ISO 3166 alpha-2), `parties_differ:<a>,<b>`, `money_sanity:<path>`, `date_range[:<path>]`, `positions_sum`, `weight_nett_le_gross`.

## Категории

### 💰 Финансовые / учётные

| Internal | Outbound | Название | Парсер | Tier | Заметка |
|---|---|---|---|---|---|
| `invoice` | `invoice` | Счёт на оплату | builtin:invoice_regex | stable | Regex + LLM-fallback (порог 0.7) |
| `factInvoice` | `tax_invoice` | Счёт-фактура | builtin:upd_regex | stable | Структура как УПД |
| `UPD` | `upd` | УПД | builtin:upd_regex | stable | Универсальный передаточный документ |
| `AKT` | `services_act` | Акт оказанных услуг | llm_extract | stable | Два контрагента + услуги |
| `payment_order` | `payment_order` | Платёжное поручение | llm_extract | beta | Форма 0401060, БИК/счёт |
| `cash_receipt` | `cash_receipt` | Кассовый чек | llm_extract | beta | ККТ 54-ФЗ, ФН/ФД/ФП |
| `UKD` | `UKD` | Корректировочный УПД (УКД) | llm_extract | experimental | Статус 1 (с НДС) / 2 (без НДС) |

### 🚚 Транспортные

| Internal | Outbound | Название | Парсер | Tier | Заметка |
|---|---|---|---|---|---|
| `TTN` | `ttn` | Транспортная накладная (1-Т) | llm_extract | stable | Товарно-транспортная |
| `CMR` | `cmr` | CMR (международная) | llm_extract | stable | Мультиязычная RU/EN/DE/PL |
| `transport_invoice` | `transport_invoice` | Транспортная накладная (форма 2013) | llm_extract | experimental | Пост. № 272, без товарного раздела |
| `transport_request` | `transport_request` | Заявка на перевозку | llm_extract | experimental | До рейса; ТС/водитель могут быть NULL |
| `waybill` | `waybill` | Путевой лист | llm_extract | experimental | Формы 4-С / 4-П / ПЛ-1 |

### 🌍 ВЭД / таможня

| Internal | Outbound | Название | Парсер | Tier | Заметка |
|---|---|---|---|---|---|
| `commercial_invoice` | `commercial_invoice` | Commercial Invoice | llm_extract | beta | HS-коды, Incoterms, валюта |
| `proforma_invoice` | `proforma_invoice` | Инвойс-проформа | llm_extract | beta | Предварительный, до отгрузки |
| `packing_list` | `packing_list` | Packing List | llm_extract | beta | Места, вес нетто/брутто, объём |
| `bill_of_lading` | `bill_of_lading` | Коносамент (B/L) | llm_extract | beta | Морская/мульти-модальная |
| `customs_declaration` | `customs_declaration` | Таможенная декларация (ГТД) | llm_extract | beta | Форма 0014001, графа 31 |
| `cert_of_origin` | `cert_of_origin` | Сертификат происхождения | llm_extract | beta | СТ-1 / Form A / Form E |
| `eac_conformity_certificate` | `eac_conformity_certificate` | Сертификат соответствия ЕАЭС | llm_extract | beta | ТР ТС / ТР ЕАЭС, EAC |
| `wire_transfer_application` | `wire_transfer_application` | Заявление на перевод (ВЭД) | llm_extract | beta | SWIFT/IBAN, валюта |
| `price_list` | `price_list` | Прайс-лист | llm_extract | beta | Reference data, не платёжный |
| `weighing_act` | `weighing_act` | Акт взвешивания | llm_extract | beta | Брутто/тара/нетто контейнера |

### 🤝 Договорные

| Internal | Outbound | Название | Парсер | Tier | Заметка |
|---|---|---|---|---|---|
| `contract` | `contract` | Договор | llm_extract | beta | Подвиды через `subject_kind` |
| `contract_specification` | `contract_specification` | Спецификация / Приложение | llm_extract | beta | Таблица позиций + ссылка на родителя |
| `contract_addendum` | `contract_addendum` | Дополнительное соглашение | llm_extract | beta | `changes[]`, ссылка на родителя |

### 📦 Складские

| Internal | Outbound | Название | Парсер | Tier | Заметка |
|---|---|---|---|---|---|
| `transfer_note` | `transfer_note` | Перемещение товаров (ТОРГ-13) | llm_extract | beta | Внутреннее, между складами |

---

## Подробно по типам

### 💰 Финансовые / учётные

#### `invoice` — Счёт на оплату
- Категория: финансовые. Парсер: `builtin:invoice_regex` (regex + LLM-fallback при confidence < 0.7). Tier: stable. Scope: global.
- Поля: `number`, `date`, `seller{name,inn,address}`, `buyer{name,inn,address}`, `total`, `vat`, `vat_rate`, `positions[]{name,qty,price,total,vat}`.
- Валидаторы: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`, `money_sanity:total`, `money_sanity:vat`.
- Keywords: `сч[её]т на оплату`, `сч[её]т №`.
- Сложности: SLAI требует банковские реквизиты (`seller.bank/bik/account/corr_account`) — gap F19. Acceptance: `seller.inn`/`buyer.inn`/номер/итого ≥ 95%.

#### `factInvoice` → `tax_invoice` — Счёт-фактура
- Категория: финансовые. Парсер: `builtin:upd_regex` (regex + LLM-fallback < 0.7). Tier: stable. Scope: global.
- Поля: `number`, `date`, `seller`, `buyer`, `total`, `vat` (структура совпадает с УПД).
- Валидаторы: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`.
- Keywords: `счет-фактура`, `счёт-фактура`.
- Сложности: outbound slug = `tax_invoice` (aliasing). Не путать с `invoice` (счёт на оплату).

#### `UPD` → `upd` — УПД
- Категория: финансовые. Парсер: `builtin:upd_regex` (regex + LLM-fallback < 0.7). Tier: stable. Scope: global.
- Поля: `number`, `date`, `seller`, `buyer`, `total`.
- Валидаторы: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`.
- Keywords: `универсальный передаточный документ`, `УПД`.
- Сложности: самый тяжёлый из Фазы 1 (SLAI ⭐⭐⭐⭐⭐).

#### `AKT` → `services_act` — Акт оказанных услуг / выполненных работ
- Категория: финансовые. Парсер: `llm_extract`. Tier: stable. Scope: global.
- Поля: `number`, `date`, `party_a{name,inn,address}`, `party_b{...}`, `total`, `vat`, `services[]{name,qty,price}`.
- Валидаторы: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `date_range`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total`, `money_sanity:vat`.
- Keywords: `акт (оказанных|выполненных|сдачи)`, `акт об оказании`.
- Сложности: outbound slug = `services_act`.

#### `payment_order` — Платёжное поручение
- Категория: финансовые. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `date_charged`, `amount`, `amount_text`, `payment_kind`, `priority`, `payer{name,inn,kpp,account,bic,bank_name,correspondent_account}`, `payee{...}`, `purpose`.
- Валидаторы: `inn_checksum:payer.inn`, `inn_checksum:payee.inn`, `parties_differ:payer.inn,payee.inn`, `kpp_format:payer.kpp`, `kpp_format:payee.kpp`, `money_sanity:amount`, `date_range`.
- Keywords: `платёжное поручение`, `П.П. №`, `БИК \d{9}`, `Поступ. в банк плат.`, `Списано со сч. плат.`.
- Сложности: ИНН плательщика ≠ ИНН получателя — модель не должна путать. БИК 9 цифр, счёт 20 цифр.

#### `cash_receipt` — Кассовый чек
- Категория: финансовые. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `merchant{name,inn,address,store_id}`, `check_number`, `shift_number`, `date_time`, `cashier_name`, `fn_number`, `fd_number`, `fp`, `kkt_serial`, `ofd_name`, `positions[]{name,qty,unit,price,total,vat_rate,vat_amount}`, `total`, `vat_amount`, `payment_method`, `payment_cash`, `payment_card`, `check_type`.
- Валидаторы: `inn_checksum:merchant.inn`, `money_sanity:total`, `date_range`.
- Keywords: `кассовый чек`, `ФН \d{16}`, `ФД \d`, `ФПД? \d`, `КАССА`, `ИТОГ`, `54-ФЗ`.
- Сложности: ФН (16 цифр), ФД, ФП (10 цифр) — идентификаторы для проверки подлинности в ОФД.

#### `UKD` — Корректировочный УПД (УКД)
- Категория: финансовые. Парсер: `llm_extract`. Tier: experimental. Scope: global.
- Поля: `number`, `date`, `status` (1 с НДС / 2 без НДС), `base_doc_number`, `base_doc_date`, `seller_name`, `seller_inn`, `buyer_name`, `buyer_inn`, `currency`, `total_before`, `total_after`, `vat_before`, `vat_after`, `correction_kind`.
- Валидаторы: нет (заведён без `validators`).
- Keywords (с весами 6/5/5/4/3): `УКД`, `корректировочн… (счет|документ)`, `универсальн… корректировочн…`, `к (счет|счёт)-фактур[еу] №…`, `(увеличение|уменьшение) стоимости`.
- Сложности: классифицируется через keyword-weights (миграция 0028); из-за плоской схемы (без nested party) поля стороны — плоские `seller_*`/`buyer_*`.

### 🚚 Транспортные

#### `TTN` → `ttn` — Транспортная накладная (форма 1-Т)
- Категория: транспортные. Парсер: `llm_extract`. Tier: stable. Scope: global.
- Поля: `number`, `date`, `shipper{name,inn,address}`, `consignee{...}`, `cargo{name,quantity,weight_gross,weight_nett,places}`, `vehicle{plate,driver}`, `loading_point`, `unloading_point`.
- Валидаторы: `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `vehicle_plate:vehicle.plate`, `date_range`, `parties_differ:shipper.inn,consignee.inn`.
- Keywords: `транспортная накладная`, `товарно-транспортная накладная`, `ТТН`.
- Сложности: табличный, SLAI ⭐⭐⭐⭐. Acceptance: ИНН сторон + plate ≥ 95%, вес ±1 кг ≥ 95%.

#### `CMR` → `cmr` — CMR (международная накладная)
- Категория: транспортные. Парсер: `llm_extract`. Tier: stable. Scope: global.
- Поля: `number`, `date`, `sender{name,inn,address,country}`, `recipient{...,country}`, `carrier{name,inn,address}`, `cargo{description,packages,weight}`, `loading_place`, `delivery_place`.
- Валидаторы: `country_code:sender.country`, `country_code:recipient.country`, `date_range`.
- Keywords: `CMR`, `международная товарно-транспортная`.
- Сложности: мультиязычная (RU/EN/DE/PL). Коды стран — ISO 3166 alpha-2.

#### `transport_invoice` — Транспортная накладная (форма 2013)
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. Scope: global. Пороги: confidence 0.6.
- Поля: `number`, `date`, `shipper`, `consignee`, `carrier`, `payer`, `cargo_description`, `items[]`, `cargo_summary{places,weight_gross,weight_nett,volume_m3,dangerous_class}`, `conditions{temperature_min_c,temperature_max_c,humidity,special_marks}`, `declared_value`, `delivery_terms{pickup_datetime,delivery_datetime}`, `vehicle{plate,model,trailer_plate,trailer_model,weight_unladen}`, `driver{fio,license,phone}`, `loading_point{address,city,country}`, `unloading_point{...}`, `service_cost{amount,currency,vat_rate,vat_amount,amount_with_vat}`, `forwarder{name,inn}`, `transport_docs[]`, `distance_km`.
- Валидаторы: `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `Постановлен… Правительства РФ…272`, `приложение № 4 к Правилам перевозок грузов`, `условия перевозки…стоимость услуг перевозки`. Pattern weight 1.1 > TTN (1.0) — ссылка на Пост. № 272 = точно форма 2013, не старая 1-Т.
- Сложности: F17 SLAI. Без товарного раздела (груз текстом в `cargo_description`).

#### `transport_request` — Заявка на перевозку
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. Scope: global. Пороги: confidence 0.6.
- Поля: `number`, `date`, `client{name,inn,kpp,address,phone}`, `carrier{...}`, `route{loading,unloading,intermediate_stops[]}` (loading/unloading могут быть объектом ИЛИ массивом — multi-stop), `cargo{name,weight_t,volume_m3,places,temperature,dangerous_class,customs_info}`, `vehicle{plate,model,vin,year,capacity_t}`, `trailer{plate,model,type,volume_m3}`, `driver{fio,license,passport,phone}`, `rate{amount,currency,vat_included,vat_rate,payment_terms}`, `additional_terms`, `contact_responsible{fio,phone,email}`, `parent_contract_number`, `parent_contract_date`.
- Валидаторы: `inn_checksum:client.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `заявка (№|на перевозку|на транспортные услуги|на автоперевозку)`, `заявка-договор на перевозку`.
- Сложности: F16 SLAI. На открытом рынке `vehicle`/`driver` могут быть NULL (подбираются после акцепта). Acceptance: ИНН + адреса ≥ 90%, plate ≥ 95%.

#### `waybill` — Путевой лист
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. Scope: global. Пороги: confidence 0.6.
- Поля: `number`, `date`, `form`, `organization{name,inn,kpp,address}`, `vehicle{plate,model,type,vin,registration_certificate}`, `trailer{plate,model}`, `driver{fio,license,tab_number,passport}`, `route{departure_point,destination_point,intermediate_stops[],purpose}`, `departure_time`, `return_time`, `odometer_start`, `odometer_end`, `distance_total`, `fuel{fuel_type,rate_per_100km,issued_volume,remaining_start,remaining_end,consumed_volume}`, `medical_check{passed,timestamp,doctor_signature}`, `technical_check{passed,timestamp,mechanic_signature}`, `cargo_description`, `cargo_weight`, `notes`.
- Валидаторы: `inn_checksum:organization.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `путевой лист`, `форма 4-С`, `форма 4-П`, `форма ПЛ-1`.
- Сложности: F18 SLAI. Нет товарной части (`items[]` не заполняется) — груз общим объёмом.

### 🌍 ВЭД / таможня

#### `commercial_invoice` — Commercial Invoice
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `currency`, `exporter{name,address,country,tax_id}`, `consignee{...}`, `buyer`, `incoterms`, `payment_terms`, `positions[]{description,hs_code,qty,unit,unit_price,total_price,country_of_origin,weight_net,weight_gross}`, `total_amount`, `total_weight_net`, `total_weight_gross`.
- Валидаторы: `country_code:exporter.country`, `country_code:consignee.country`, `money_sanity:total_amount`, `date_range`.
- Keywords: `commercial invoice`, `INVOICE No.…`, `Incoterms? …\d{4}`, `exporter…consignee`, `country of origin`.
- Сложности: страны строго ISO alpha-2 (`China`→`CN`); промпт уточнён в migration 0026. HS-коды 6-10 цифр.

#### `proforma_invoice` — Инвойс-проформа
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `seller_name`, `seller_address`, `seller_country`, `buyer_name`, `buyer_address`, `buyer_country`, `currency`, `total_amount`, `incoterms`, `payment_terms`, `items[]{description,qty,unit_price,line_total}`.
- Валидаторы: нет (заведён без `validators`).
- Keywords: `proforma invoice`, `инвойс-проформа`, `предварительный инвойс`.
- Сложности: не фискальный; после отгрузки заменяется на `commercial_invoice`. Схема уплощена в migration 0026 (плоские `seller_*`/`buyer_*`).

#### `packing_list` — Packing List
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `exporter`, `consignee`, `invoice_number`, `positions[]{description,package_type,package_qty,items_per_package,qty,weight_net,weight_gross,dimensions,volume}`, `total_packages`, `total_weight_net`, `total_weight_gross`, `total_volume`.
- Валидаторы: `weight_nett_le_gross`, `date_range`.
- Keywords: `packing list`, `упаковочный лист`, `packing specification`.
- Сложности: пара к `commercial_invoice` (ссылка через `invoice_number`).

#### `bill_of_lading` — Коносамент (B/L)
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `bl_number`, `bl_type`, `date`, `shipper{name,address,country}`, `consignee{...}`, `notify_party{name,address}`, `carrier`, `vessel_name`, `voyage_number`, `port_of_loading`, `port_of_discharge`, `place_of_delivery`, `containers[]{container_number,seal_number,type,packages,weight_gross,measurement}`, `total_packages`, `total_weight_gross`, `freight_terms`.
- Валидаторы: `country_code:shipper.country`, `country_code:consignee.country`, `date_range`.
- Keywords: `bill of lading`, `коносамент`, `B/L No.…`, `Master B/L`, `House B/L`.
- Сложности: container number по ISO 6346 (4 буквы + 7 цифр). Страны ISO alpha-2 (промпт уточнён в migration 0026 — Qwen выдавал `China`/`Russia`).

#### `customs_declaration` — Таможенная декларация (ГТД)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `declaration_number`, `date`, `declaration_type`, `procedure_code`, `declarant{name,inn,kpp,address}`, `sender{name,inn,country,address}`, `recipient{...}`, `trading_country`, `origin_country`, `destination_country`, `transport_mode`, `currency`, `total_value`, `customs_value`, `exchange_rate`, `positions[]{number,description,hs_code,country_of_origin,gross_weight,net_weight,qty,unit,invoice_value,customs_value,statistical_value}`, `duties[]{type,base,rate,amount,currency}`.
- Валидаторы: `inn_checksum:declarant.inn`, `inn_checksum:sender.inn`, `inn_checksum:recipient.inn`, `money_sanity:total_value`, `money_sanity:customs_value`, `date_range`.
- Keywords: `декларация на товары`, `ГТД`, `ДТ №\d{8}`, `грузовая таможенная декларация`, `ТД-?[ИЭ]К\d`.
- Сложности: форма 0014001, очень табличный. Регномер XXXXXXXX/DDMMYY/XXXXXXX. HS-коды 10 цифр. Виды платежей 1010/2010/5010.

#### `cert_of_origin` — Сертификат происхождения
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `issue_date`, `form_type`, `exporter_name`, `exporter_country`, `consignee_name`, `consignee_country`, `product_description`, `hs_code`, `origin_country`, `invoice_ref`.
- Валидаторы: нет.
- Keywords: `сертификат происхождения`, `certificate of origin`, `form (CT-1|СТ-1|A|E)`, `country of origin`.
- Сложности: про страну происхождения (тарифные льготы), НЕ путать с `eac_conformity_certificate`. Формы СТ-1 / Form A / Form E.

#### `eac_conformity_certificate` — Сертификат соответствия ЕАЭС
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `doc_kind` (certificate / declaration), `issue_date`, `expiry_date`, `applicant_name`, `applicant_inn`, `applicant_address`, `manufacturer_name`, `manufacturer_country`, `product_description`, `tn_ved_code`, `tech_regulation`, `certification_body`.
- Валидаторы: нет.
- Keywords: `сертификат соответствия`, `N RU (Д-XX|С-XX)…`, `технически[йе] регламент`, `ТР ТС`, `ТР ЕАЭС`, `EAC conformity`.
- Сложности: про техническое соответствие, НЕ происхождение. Схема в migration 0026 умеет отличать сертификат от декларации о соответствии (`doc_kind`). Формат номера `N RU Д-CN.РА01.В.54075/24`.

#### `wire_transfer_application` — Заявление на перевод (ВЭД)
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `currency`, `amount`, `amount_words`, `sender_name`, `sender_inn`, `sender_account`, `beneficiary_name`, `beneficiary_address`, `beneficiary_country`, `beneficiary_iban`, `beneficiary_bank_name`, `beneficiary_bank_swift`, `purpose`, `contract_ref`, `invoice_ref`.
- Валидаторы: нет.
- Keywords: `заявление на перевод`, `application for (remittance|transfer)`, `SWIFT … [A-Z]{4}[A-Z]{2}…`, `beneficiary customer`, `sender to receiver information`, `Currency Code`, `банк-посредник`.
- Сложности: трансграничный перевод, НЕ путать с российской `payment_order` (там нет SWIFT/IBAN). Формы ВТБ № 284 / Сбербанк / Альфа.

#### `price_list` — Прайс-лист
- Категория: ВЭД (reference). Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `supplier_name`, `supplier_country`, `currency`, `valid_from`, `valid_to`, `items[]{sku,name,price,unit,min_qty}`.
- Валидаторы: нет.
- Keywords: `прайс-?лист`, `price list`, `прейскурант`, `(артикул|article|sku)…(цена|price)`.
- Сложности: не платёжный документ — reference data для расчёта стоимости. Если позиций > 50 — извлекаем первые 50, остальное в `metadata.total_items`.

#### `weighing_act` — Акт взвешивания
- Категория: ВЭД. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `container_number`, `scales_id`, `weight_gross_kg`, `weight_tare_kg`, `weight_net_kg`, `declared_gross_kg`, `declared_net_kg`, `performer_fio`, `port_name`.
- Валидаторы: нет.
- Keywords: `акт взвешивания`, `вес груженого контейнера`, `вес порожнего контейнера`, `свидетельство о поверке`, `(брутто|нетто|тара)…кг`.
- Сложности: доказательство веса для таможни/страховщика. Контейнер 4 буквы + 7 цифр. Все веса в кг.

### 🤝 Договорные

#### `contract` — Договор
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля (схема уплощена в migration 0026): `number`, `date`, `title`, `subject_kind` (supply/services/works/rent/purchase/agency/license/other), `subject`, `party_a_name`, `party_a_inn`, `party_a_role`, `party_b_name`, `party_b_inn`, `party_b_role`, `currency`, `total_amount`, `payment_terms`, `delivery_terms`, `effective_date`, `expiration_date`.
- Валидаторы: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `kpp_format:party_a.kpp`, `kpp_format:party_b.kpp`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `date_range`. (Пути валидаторов — на исходную nested-схему; после уплощения проверь актуальность.)
- Keywords (с весами): `ДОГОВОР №`, `Предмет … договора`, `Права и обязанности Сторон`, `Срок действия Договора`, `Подписи Сторон`, `Договор поставки/оказания услуг/подряда/аренды/купли-продажи`. Title-position match `^Договор №…` имеет вес 20.0.
- Сложности: длинный (5-30 страниц), положения НЕ пересказываем. Старая nested-схема перегружала Qwen 32B (ответ `{}`) → уплощена до top-12 в migration 0026. Подвиды распознаются по `subject_kind`, узкие подтипы — через UI.

#### `contract_specification` — Спецификация / Приложение к договору
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `title`, `parent_contract_number`, `parent_contract_date`, `party_a{role,name,inn,kpp}`, `party_b{...}`, `positions[]{number,name,code,unit,qty,price,total,vat_rate,vat_amount,delivery_term}`, `total_amount`, `total_vat`, `currency`, `vat_included`.
- Валидаторы: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `positions_sum`, `date_range`.
- Keywords (с весами, migration 0030): `Спецификация №N к (Договор|Контракт)`, `Приложение №N к …`, `Приложение к …`, `Спецификация товара`, `Спецификация к …`, и standalone `Спецификация №N` (вес 5.0, ×1.5 в title window).
- Сложности: ссылается на родителя через `parent_contract_number`+`parent_contract_date` (из заголовка). Real-case: spec-документы разрывают «Спецификация №N … к Договору» строкой с датой → standalone headline pattern добавлен в migration 0030, чтобы не фолбэчить в `contract`.

#### `contract_addendum` — Дополнительное соглашение
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `title`, `parent_contract_number`, `parent_contract_date`, `addendum_kind` (amendment/termination/extension/price_change/renaming/other), `party_a{role,name,inn,kpp,representative_name}`, `party_b{...}`, `changes[]{clause,action,old_text,new_text}`, `new_total_amount`, `new_expiration_date`, `effective_date`.
- Валидаторы: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `date_range`.
- Keywords: `Дополнительное соглашение`, `Доп. соглашение`, `Соглашение об изменении`, `Соглашение о расторжении`, `О внесении изменений в Договор`.
- Сложности: стороны те же что в родителе. `changes[]` — список модификаций пунктов. При расторжении `addendum_kind=termination`, `changes` можно пустым.

### 📦 Складские

#### `transfer_note` — Перемещение товаров (ТОРГ-13)
- Категория: складские. Парсер: `llm_extract`. Tier: beta. Scope: global.
- Поля: `number`, `date`, `organization_name`, `organization_inn`, `source_warehouse`, `target_warehouse`, `responsible_fio`, `items[]{name,code,qty,unit,price,total}`.
- Валидаторы: нет.
- Keywords (с весами, migration 0030): `перемещение товаров`, `накладная на перемещение`, `ТОРГ-?13`, `отправитель…получатель…склад`, `(склад|места хранения)…(откуда|куда|источник|назначение)`.
- Сложности: внутреннее перемещение между складами (1С/SAP), не внешний оборот. 1С-формат «Накладная на перемещение № … от …» добавлен в migration 0030 (раньше требовалось слово «товаров» → падало в null).

---

## Как добавить тип

### Админ (через UI `/document-types`)
Создаёт кастомный тип записью в `document_types` без правок кода. Поля формы:
- `slug` — глобально уникальный (natural key, webhook-контракт slug-based).
- `display_name`, `description`.
- `parser_kind` — практически всегда `llm_extract` (regex-парсеры только у builtin).
- `expected_fields` — пути полей для `missing[]`.
- `llm_schema` (JSON Schema) + `llm_prompt` — основной конфиг extract'а.
- `validators` — из реестра (`inn_checksum`, `kpp_format`, `vat_consistency`, `vehicle_plate`, `country_code`, `parties_differ`, `money_sanity`, `date_range`, `positions_sum`, `weight_nett_le_gross`).
- `classification_keywords` (+ опц. `classification_keyword_weights`).
- `tier` — новый custom по умолчанию `experimental`.
- `scope` — `organization_id` своего тенанта (org-owned). NULL/global недоступен через UI обычному тенанту.

### Разработчик (типизированный builtin)
Если нужен Zod-typed builtin с regex-парсером:
1. Миграция `INSERT INTO document_types (...)` (forward-only, новый файл — не править отгруженные).
2. Zod-схема в `src/types/documents.ts` (если builtin-typed) + при необходимости `DOCUMENT_TYPES`.
3. regex-парсер в `src/pipeline/parsers/` (если `parser_kind=builtin:*`).
4. outbound alias в `src/types/slug-normalize.ts`, если internal slug расходится с конвенцией lowercase snake_case.
5. vitest-тест в `doc-service/tests/`.
6. **Эта дока** — секция в категории + строка в таблице, той же датой.
7. `npx tsc --noEmit` из `doc-service`.

---

## Outbound slug aliasing

Из `src/types/slug-normalize.ts` (`OUTBOUND_SLUG_ALIASES`, применяется в `normalizeSlugForApi()` на отдаче в webhook/API). Слаги, не упомянутые здесь, проходят без изменений.

| Internal (DB) | Outbound (API/webhook) |
|---|---|
| `TTN` | `ttn` |
| `UPD` | `upd` |
| `CMR` | `cmr` |
| `AKT` | `services_act` |
| `factInvoice` | `tax_invoice` |

Inbound (slai_alias → наш slug) делает `documentTypeResolver.expandSlugCandidates()` (F22), case-insensitive через `SLAI_ALIASES`.

---

## SLAI ТЗ соответствие

### Фаза 1 (10/10 ✅)

| SLAI `document_type` | Наш internal slug | Tier / статус |
|---|---|---|
| `invoice` | `invoice` | stable |
| `transport_request` | `transport_request` | experimental (F16) |
| `ttn` | `TTN` | stable |
| `transport_invoice` | `transport_invoice` | experimental (F17) |
| `cmr` | `CMR` | stable |
| `waybill` | `waybill` | experimental (F18) |
| `upd` | `UPD` | stable |
| `services_act` | `AKT` | stable |
| `tax_invoice` | `factInvoice` | stable |
| `payment_order` | `payment_order` | beta |

### ВЭД Фаза 2 (8/8 ✅, golden-set валидация ждёт)

| Категория ВЭД | Наш internal slug | Tier |
|---|---|---|
| Commercial Invoice | `commercial_invoice` | beta |
| Proforma Invoice | `proforma_invoice` | beta |
| Packing List | `packing_list` | beta |
| Bill of Lading | `bill_of_lading` | beta |
| Таможенная декларация | `customs_declaration` | beta |
| Сертификат происхождения | `cert_of_origin` | beta |
| Сертификат соответствия ЕАЭС | `eac_conformity_certificate` | beta |
| Заявление на перевод | `wire_transfer_application` | beta |

> Сопутствующие ВЭД-типы вне строгого ТЗ: `weighing_act`, `price_list` (reference).

---

## Tier & scope

### Tier (уровень зрелости — `document_types.tier`)
- **stable** — типизированная Zod-схема + regex-парсер (или вылизанный LLM) + ≥90% accuracy на golden-set. Только 6 builtin'ов.
- **beta** — обкатан на проде, есть keywords + (обычно) validators, но без замера на golden-set. 16 custom-типов.
- **experimental** (default для нового custom) — мало накопленных данных, поведение может быть нестабильным. Сейчас: `transport_request`, `transport_invoice`, `waybill`, `UKD`.

Runtime НЕ ветвится на tier — resolver пробрасывает его в `ResolvedTypeConfig`, UI/логи показывают бейдж, SLAI-интегратор видит предупреждение.

**Promotion path:** `experimental` → `beta` (накоплены прод-данные, заведены keywords/validators) → `stable` (golden-set ≥90% + по необходимости typed-схема). Понижение возможно при регрессии.

### Scope (владение — `document_types.organization_id`)
- `NULL` ⇒ **global**: виден всем тенантам. Все builtin (CHECK `chk_builtin_is_global` запрещает builtin с не-NULL org) + shared custom.
- `<org uuid>` ⇒ **org-owned**: виден только своему тенанту + super_admin.
- Slug остаётся глобально уникальным — `organization_id` рулит ТОЛЬКО видимостью/владением, не смыслом slug'а (`invoice` значит одно и то же везде).
- Тенант видит: globals ∪ свои org-owned.
- На 2026-05-20 все 26 типов — global; org-owned заводятся тенантами после деплоя CP7.
