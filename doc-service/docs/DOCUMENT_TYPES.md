# Типы документов parsdocs

> Источник правды по поддерживаемым типам. Добавил тип в Registry — допиши сюда той же датой.
> Обновлено: 2026-07-21 (полная сверка с прод-БД и кодом).

## Обзор

- Всего активных типов: **52**.
- Tier-распределение: **stable** 6 / **beta** 30 / **experimental** 16.
- Каталог **DB-driven**: источник — таблица `document_types`, runtime-конфиг собирает
  `documentTypeResolver.resolveConfig(slug)`. Код не содержит «списка типов» — только фолбэк-схемы.
- `parser_kind` у **всех 52 типов** — `llm_extract`: извлечение всегда идёт через LLM
  (GenericLlmParser). Regex-путь на проде мёртв (см. «Как читать»).
- **Схемы в коде при `llm_schema=NULL`.** У части типов (builtin-шестёрка `invoice` /
  `factInvoice` / `UPD` / `AKT` / `TTN` / `CMR` + `bill_of_lading`) в БД `llm_schema=NULL` —
  боевая схема тогда берётся из кода. Цепочка: `orchestrator.ts:1696` →
  `documentTypeResolver.resolveConfig(slug)` → `src/pipeline/document-type-resolver.ts:259-262` →
  `resolveConfigFromRow` (там же `:273-348`). Внутри: (1) `:295`
  `builtinSlug = canonicalizeSlugForBuiltins(slug)` (`src/types/slug-normalize.ts:84-87`,
  для `bill_of_lading` идемпотентно); (2) `:301`
  `fallbackSchema = DOCUMENT_JSON_SCHEMAS[builtinSlug] ?? EXTENDED_SCHEMAS[slug] ?? {}`;
  (3) непустой `llm_schema` из БД всегда приоритетнее фолбэка.
- Реальный прод-объём (done-джобы), топ-5: `bill_of_lading` 335, `customs_declaration` 259,
  `invoice` 228, `proforma_invoice` 102, `awb` 84.

## Как читать

- **Internal slug** — то, что лежит в БД (`document_types.slug`), пишется в логи, classifier,
  `document_hint`. Историческое имя (UPPERCASE / camelCase у части builtin'ов).
- **Outbound slug** — то, что уходит в webhook/API. Трансляция в `normalizeSlugForApi()`
  (`src/types/slug-normalize.ts`). Если в таблице aliasing'а нет — internal == outbound.
- **Парсер** (`parser_kind`): для ВСЕХ типов с `parser_kind='llm_extract'` в БД (включая
  `invoice`/`factInvoice`/`UPD`/`AKT`) реально запускается LLM — regex-парсеры НЕ в игре.
  Код-путь: `src/pipeline/orchestrator.ts:1709-1718` — если
  `typeConfig.parserKind === 'llm_extract'` → `parsersFactory.getGeneric(documentType)`;
  если `'llm_extract_multipass'` — multipass-вариант для тяжёлых многостраничных документов.
  Независимо от `parser_kind`, текст > 15 000 байт автоматически уходит в multipass
  (порог `multipassAutoBytes`). Regex-код (`InvoiceParser`, `UpdParser`) диспатчится только при
  `parser_kind=NULL` или `builtin:*` — таких строк в проде нет.
- **Tier**: `stable` / `beta` / `experimental`. Runtime НЕ принимает решений на основе tier —
  это бейдж для UI/SLAI.
- **Scope**: `global` (виден всем тенантам) / `org-owned` (виден только своему тенанту +
  super_admin). Builtin всегда global (CHECK `chk_builtin_is_global`).
- **Док-ов в проде** — число завершённых (done) джобов этого типа в прод-статистике на дату
  сверки. 0 = тип заведён и рабочий, но реальных документов через него ещё не прошло.
- **Поля** — это **боевая схема извлечения**: `llm_schema` из БД, а при `llm_schema=NULL` —
  схема из кода (`DOCUMENT_JSON_SCHEMAS` / `EXTENDED_SCHEMAS`, см. Обзор). Колонка БД
  `expected_fields` — отдельная сущность (участвует только в `ParseResult.missing[]`) и у ряда
  типов рассинхронизирована со схемой (см. «Известные несоответствия БД»).
- **Валидаторы** (`validators`): `inn_checksum:<path>` (чек-сумма ФНС), `kpp_format:<path>`,
  `vat_consistency`, `vehicle_plate:<path>`, `country_code:<path>` (ISO 3166 alpha-2),
  `parties_differ:<a>,<b>`, `money_sanity:<path>`, `date_range[:<path>]`, `positions_sum`,
  `weight_nett_le_gross`.

## Категории

### 💰 Финансовые / учётные

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `AKT` | `services_act` | Акт оказанных услуг / выполненных работ | llm_extract | stable | 16 | Два контрагента + услуги; схема в коде (AKT_SCHEMA) |
| `factInvoice` | `tax_invoice` | Счёт-фактура | llm_extract | stable | 15 | Структура как УПД; схема в коде (INVOICE_SCHEMA) |
| `invoice` | `invoice` | Счёт на оплату | llm_extract | stable | 228 | Самый массовый РФ-тип; схема в коде (INVOICE_SCHEMA) |
| `UPD` | `upd` | УПД | llm_extract | stable | 0 | Универсальный передаточный документ; схема в коде |
| `cash_receipt` | `cash_receipt` | Кассовый чек | llm_extract | beta | 0 | ККТ 54-ФЗ, ФН/ФД/ФП |
| `payment_order` | `payment_order` | Платёжное поручение | llm_extract | beta | 6 | Форма 0401060, БИК/счёт |
| `UKD` | `ukd` | Корректировочный УПД (УКД) | llm_extract | experimental | 0 | Статус 1 (с НДС) / 2 (без НДС), показатели ДО/ПОСЛЕ |

> **Про «regex-парсеры» у stable-четвёрки.** В БД у всех четырёх builtin'ов
> (`invoice`, `factInvoice`, `UPD`, `AKT`) `parser_kind='llm_extract'` — а при
> этом значении orchestrator всегда берёт `GenericLlmParser` (CP1,
> `orchestrator.ts:1709-1718` → `parsers/index.ts:85-91`). Regex-код
> (`InvoiceParser`, `UpdParser`) диспатчится только при `parser_kind=NULL` или
> `builtin:*` — таких строк в проде нет, т.е. **regex-путь на проде мёртв**.
> `description` в БД у `invoice`/`factInvoice`/`UPD` всё ещё говорит «парсится
> регулярками» — устарел, противоречит собственному `parser_kind`.

#### `invoice` — Счёт на оплату (внутренний РФ)
- Категория: финансовые. Парсер: `llm_extract`. Tier: stable. prefer_vision: нет.
- **Поля** (схема в коде — INVOICE_SCHEMA, БД `llm_schema=NULL`; fallback `DOCUMENT_JSON_SCHEMAS['invoice']`): `number`, `date`, `seller`/`buyer` (PARTY: name, inn, kpp, ogrn, address + банк-блок bank/bik/account/corr_account, phone), `shipper`/`consignee` (если отличаются от сторон), `currency`, `exchange_rate`, `total`, `total_without_vat`, `vat`, `vat_rate`, `vat_summary[]` (разбивка по ставкам), `flags{is_export,is_advance,vat_agent,usn}`, платёжно-сверочный блок EXT-PAY: `payee` (банковский получатель — может ≠ seller на агентских/маркетплейс-счетах), `payment_purpose`, `amount_due`, `vat_included_amount`, `shipping_amount`, `prepayment_amount`, `amount_in_words`, `line_count`, `payment_terms`, `due_date`, `payment_method`; договорная привязка `contract_no`/`contract_date`, период `period_from`/`period_to`; транспортный блок для перевозочных счетов (`order_ref`, `order_refs[]`, `vehicle{plate,model,trailer,axles}`, `route_from`/`route_to`, `permit_no`, nested `transport{}`); `items[]` (общий ITEM_PROPERTIES), `document_stage` (draft/proforma/final). БД `expected_fields` (6): number, date, seller, buyer, total, items.
- **Валидаторы**: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`, `money_sanity:total`, `money_sanity:vat`.
- **Keywords**: `сч[её]т на оплату`, `сч[её]т №`, `счёт-оферта`, `инвойс №/на оплату`, разрежённое `с ч ё т` (OCR).
- **Заметка**: банковские реквизиты сторон есть в PARTY (F19 закрыт). `payee`+`payment_purpose` — ключи банковской автосверки; `amount_in_words` — кросс-проверка OCR-цифр. Не путать с `commercial_invoice` (ВЭД): `invoice` = русский счёт, включая USD-фрахт — правило «инвалюта → ВЭД» отклонено (уронило бы счета в валюте).

#### `factInvoice` → `tax_invoice` — Счёт-фактура
- Категория: финансовые. Парсер: `llm_extract`. Tier: stable. prefer_vision: нет.
- **Поля** (схема в коде, БД NULL — тот же INVOICE_SCHEMA, что у `invoice`/`UPD`): см. `invoice`. Для СФ значимы `flags.is_advance` (СФ на аванс), `flags.vat_agent`, `vat_summary[]` (несколько ставок). БД `expected_fields` (6): number, date, seller, buyer, total, vat. Код-side `EXPECTED_FIELDS` шире (+ vat_summary, items) — но при непустом столбце БД действует он.
- **Валидаторы**: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`.
- **Keywords**: `счет-фактура`, `счёт-фактура`.
- **Заметка**: outbound slug = `tax_invoice` (aliasing). Не путать с `invoice` (счёт на оплату). description в БД упоминает regex — устарел (см. врезку выше).

#### `UPD` → `upd` — УПД
- Категория: финансовые. Парсер: `llm_extract`. Tier: stable. prefer_vision: нет.
- **Поля** (схема в коде, БД NULL — INVOICE_SCHEMA, общая с `invoice`/`factInvoice`): см. `invoice`. БД `expected_fields` (5): number, date, seller, buyer, total.
- **Валидаторы**: `inn_checksum:seller.inn`, `inn_checksum:buyer.inn`, `vat_consistency`, `date_range`, `parties_differ:seller.inn,buyer.inn`.
- **Keywords**: `универсальный передаточный документ`, `УПД` (word-boundary).
- **Заметка**: исторически самый тяжёлый тип Фазы 1 (SLAI ⭐⭐⭐⭐⭐). В done-статистике прода 0 джобов — корректировки заведены отдельным типом `UKD`. description в БД («парсится regex») устарел.

#### `AKT` → `services_act` — Акт оказанных услуг / выполненных работ
- Категория: финансовые. Парсер: `llm_extract`. Tier: stable. prefer_vision: нет.
- **Поля** (схема в коде — AKT_SCHEMA, БД NULL): `number`, `date`, `party_a` (Исполнитель, PARTY), `party_b` (Заказчик, PARTY), `currency`, `total`, `total_without_vat`, `vat` (0 для УСН), `vat_rate`, `vat_summary[]`, `flags`, `total_in_words`, `service_description` (контент акта, если нет таблицы позиций), `no_claims_flag` («претензий не имеет» — триггер закрытия/оплаты), `place_of_compilation`, `period_from`/`period_to`, `items[]`, `parent_contract_number`/`parent_contract_date`, `order_refs[]`, `containers`, `container_number`. БД `expected_fields` (5): number, date, party_a, party_b, total.
- **Валидаторы**: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `date_range`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total`, `money_sanity:vat`.
- **Keywords**: `акт (оказанных|выполненных|сдачи-приёмки|приёма-сдачи|об оказании)`, `акт об оказании`.
- **Заметка**: outbound slug = `services_act`. Извлечение идёт СО схемой — AKT_SCHEMA подхватывается фолбэком `DOCUMENT_JSON_SCHEMAS['AKT']` (утверждение «extract без схемы» из ранних заметок неверно, проверено по резолверу).

#### `payment_order` — Платёжное поручение
- Категория: финансовые. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет.
- **Поля** (llm_schema в БД): `number`, `date`, `date_charged` (списание со счёта), `amount`, `amount_text` (прописью), `payment_kind` (электронно/телеграфно/почтой), `priority` (очерёдность 1-5), `payer{name,inn,kpp,account,bic,bank_name,correspondent_account}`, `payee{…то же…}`, `purpose` (назначение целиком, включая текст про НДС).
- **Валидаторы**: `inn_checksum:payer.inn`, `inn_checksum:payee.inn`, `parties_differ:payer.inn,payee.inn`, `kpp_format:payer.kpp`, `kpp_format:payee.kpp`, `money_sanity:amount`, `date_range`.
- **Keywords**: `платёжное/платежное поручение`, `П.П. №`, банковские штампы `Поступ. в банк плат.` / `Списано со сч. плат.`.
- **Заметка**: форма 0401060, структура жёсткая — модель справляется хорошо. ИНН плательщика ≠ ИНН получателя — не путать стороны. БИК 9 цифр, счёт 20 цифр.

#### `cash_receipt` — Кассовый чек
- Категория: финансовые. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет.
- **Поля** (llm_schema в БД): `merchant{name,inn,address,store_id}`, `check_number`, `shift_number`, `date_time` (YYYY-MM-DD HH:MM), `cashier_name`, `fn_number` (ФН, 16 цифр), `fd_number` (ФД), `fp` (ФП, 10 цифр), `kkt_serial`, `ofd_name`, `check_type` (Приход/Возврат прихода/Расход), `items[]` (общий ITEM_PROPERTIES: name, qty, price, vat_rate, vat_amount, …), `total`, `vat_amount`, `payment_method` (НАЛИЧНЫМИ/БЕЗНАЛИЧНЫМИ/СМЕШАННАЯ), `payment_cash`, `payment_card`.
- **Валидаторы**: `inn_checksum:merchant.inn`, `money_sanity:total`, `date_range`.
- **Keywords**: `кассовый чек`, `ФН \d{16}`, `ФД \d`, `ФПД? \d`, `54-ФЗ`.
- **Заметка**: ФН/ФД/ФП — идентификаторы проверки подлинности в ОФД. Применяется в авансовых отчётах и розничной верификации. Позиции — общий item-шаблон (в нём есть нерелевантные чеку hs_code/weight_* — модель их не заполняет). В done-статистике прода пока 0 джобов.

#### `UKD` → `ukd` — Корректировочный УПД (УКД)
- Категория: финансовые. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет.
- **Поля** (llm_schema в БД): `number`, `date`, `status` (1 — с НДС, 2 — без), `base_doc_number`/`base_doc_date` + `base_doc_refs[]{type,number,date}` (ссылки на исходные УПД/счёт-фактуру), стороны плоско: `seller_name`/`seller_inn`/`seller_kpp`/`seller_address`, `buyer_*` аналогично, `currency`/`currency_code`, итоги ДО/ПОСЛЕ: `total_before`/`total_after`, `vat_before`/`vat_after`, `correction_kind`, `items[]` — строки корректировки с парами `qty_before/after`, `price_before/after`, `total_before/after`, `vat_before/after` + `okei_code`, `traceability_reg_number` (графа 11, прослеживаемость).
- **Валидаторы**: нет (заведён без `validators`).
- **Keywords** (с весами 6/5/5/4/3, миграция 0028): `УКД`, `корректировочн… (счет|документ)`, `универсальн… корректировочн…`, `к счёт-фактуре №…`, `(увеличение|уменьшение) стоимости`.
- **Заметка**: outbound slug = `ukd` (в alias-map, lowercase). Стороны — плоские `seller_*`/`buyer_*` (без nested party). Ядро типа — попарные показатели ДО/ПОСЛЕ на строку и на итог. `expected_fields` в БД — 15 полей (самый строгий acceptance среди финансовых).

### 🤝 Договорные

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `contract` | `contract` | Договор | llm_extract | beta | 7 | Подвиды через `subject_kind`; схема уплощена (0026) |
| `contract_addendum` | `contract_addendum` | Дополнительное соглашение | llm_extract | beta | 1 | `changes[]`, ссылка на родителя |
| `contract_specification` | `contract_specification` | Спецификация / Приложение | llm_extract | beta | 17 | Таблица позиций + ссылка на родителя; самый частый договорной тип в проде |
| `power_of_attorney` | `power_of_attorney` | Доверенность (М-2/М-2а) | llm_extract | experimental | 2 | Полномочия на получение ТМЦ |

#### `contract` — Договор
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет.
- **Поля** (llm_schema в БД, уплощена в миграции 0026): `number`, `date`, `title`, `subject_kind` (supply/services/works/rent/purchase/agency/license/other), `subject` (1-2 предложения), плоские стороны: `party_a_name`/`party_a_inn`/`party_a_role`, `party_b_*` аналогично, `currency`, `total_amount`, `payment_terms`, `delivery_terms`, `effective_date`, `expiration_date`, `order_refs[]`.
- **Валидаторы**: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `kpp_format:party_a.kpp`, `kpp_format:party_b.kpp`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `date_range`. ⚠️ Пути валидаторов — dotted (`party_a.inn`), а схема плоская (`party_a_inn`); после уплощения актуальность путей не сверена.
- **Keywords** (с весами): `ДОГОВОР №`/`КОНТРАКТ №` (title-match `^Договор №` — вес 20.0), `Предмет … договора/контракта`, `Права и обязанности Сторон`, `Срок действия`, `Подписи Сторон`, `Договор поставки/оказания услуг/подряда/аренды/купли-продажи`, `настоящий договор о нижеследующем`.
- **Заметка**: длинный (5-30 страниц) — положения НЕ пересказываем, извлекаем только реквизиты/стороны/сумму/сроки. Старая nested-схема перегружала Qwen 32B (ответ `{}`) → уплощена до top-полей в 0026. Текст > 15 000 байт автоматически уходит в multipass-извлечение (порог `multipassAutoBytes`) — для договоров это штатный путь. Узкие подтипы — через UI.

#### `contract_addendum` — Дополнительное соглашение
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет.
- **Поля** (llm_schema в БД): `number`, `date`, `title`, `parent_contract_number`/`parent_contract_date`, `addendum_kind` (enum: amendment/termination/extension/price_change/renaming/other), `party_a{name,inn,kpp,role,representative_name}`, `party_b{…}`, `changes[]{clause,action(modify/replace/add/remove),old_text,new_text}`, `new_total_amount`, `new_expiration_date`, `effective_date`.
- **Валидаторы**: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `date_range`.
- **Keywords**: `Дополнительное соглашение`, `Доп. соглашение`, `Соглашение об изменении`, `Соглашение о расторжении`, `О внесении изменений в Договор/Контракт`.
- **Заметка**: стороны те же, что в родительском договоре (тут они nested, в отличие от плоского `contract`). `changes[]` — список модификаций пунктов; при расторжении `addendum_kind=termination`, `changes` может быть пустым.

#### `contract_specification` — Спецификация / Приложение к договору
- Категория: договорные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет.
- **Поля** (llm_schema в БД): `number`, `date`, `title`, `parent_contract_number`/`parent_contract_date` (из заголовка), `party_a{role,name,inn,kpp}`, `party_b{…}`, `items[]` (общий ITEM_PROPERTIES + `delivery_term` по позиции, `hs_code`, `country_of_origin`), `total_amount`, `total_vat`, `vat_rate`, `currency`, `vat_included`, `representative_name`.
- **Валидаторы**: `inn_checksum:party_a.inn`, `inn_checksum:party_b.inn`, `parties_differ:party_a.inn,party_b.inn`, `money_sanity:total_amount`, `positions_sum`, `date_range` (`positions_sum` — историческое имя, строки в схеме лежат в `items[]`).
- **Keywords** (с весами, миграция 0030): `Спецификация №N к (Договор|Контракт)`, `Приложение №N к …`, `Приложение к …`, `Спецификация товара`, `Спецификация к …`, standalone `Спецификация №N` (вес 5.0, ×1.5 в title-window).
- **Заметка**: самое частое приложение к договору (и самый частый договорной тип в проде — 17 done-джобов). Real-case: заголовок «Спецификация №N … к Договору» разрывается строкой с датой → standalone-паттерн добавлен в 0030, чтобы не фолбэчить в `contract`. Может быть с ценами и без.

#### `power_of_attorney` — Доверенность (М-2 / М-2а)
- Категория: договорные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет.
- **Поля** (llm_schema в БД): `number`, `date` (выдачи), `valid_until`, `principal{name,inn,kpp,address}` (доверитель — организация), `representative{fio,position,passport}` (доверенное лицо — физлицо), `supplier{name}` (от кого получают ТМЦ), `basis` (счёт/договор-основание), `authority` (что доверяется), `positions[]{name,qty,unit}`.
- **Валидаторы**: `date_range`.
- **Keywords** (plain-литералы, substring): `доверенность` (в начале строки), `м-2`, `доверяю`, `уполномочивает`, `представлять интересы`.
- **Заметка**: формы М-2/М-2а на получение ТМЦ + представление интересов. `valid_until` — ограниченный срок действия; представитель идентифицируется паспортом. Здесь строки называются `positions[]` (не `items[]`) — единственный такой из договорных.

### 🚚 Транспортные

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `CMR` | `cmr` | CMR (Международная накладная) | llm_extract | stable | 2 | Мультиязычная RU/EN/DE/PL; в статистике ещё 4 джоба под слагом `cmr` — дубль-учёт |
| `TTN` | `ttn` | Транспортная накладная (ТН, РФ) | llm_extract | stable | 4 | Историческая 1-Т/товарно-транспортная; display_name в БД похоже перепутан с `transport_invoice` |
| `empty_container_return` | `empty_container_return` | Инструкция по возврату порожнего контейнера | llm_extract | beta | 22 | Не накладная и не booking — операционное указание |
| `forwarding_order` | `forwarding_order` | Поручение экспедитору | llm_extract | beta | 50 | Клиент → экспедитор (ТЭК); ≠ `transport_request` (заказчик → перевозчик) |
| `awb` | `awb` | Авианакладная (Air Waybill) | llm_extract | experimental | 84 | IATA, 11-значный номер; самый частый experimental |
| `booking_request` | `booking_request` | Заявка-бронь на перевозку | llm_extract | experimental | 8 | Близка к `transport_request`; заявитель — экспедитор |
| `cim` | `cim` | Ж/д накладная ЦИМ (CIM) | llm_extract | experimental | 3 | КОТИФ, Европа |
| `manifest` | `manifest` | Грузовой манифест | llm_extract | experimental | 6 | Список грузов рейса по B/L или AWB |
| `smgs` | `smgs` | Ж/д накладная СМГС | llm_extract | experimental | 19 | СНГ/Китай; + `border_crossing` относительно CIM |
| `transport_invoice` | `transport_invoice` | Транспортная накладная (форма 2013) | llm_extract | experimental | 10 | Пост. № 272; display_name в БД («ТТН, 1-Т») противоречит собственному description — перепутан с `TTN` |
| `transport_request` | `transport_request` | Заявка на перевозку | llm_extract | experimental | 8 | До рейса; ТС/водитель могут быть NULL |
| `waybill` | `waybill` | Путевой лист | llm_extract | experimental | 0 | Формы 4-С / 4-П / ПЛ-1; на проде пока не встречался |

#### `CMR` → `cmr` — CMR (международная накладная)
- Категория: транспортные. Парсер: `llm_extract`. Tier: stable. prefer_vision: false.
- Поля (builtin-схема в коде, в БД `llm_schema=NULL`): `number`, `date`, `sender{name,inn,address,country}`, `recipient{…,country}`, `carrier{name,inn,address}`, `cargo{description,packages,weight}`, `loading_place`, `delivery_place`.
- Валидаторы: `country_code:sender.country`, `country_code:recipient.country`, `date_range`.
- Keywords: `CMR`, `международная товарно-транспортная`.
- Заметка: мультиязычная (RU/EN/DE/PL), страны — ISO 3166 alpha-2. `expected_fields` в БД пуст → `missing[]` всегда пустой, а UI-счётчик «Поля» показывает 0 (считает сырую БД-колонку, не боевую схему). В прод-статистике тип раздвоен: `CMR` (2) + `cmr` (4).

#### `TTN` → `ttn` — Транспортная накладная (товарно-транспортная, 1-Т)
- Категория: транспортные. Парсер: `llm_extract`. Tier: stable. prefer_vision: false.
- Поля (builtin-схема в коде, в БД `llm_schema=NULL`): `number`, `date`, `shipper{name,inn,address}`, `consignee{…}`, `cargo{name,quantity,weight_gross,weight_nett,places}`, `vehicle{plate,driver}`, `loading_point`, `unloading_point`.
- Валидаторы: `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `vehicle_plate:vehicle.plate`, `date_range`, `parties_differ:shipper.inn,consignee.inn`.
- Keywords: `транспортная накладная`, `товарно-транспортная накладная`, `ТТН`.
- Заметка: display_name в БД — «Транспортная накладная (ТН, РФ)», а у `transport_invoice` — «ТТН, 1-Т»: имена, судя по description'ам, перепутаны местами. Классификационная развилка с `transport_invoice` держится на маркерах Пост. № 272 (у того паттерны специфичнее). `expected_fields` пуст → `missing[]` всегда пустой, UI показывает «0 полей».

#### `empty_container_return` — Инструкция по возврату порожнего контейнера
- Категория: транспортные. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `container_numbers[]`, `return_terminal`, `return_address`, `return_deadline`, `shipping_line`, `order_ref`, `instructions`.
- Валидаторы: нет.
- Keywords: `инструкция по возврату`, `возврат/сдача/вывоз порожн…`, `empty container return`.
- Заметка: операционное указание после выгрузки (куда и до какого срока сдать пустой контейнер). НЕ транспортная накладная и НЕ booking. Контейнеры — ISO 6346.

#### `forwarding_order` — Поручение экспедитору
- Категория: транспортные. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `number`, `date`, `leg`, `client{inn,kpp,name,phone,address}`, `expeditor{…}`, `shipper{name,address,country}`, `consignee{…}`, `carrier{inn,name}`, `route{loading,unloading,intermediate_stops}`, `cargo{name,places,hs_code,packaging,volume_m3,hazard_class,weight_net_kg,weight_gross_kg}`, `rate{amount,currency,description}`, `order_ref`.
- Валидаторы: нет.
- Keywords: `поручение экспедитору`, `на организацию доставки груза`, `транспортно-экспедиционных услуг`.
- Заметка: четырёхсторонняя модель Клиент — Экспедитор — Грузоотправитель — Грузополучатель; отличать от `transport_request` (там заказчик ↔ перевозчик). Бывает на одно плечо (`leg`: авиа/авто/жд/море) или на всю перевозку.

#### `awb` — Авианакладная (Air Waybill)
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `awb_number`, `date`, `airline`, `flight_no`, `flight_date`, `shipper{name,address}`, `consignee{name,address}`, `airport_of_departure`, `airport_of_destination`, `pieces`, `gross_weight_kg`, `chargeable_weight_kg`, `nature_of_goods`, `charges{amount,currency}`.
- Валидаторы: `date_range`.
- Keywords: `air waybill`, `awb`, `авианакладн…`, `авиагрузов…`.
- Заметка: номер AWB — 11 цифр IATA. 84 дока на проде — кандидат на повышение из experimental.

#### `booking_request` — Заявка-бронь на перевозку
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `requestor{inn,kind,name}`, `carrier{inn,name}`, `route{loading,unloading}`, `cargo{name,weight_t,volume_m3}`, `vehicle{model,plate}`, `rate{amount,currency}`.
- Валидаторы: `date_range`.
- Keywords: `заявка-бронь`, `бронировани… перевозк…`, `booking`, `букинг`.
- Заметка: близка к `transport_request`, но заявитель — экспедитор/форвардер (`requestor.kind`).

#### `cim` — Ж/д накладная ЦИМ (CIM)
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `consignor{name,address,country}`, `consignee{…}`, `carrier{name}`, `station_of_dispatch`, `station_of_destination`, `route_via`, `wagon_number`, `container_no`, `cargo{packages,weight_kg,description}`.
- Валидаторы: `date_range`.
- Keywords: `CIM`, `ЦИМ`, `котиф`, `rail consignment`.
- Заметка: конвенция КОТИФ (Европа). Пара к `smgs` — у того же ядро схемы + `border_crossing`.

#### `manifest` — Грузовой манифест
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `carrier{name}`, `vessel_or_flight{name,voyage_or_flight_no}`, `port_of_loading`, `port_of_discharge`, `items[]{bl_or_awb_no,shipper,consignee,container_no,packages,weight_kg,description}`.
- Валидаторы: `date_range`.
- Keywords: `cargo manifest`, `грузов… манифест`, `manifest`.
- Заметка: агрегирующий документ рейса/судна — строки ссылаются на коносаменты/AWB (`bl_or_awb_no`).

#### `smgs` — Ж/д накладная СМГС
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `consignor{name,address,country}`, `consignee{…}`, `carrier{name}`, `station_of_dispatch`, `station_of_destination`, `route_via`, `border_crossing`, `wagon_number`, `container_no`, `cargo{packages,weight_kg,description}`.
- Валидаторы: `date_range`.
- Keywords: `СМГС`, `накладн… СМГС`, `прямое международное железнодорожное сообщение`.
- Заметка: соглашение СМГС (СНГ, Китай и др.). Схема = `cim` + `border_crossing` (погранпереход).

#### `transport_invoice` — Транспортная накладная (форма 2013)
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `shipper{inn,kpp,name,ogrn,phone,address}`, `consignee{…}`, `carrier{…}`, `payer{inn,name,ogrn,phone}`, `forwarder{inn,name,ogrn,phone}`, `vehicle{model,plate,trailer_model,trailer_plate,weight_unladen}`, `driver{fio,phone,license}`, `loading_point{city,address,country}`, `unloading_point{…}`, `cargo_description`, `cargo_summary{places,volume_m3,weight_nett,weight_gross,dangerous_class}`, `conditions{temperature_min_c,temperature_max_c,humidity,special_marks}`, `declared_value`, `delivery_terms{pickup_datetime,delivery_datetime}`, `service_cost{amount,currency,vat_rate,vat_amount,amount_with_vat}`, `transport_docs`, `distance_km`, `items`.
- Валидаторы: `inn_checksum:shipper.inn`, `inn_checksum:consignee.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `Постановлен… Правительства РФ…272`, `приложение № 4 к Правилам перевозок грузов`, `условия перевозки…стоимость услуг перевозки` — ссылка на Пост. № 272 однозначно отличает от старой 1-Т.
- Заметка: F17 SLAI. Без товарного раздела — груз текстом в `cargo_description`. **Расхождение в БД:** display_name «Товарно-транспортная накладная (ТТН, 1-Т)» противоречит собственному description (форма 2013, заменила 1-Т) — имя перепутано с `TTN`, надо поправить.

#### `transport_request` — Заявка на перевозку
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `client{inn,kpp,name,phone,address}`, `carrier{…}`, `route{loading,unloading,intermediate_stops}` (loading/unloading — объект ИЛИ массив, multi-stop), `cargo{name,places,weight_t,volume_m3,temperature,customs_info,dangerous_class}`, `vehicle{vin,year,model,plate,capacity_t}`, `trailer{type,model,plate,volume_m3}`, `driver{fio,phone,license,passport}`, `rate{amount,currency,vat_rate,vat_included,payment_terms}`, `border_crossing`, `customs_post_entry`, `additional_terms`, `contact_responsible{fio,email,phone}`, `parent_contract_number`, `parent_contract_date`.
- Валидаторы: `inn_checksum:client.inn`, `inn_checksum:carrier.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `заявка (№|на перевозку|на транспортные услуги|на автоперевозку|на транспортно-экспедиционн…)`, `заявка-договор`.
- Заметка: F16 SLAI. Фиксирует договорённости ДО рейса; на открытом рынке `vehicle`/`driver` могут быть NULL (подбираются после акцепта). Для международных рейсов добавлены `border_crossing`/`customs_post_entry`.

#### `waybill` — Путевой лист
- Категория: транспортные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: false.
- Поля: `number`, `date`, `form`, `organization{inn,kpp,name,address}`, `vehicle{vin,type,model,plate,registration_certificate}`, `trailer{model,plate}`, `driver{fio,license,passport,tab_number}`, `route{purpose,departure_point,destination_point,intermediate_stops}`, `departure_time`, `return_time`, `odometer_start`, `odometer_end`, `distance_total`, `fuel{fuel_type,rate_per_100km,issued_volume,remaining_start,remaining_end,consumed_volume}`, `medical_check{passed,timestamp,doctor_signature}`, `technical_check{passed,timestamp,mechanic_signature}`, `cargo_description`, `cargo_weight`, `notes`.
- Валидаторы: `inn_checksum:organization.inn`, `date_range:date`, `vehicle_plate:vehicle.plate`.
- Keywords: `путевой лист`, `форма 4-С`, `форма 4-П`, `форма ПЛ-1`.
- Заметка: F18 SLAI. Товарной части нет — груз общим объёмом. На проде done-джобов пока 0.

### 🌍 ВЭД / таможня

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `bill_of_lading` | `bill_of_lading` | Коносамент (B/L) | llm_extract | beta | 335 | Самый частый тип на проде; схема — BL_SCHEMA в коде, в БД NULL |
| `commercial_invoice` | `commercial_invoice` | Инвойс (ВЭД, закупка товара) | llm_extract | beta | 51 | HS-коды, Incoterms; ≠ `invoice` (русский счёт, даже в валюте) |
| `customs_declaration` | `customs_declaration` | Таможенная декларация (ГТД) | llm_extract | beta | 259 | Форма 0014001; большие ДТ авто-уходят в multipass |
| `customs_export_ead` | `customs_export_ead` | Экспортная декларация ЕС (EAD / ЭСД) | llm_extract | beta | 0 | MRN-баркод; ≠ `export_declaration` и ≠ `excise_ead` |
| `excise_ead` | `excise_ead` | Акцизный e-AD | llm_extract | beta | 0 | ARC-код, алкоголь, Reg. 684/2009 |
| `export_declaration` | `export_declaration` | Экспортная декларация страны отправления | llm_extract | beta | 3 | Generic (вкл. китайскую 出口货物报关单); ЕС-вариант → `customs_export_ead` |
| `packing_list` | `packing_list` | Упаковочный лист (Packing List) | llm_extract | beta | 42 | Пара к `commercial_invoice`; без цен и без LOT |
| `price_list` | `price_list` | Прайс-лист | llm_extract | beta | 13 | Reference data, не платёжный |
| `proforma_invoice` | `proforma_invoice` | Проформа-инвойс (ВЭД) | llm_extract | beta | 102 | Предварительный, до отгрузки; плоская схема |
| `weighing_act` | `weighing_act` | Акт взвешивания | llm_extract | beta | 43 | Брутто/тара/нетто контейнера; expected_fields-пути не совпадают со схемой |
| `wire_transfer_application` | `wire_transfer_application` | Заявление на перевод (ВЭД) | llm_extract | beta | 41 | SWIFT/IBAN; ≠ `payment_order` |

#### `bill_of_lading` — Коносамент (B/L)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля (схема в коде — `EXTENDED_SCHEMAS['bill_of_lading']` = BL_SCHEMA, в БД `llm_schema=NULL`): `number`, `date`, `shipper{name,inn,kpp,ogrn,address,bank,bik,account,corr_account,phone}`, `consignee{…}`, `notify_party{…}`, `carrier`, `scac_code`, `vessel{name,voyage,imo}`, `port_of_loading`, `port_of_discharge`, `place_of_receipt`, `place_of_delivery`, `containers[]{number,seal,type,tare_kg,gross_weight_kg}`, `cargo{description,gross_weight_kg,volume_m3,packages_count,package_type}`, `freight_terms`, `incoterm`, `booking_number`, `shipped_on_board`, `service_name`, `place_of_issue`, `date_of_issue`, `number_of_original_bls`, `bl_type`, `master_bl_number`, `release_type`, `document_stage`, `transport_docs`, `order_refs`.
- Валидаторы: `country_code:shipper.country`, `country_code:consignee.country`, `date_range`.
- Keywords: `bill of lading`, `коносамент`, `B/L No.…`, `Master B/L`, `House B/L`.
- Заметка: самый частый тип на проде (335). Имена полей на выходе — `number`/`vessel` (диктует BL_SCHEMA), не `bl_number`/`vessel_name` из устаревшего `llm_prompt` в БД. В БД `is_builtin=true`, но в кодовую шестёрку builtin не входит — схема берётся из EXTENDED_SCHEMAS-fallback. `expected_fields` в БД пуст → `missing[]` всегда пустой, UI-счётчик «Поля» показывает 0 (сырая БД-колонка; модал «Что извлекаем» ходит через резолвер и поля видит). Контейнеры — ISO 6346; страны строго alpha-2.

#### `commercial_invoice` — Инвойс (ВЭД, закупка товара)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `number`, `date`, `currency`, `exporter{name,tax_id,address,country}`, `consignee{…}`, `buyer{inn,kpp,name,address}` (если отличается от consignee), `incoterms`, `payment_terms`, `items[]{line_no,code,name,qty,unit,price,hs_code,country_of_origin,weight_net,weight_gross,vat_rate,vat_amount,total_with_vat,total_without_vat,packages,qty_per_package,barcode,currency,notes}`, `containers[]{number}`, `contract_no`, `contract_date`, `specification_reference`, `document_stage` (draft/proforma/final), `total_amount`, `total`, `total_with_vat`, `total_weight_net`, `total_weight_gross`.
- Валидаторы: `country_code:exporter.country`, `country_code:consignee.country`, `money_sanity:total_amount`, `date_range`.
- Keywords: `commercial invoice`, `коммерческий инвойс`, `INVOICE No.…`, `Incoterms …`, `exporter…consignee`, `country of origin`.
- Заметка: дискриминатор — колонки цена/сумма (Unit price/Amount/Precio/Preis); если цен нет — это `packing_list` или `contract_specification`. НЕ путать с `invoice` (русский счёт на оплату остаётся `invoice`, даже когда он в валюте — например USD-фрахт). Страны строго ISO alpha-2 (`China`→`CN`), HS-коды 6–10 цифр, контейнеры ISO 6346.

#### `customs_declaration` — Таможенная декларация (ГТД)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `declaration_number` (XXXXXXXX/DDMMYY/XXXXXXX), `date`, `declaration_type` (ИМ40/ЭК10), `procedure_code`, `declarant{inn,kpp,name,address}`, `sender{inn,kpp,name,ogrn,address,country}`, `recipient{…}`, `seller{…}` (из ДТС-1, может отличаться от отправителя), `financial_settlement_person{inn,name,country}` (графа 9), `trading_country`, `origin_country`, `departure_country`, `destination_country`, `transport_mode`, `delivery_terms` (графа 20), `customs_post`, `release_date` (отметка «Выпуск разрешён»), `currency`, `exchange_rate`, `total_value`, `customs_value`, `total_duties`, `container_number`, `place_and_date`, `items[]{line_no,name,hs_code,country_of_origin,weight_net,weight_gross,qty,unit,price,invoice_value,customs_value,statistical_value,…}`, `duties[]{type,base,rate,amount,currency}`, `documents[]{code,date,number}` (графа 44), `preceding_documents[]{type,date,number}` (графа 40/44).
- Валидаторы: `inn_checksum:declarant.inn`, `inn_checksum:sender.inn`, `inn_checksum:recipient.inn`, `money_sanity:total_value`, `money_sanity:customs_value`, `date_range`.
- Keywords: `декларация на товары`, `ГТД`, `ДТ №\d{8}`, `грузовая таможенная декларация`, `ТД-?[ИЭ]К\d`.
- Заметка: форма 0014001, очень табличный. Виды платежей 1010 (сбор) / 2010 (пошлина) / 5010 (НДС). Многостраничные ДТ (текст > 15 КБ) автоматически уходят в multipass. `container_number` связывает ДТ с коносаментом и упаковочным листом.

#### `customs_export_ead` — Экспортная декларация ЕС (EAD / ЭСД)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `mrn` (Movement Reference Number, напр. 23HR030228018557B5), `issue_date`, `customs_office`, `office_of_exit`, `reference_number` (LRN), `consignor{name,vat_id,address,country}`, `consignee{name,address,country}`, `declarant{name,vat_id,address}`, `country_dispatch`, `country_destination`, `transport_identity{truck_plate,trailer_plate}`, `gross_mass`, `total_packages`, `currency`, `items[]{item_no,hs_code,description,packages,net_mass,gross_mass,customs_value,statistical_value}`.
- Валидаторы: `date_range`, `money_sanity`.
- Keywords: `export accompanying document`, `ausfuhrbegleitdokument`, `office of exit`, `MRN`, паттерн MRN `\d{2}[A-Z]{2}[A-Z0-9]{14}`.
- Заметка: дискриминатор — MRN-баркод декларации ЕС. НЕ ТТН, НЕ CMR, НЕ акцизный `excise_ead`; generic-декларации не-ЕС → `export_declaration`. Done-джобов на проде пока 0.

#### `excise_ead` — Акцизный e-AD
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `arc` (Administrative Reference Code), `issue_date`, `sender_excise_id`, `consignor{name,country,excise_id}`, `consignee{name,country,excise_id}`, `place_of_dispatch`, `place_of_delivery`, `items[]{name,kn_code,quantity,net_weight,gross_weight,alcohol_pct}`.
- Валидаторы: `date_range`, `weight_nett_le_gross`.
- Keywords: `akcīzes preces`, `684/2009`, `excise movement`, `ARC`.
- Заметка: электронный административный документ на подакцизные товары (алкоголь, Regulation 684/2009), лежит в каждом алкогольном комплекте. Ключевые сигналы — ARC-код и процент спирта (`alcohol_pct`). НЕ путать с `customs_export_ead`. Done-джобов на проде пока 0.

#### `export_declaration` — Экспортная декларация страны отправления
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `declaration_number`, `declaration_date`, `customs_office`, `exporter{code,name,address,country}`, `consignee{name,address,country}`, `country_of_origin`, `country_of_destination`, `transport_mode`, `delivery_terms`, `currency`, `total_value`, `total_net_weight`, `total_gross_weight`, `invoice_number`, `contract_number`, `items[]{description,hs_code,quantity,unit,unit_price,amount,net_weight,gross_weight,country_of_origin}`.
- Валидаторы: `date_range`, `money_sanity`, `weight_nett_le_gross`.
- Keywords: `export declaration`, `экспортн… деклараци…`, `customs export declaration`, `出口货物报关单`.
- Заметка: generic-декларация страны отправления (в т.ч. китайская 出口货物报关单). ЕС-вариант с MRN — отдельный тип `customs_export_ead`.

#### `packing_list` — Упаковочный лист (Packing List)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `number`, `date`, `exporter{name,address,country}`, `consignee{…}`, `invoice_number`, `contract_reference`, `items[]{name,qty,unit,packages,package_no,package_type,pallets,weight_net,weight_gross,weight_net_per_package,qty_per_package,volume,dimensions,hs_code,country_of_origin,…}`, `containers[]{number,packages,volume_m3,net_weight_kg,gross_weight_kg}`, `container_number`, `total_packages`, `total_pallets`, `total_weight_net`, `total_weight_gross`, `total_volume`, `weight_unit`, `volume_unit`, `marks_and_numbers`.
- Валидаторы: `weight_nett_le_gross`, `date_range`.
- Keywords: `packing list`, `упаковочный лист`, `packing specification`.
- Заметка: пара к `commercial_invoice` (связь через `invoice_number`). Дискриминаторы: есть вес нетто/брутто и места/паллеты, БЕЗ цен; если есть LOT/сроки годности — это `delivery_note`.

#### `price_list` — Прайс-лист
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля: `number`, `date`, `supplier_name`, `supplier_address`, `supplier_country`, `currency`, `incoterms`, `valid_from`, `valid_to`, `contract_ref`, `items[]{sku,name,description,brand,model,manufacturer,price,unit,min_qty,hs_code,country_of_origin}`.
- Валидаторы: нет.
- Keywords: `прайс-лист`, `price list`, `прейскурант`, `(артикул|sku)…(цена|price)`.
- Заметка: не платёжный документ — reference data для расчёта стоимости. Большие прайсы (текст > 15 КБ) авто-уходят в multipass. `expected_fields` используют nested-пути (`supplier.name`), а схема плоская (`supplier_name`) — `missing[]` по этим полям недостоверен.

#### `proforma_invoice` — Проформа-инвойс (ВЭД)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля (плоская схема): `number`, `date`, `seller_name`, `seller_address`, `seller_country`, `buyer_name`, `buyer_address`, `buyer_country`, `currency`, `total_amount`, `incoterms`, `payment_terms`, `items[]{description,hs_code,hs_description,qty,unit_price,line_total}`.
- Валидаторы: нет.
- Keywords: `proforma invoice`, `инвойс-проформа`, `предварительный инвойс`.
- Заметка: предварительный, до отгрузки (предоплата, согласование с банком); не фискальный, после отгрузки заменяется на `commercial_invoice`. 102 дока на проде — второй по частоте ВЭД-тип. `expected_fields` частично в nested-нотации (`seller.name`) при плоской схеме (`seller_name`) — `missing[]` по этим путям врёт.

#### `weighing_act` — Акт взвешивания
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля (плоская схема): `number`, `date`, `container_number`, `scales_id`, `weight_gross_kg`, `weight_tare_kg`, `weight_net_kg`, `declared_gross_kg`, `declared_net_kg`, `performer_fio`, `port_name`.
- Валидаторы: нет.
- Keywords: `акт взвешивания`, `вес груженого/порожнего контейнера`, `свидетельство о поверке`, `(брутто|нетто|тара)…кг`.
- Заметка: доказательство веса для таможни/страховщика; весы порта (ВМТП, ВСК, FESCO). Контейнер ISO 6346, все веса в кг. **Расхождение:** `expected_fields` в БД — nested-пути (`container.number`, `weight.gross_kg`), схема плоская (`container_number`, `weight_gross_kg`) — `missing[]` будет ложно помечать поля отсутствующими.

#### `wire_transfer_application` — Заявление на перевод (ВЭД)
- Категория: ВЭД/таможня. Парсер: `llm_extract`. Tier: beta. prefer_vision: false.
- Поля (плоская схема): `number`, `date`, `currency`, `amount`, `amount_words`, `sender_name`, `sender_inn`, `sender_account`, `beneficiary_name`, `beneficiary_address`, `beneficiary_country`, `beneficiary_iban`, `beneficiary_bank_name`, `beneficiary_bank_swift`, `purpose`, `contract_ref`, `invoice_ref`.
- Валидаторы: нет.
- Keywords: `заявление на перевод`, `application for remittance/transfer`, `SWIFT …`, `beneficiary customer`, `банк-посредник`.
- Заметка: трансграничный валютный перевод по контракту ВЭД (формы ВТБ № 284 / Сбербанк / Альфа); НЕ путать с российским `payment_order` (там нет SWIFT/IBAN). `expected_fields` в nested-нотации (`sender.name`, `beneficiary_bank.swift`) при плоской схеме — `missing[]` по ним недостоверен.

### 📦 Складские

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `delivery_note` | `delivery_note` | Расходная накладная (Delivery Note) | llm_extract | beta | 0 | LOT + сроки годности, без цен |
| `transfer_note` | `transfer_note` | Перемещение товаров (ТОРГ-13) | llm_extract | beta | 5 | Внутреннее, между складами |
| `material_requisition` | `material_requisition` | Требование-накладная (М-11) | llm_extract | experimental | 0 | Отпуск материалов со склада |
| `warehouse_receipt` | `warehouse_receipt` | Приём ТМЦ на хранение (МХ-1) | llm_extract | experimental | 1 | Поклажедатель → хранитель |
| `warehouse_return` | `warehouse_return` | Возврат ТМЦ с хранения (МХ-3) | llm_extract | experimental | 0 | Хранитель → поклажедатель |

#### `delivery_note` — Расходная накладная (Delivery Note)
- Категория: складские. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `supplier{name,inn}`, `consignee{name,inn}`, `items[]{name,lot,qty,unit,net_weight,best_before}`.
- **Валидаторы:** `date_range`.
- **Keywords:** `delivery note`, `расходная накладная`, `отгрузочная накладная`, `lieferschein`, `pavadzīme`.
- **Заметка:** позиции с LOT и сроками годности, **без цен**. Дискриминатор: от `packing_list` — есть LOT/`best_before`; от `waybill` — не транспортная накладная. Мультиязычная (DE `Lieferschein`, LV `pavadzīme`).

#### `transfer_note` — Перемещение товаров (ТОРГ-13)
- Категория: складские. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `organization_name`, `organization_inn`, `source_warehouse`, `target_warehouse`, `sender_name`, `receiver_name`, `responsible_fio`, `items[]{line_no,code,name,unit,qty,places,series,price,total}`, `total_lines`, `total_qty`.
- **Валидаторы:** нет.
- **Keywords:** `перемещение товаров`, `накладная на перемещение`, `ТОРГ-?13`, `отправитель…получатель…склад`, `(склад|места хранения)…(откуда|куда|источник|назначение)`.
- **Заметка:** внутреннее перемещение между складами организации (1С/SAP), не внешний оборот. 1С-формат «Накладная на перемещение № … от …» покрыт keywords (раньше требовалось слово «товаров» → падало в null, migration 0030).

#### `material_requisition` — Требование-накладная (М-11)
- Категория: складские. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `organization_name`, `warehouse` (склад-отправитель), `basis`, `sender{name,responsible_fio}`, `receiver{name,responsible_fio}` (структурные подразделения), `positions[]{code,name,unit,qty,price,total}`.
- **Валидаторы:** `date_range`.
- **Keywords** (plain-литералы, substring): `м-11`, `требование-накладная`, `требование`, `отпуск материалов`.
- **Заметка:** внутренний отпуск/перемещение материалов подразделению, не внешний оборот. Keyword `требование` очень широкий — возможны ложные срабатывания на письмах-требованиях.

#### `warehouse_receipt` — Приём-передача ТМЦ на хранение (МХ-1)
- Категория: складские. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `depositor{name,inn,kpp}`, `custodian{name,inn,kpp}`, `storage_place`, `storage_term`, `positions[]{code,name,unit,qty,price,total}`, `total`.
- **Валидаторы:** `date_range`.
- **Keywords** (plain-литералы, substring): `мх-1`, `акт о приёме-передаче`, `на хранение`, `поклажедатель`, `хранитель`.
- **Заметка:** форма МХ-1 — передача ТМЦ на ответственное хранение (поклажедатель → хранитель). Пара к МХ-3 (`warehouse_return`).

#### `warehouse_return` — Возврат ТМЦ с хранения (МХ-3)
- Категория: складские. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `depositor{name,inn,kpp}`, `custodian{name,inn,kpp}`, `base_doc_number`, `base_doc_date` (исходный МХ-1), `positions[]{code,name,unit,qty,price,total}`, `total`.
- **Валидаторы:** `date_range`.
- **Keywords** (plain-литералы, substring): `мх-3`, `акт о возврате`, `с хранения`, `возврат тмц`.
- **Заметка:** форма МХ-3 — возврат ранее принятых на хранение ТМЦ (хранитель → поклажедатель). Ссылка на исходный МХ-1 через `base_doc_number`/`base_doc_date`.

### 📜 Сертификаты / разрешительные

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `cert_of_origin` | `cert_of_origin` | Сертификат происхождения | llm_extract | beta | 0 | СТ-1 / Form A / Form E |
| `certificate_register` | `certificate_register` | Реестр сертификатов (прил. к инвойсу) | llm_extract | beta | 0 | Таблица сертификатов, не одиночный |
| `eac_conformity_certificate` | `eac_conformity_certificate` | Сертификат соответствия ЕАЭС | llm_extract | beta | 15 | ТР ТС / ТР ЕАЭС, EAC |
| `quality_certificate` | `quality_certificate` | Сертификат / паспорт качества (COA) | llm_extract | beta | 10 | Одиночный COA / Mill Test |
| `safety_data_sheet` | `safety_data_sheet` | Паспорт безопасности (SDS / MSDS) | llm_extract | beta | 16 | 16-секционный GHS |
| `transport_permit` | `transport_permit` | Дозвол / разовое разрешение | llm_extract | beta | 0 | Международная автоперевозка |
| `phytosanitary_certificate` | `phytosanitary_certificate` | Фитосанитарный сертификат | llm_extract | experimental | 0 | Карантин растений |
| `special_permit` | `special_permit` | Спецразрешение (негабарит/тяжеловес) | llm_extract | experimental | 0 | Росавтодор |
| `veterinary_certificate` | `veterinary_certificate` | Ветеринарный сертификат | llm_extract | experimental | 0 | Продукция животного происхождения |

#### `cert_of_origin` — Сертификат происхождения
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `issue_date`, `form_type` (CT-1 / Form A / Form E), `exporter_name`, `exporter_country`, `consignee_name`, `consignee_country`, `product_description`, `hs_code` (10-значный ТН ВЭД), `origin_country`, `invoice_ref`. Страны — ISO 3166 alpha-2.
- **Валидаторы:** нет.
- **Keywords:** `сертификат происхождения`, `certificate of origin`, `form (CT-1|СТ-1|A|E)`, `country of origin`.
- **Заметка:** про **страну происхождения** (тарифные льготы), не путать с `eac_conformity_certificate` (тот про техн. соответствие). Внимание: `expected_fields` в БД остались nested (`exporter.name`, `product.hs_code`…), а llm_schema плоская (`exporter_name`, `hs_code`) — пути в `missing[]` не совпадают с фактическими ключами извлечения.

#### `certificate_register` — Реестр сертификатов (приложение к инвойсу)
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `invoice_ref`, `issue_date`, `items[]{cert_number,product,holder,issuing_body,issue_date,expiry_date}`.
- **Валидаторы:** нет.
- **Keywords:** `реестр…сертификат`, `annex to invoice`, `сертификат соответствия еаэс`, `список сертификатов`, `перечень сертификатов`.
- **Заметка:** приложение к инвойсу — **таблица** (реестр) сертификатов соответствия ЕАЭС, много строк. НЕ одиночный сертификат (`quality_certificate` / `eac_conformity_certificate`). Keyword «сертификат соответствия еаэс» пересекается с `eac_conformity_certificate` — дискриминатор именно табличность/реестр.

#### `eac_conformity_certificate` — Сертификат соответствия ЕАЭС
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `doc_kind` (certificate / declaration), `issue_date`, `expiry_date`, `applicant_name`, `applicant_inn`, `applicant_address`, `manufacturer_name`, `manufacturer_country`, `product_description`, `tn_ved_code`, `tech_regulation` (напр. ТР ТС 010/2011), `certification_body`.
- **Валидаторы:** нет.
- **Keywords:** `сертификат соответствия`, `N RU (Д-XX|С-XX)…`, `технически[йе] регламент`, `ТР ТС`, `ТР ЕАЭС`, `EAC conformity`.
- **Заметка:** про **техническое соответствие** (ТР ТС / ТР ЕАЭС), не происхождение. `doc_kind` отличает сертификат от декларации о соответствии. Формат номера `N RU Д-CN.РА01.В.54075/24`. Как и у `cert_of_origin`: `expected_fields` в БД nested (`manufacturer.name`, `product.tn_ved_code`…), схема плоская — `missing[]` рассинхронизирован с ключами извлечения.

#### `quality_certificate` — Сертификат / паспорт качества (Certificate of Analysis)
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `certificate_number`, `issue_date`, `product_name`, `manufacturer{name,country}`, `batch_number`, `lot_number`, `production_date`, `expiry_date`, `standard` (ГОСТ/ТУ/ISO/ASTM), `quantity`, `weight`, `parameters[]{name,unit,norm,actual_value,method}`, `conclusion`, `invoice_number`, `contract_number`, `signed_by`.
- **Валидаторы:** `date_range`.
- **Keywords:** `^сертификат качества`, `^паспорт качества`, `certificate of (quality|analysis)`, `mill test certificate`, `COA`.
- **Заметка:** **одиночный** сертификат/паспорт качества (COA / Mill Test Certificate): строки параметров с нормой, фактом и методом испытания. Таблица многих сертификатов → `certificate_register`.

#### `safety_data_sheet` — Паспорт безопасности (SDS / MSDS)
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `product_name`, `article_number`, `version`, `revision_date`, `manufacturer{name,address,country,contact}`, `cas_number`, `un_number`, `hazard_class` (GHS/CLP, Section 2), `composition[]{name,cas,percent}` (Section 3), `sections[]{number,title}` (1..16).
- **Валидаторы:** `date_range`.
- **Keywords:** `паспорт безопасности`, `safety data sheet`, `SDS`, `MSDS`, `material safety data sheet`.
- **Заметка:** 16-секционный формат GHS / EC 1272/2008. Документ длинный (десятки страниц) — регулярно уходит в авто-multipass (текст > 15 КБ). Извлекаем каркас (секции, состав, идентификация), не пересказываем содержимое секций.

#### `transport_permit` — Дозвол / разовое разрешение на перевозку
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `country` (страна действия, ISO alpha-2), `issued_by`, `permit_type` (разовое / многократное / транзит), `valid_from`, `valid_to`, `truck_plate`, `trailer_plate`.
- **Валидаторы:** `date_range`.
- **Keywords:** `дозвол`, `разово… разрешени`, `engedély`, `special single-trip`, `single trip permit`, `разрешение на международн`.
- **Заметка:** разрешение на **международную автоперевозку** (дозвол, венгерский Engedély и т.п.). НЕ спецразрешение на негабарит — это `special_permit`.

#### `phytosanitary_certificate` — Фитосанитарный сертификат
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `exporter{name,address}`, `consignee{name,address}`, `product_description`, `botanical_name`, `quantity`, `country_of_origin`, `country_of_destination`, `point_of_entry`, `treatment{type,chemical,date}` (обеззараживание), `issuing_organization` (НОКЗР).
- **Валидаторы:** `date_range`.
- **Keywords:** `фитосанитарн`, `phytosanitary`, `фитосертификат`, `карантин… растен`.
- **Заметка:** продукция растительного происхождения (карантин растений). Смысловая пара к `veterinary_certificate` (животное происхождение).

#### `special_permit` — Спецразрешение на перевозку (крупногабарит/тяжеловес)
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `valid_from`, `valid_until`, `issued_by` (Росавтодор и т.п.), `permit_kind` (крупногабаритный / тяжеловесный / оба), `carrier{name,inn}`, `vehicle{model,plate,trailer_plate}`, `route{from,to,description}`, `dimensions{length_m,width_m,height_m,weight_t,axle_load_t}`, `cargo{description}`.
- **Валидаторы:** `date_range`.
- **Keywords:** `специальн… разрешени`, `спецразрешени`, `росавтодор`, `крупногабаритн`, `тяжеловесн`.
- **Заметка:** движение крупногабаритного/тяжеловесного ТС по конкретному маршруту. НЕ дозвол на международную перевозку — это `transport_permit`.

#### `veterinary_certificate` — Ветеринарный сертификат
- Категория: сертификаты/разрешительные. Парсер: `llm_extract`. Tier: experimental. prefer_vision: нет. Scope: global.
- **Поля:** `number`, `date`, `exporter{name,address}`, `consignee{name,address}`, `product`, `quantity`, `country_of_origin`, `country_of_destination`, `transport`, `issuing_authority` (госветслужба), `veterinary_requirements`.
- **Валидаторы:** `date_range`.
- **Keywords:** `ветеринарн… (сертификат|свидетельств|сопроводительн)`, `veterinary certificate`, `ветсертификат`.
- **Заметка:** сопроводительный документ на продукцию животного происхождения.

### 🗂️ Прочие

| Internal | Outbound | Название | Парсер | Tier | Док-ов в проде | Заметка |
|---|---|---|---|---|---|---|
| `document_request` | `document_request` | Запрос документов | llm_extract | beta | 5 | Письмо-запрос, не сам документ |
| `driver_passport` | `driver_passport` | Паспорт водителя (ID) | llm_extract | beta | 1 | ПДн-режим: только факт наличия |
| `insurance_policy` | `insurance_policy` | Страховой полис (груз) | llm_extract | beta | 20 | Страховщик / сумма / премия |
| `vehicle_registration` | `vehicle_registration` | Свидетельство о регистрации ТС (СТС) | llm_extract | beta | 0 | СТС + допуск TIR |

#### `document_request` — Запрос документов
- Категория: прочие. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `subject`, `requester`, `recipient`, `requested_documents[]` (список строк), `deadline`, `order_ref` (заказ / сделка / контейнер).
- **Валидаторы:** нет.
- **Keywords:** `запрос документ`, `просим предоставить`, `просим направить`, `предоставить следующие`, `запрос на предоставление`, `request for document`.
- **Заметка:** короткое письмо-обращение с перечнем запрашиваемых документов. НЕ сам документ из перечня — классификатор не должен уводить в тип упомянутого документа.

#### `driver_passport` — Паспорт водителя (ID)
- Категория: прочие. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `doc_kind` (всегда `"id"`), `country` (страна выдачи, ISO alpha-2), `present` (факт наличия). Всё.
- **Валидаторы:** нет.
- **Keywords:** `p<[a-z]{3}` (MRZ), `passport`, `пашпарт`, `рэспублiка бела`, `identity card`.
- **Заметка:** **ПДн ВЫСОКИЙ** — extract намеренно сведён к факту наличия: ФИО, номер, MRZ, дата рождения НЕ извлекаются и не сохраняются (§8 allowlist). Тип существует для сегментации композитов и детекта ПДн-страниц в комплекте. Не расширять схему без пересмотра ПДн-режима.

#### `insurance_policy` — Страховой полис (страхование груза)
- Категория: прочие. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `policy_number`, `issue_date`, `valid_from`, `valid_until`, `insurer{name,inn}`, `insured{name,inn}`, `beneficiary`, `sum_insured`, `premium`, `currency`, `coverage` («с ответственностью за все риски» и т.п.), `franchise`, `cargo{description,packages,weight_kg}`, `route{from,to,mode}`, `incoterms`, `transport_ref` (инвойс / коносамент / ТН).
- **Валидаторы:** `inn_checksum`, `date_range`, `money_sanity` — заданы без `:path`-аргументов, в отличие от остальных типов.
- **Keywords:** `^страховой полис`, `полис страхования`, `страховани… груз`, `insurance policy`, `cargo insurance`.
- **Заметка:** самый частый тип категории (20 док-ов в проде). `transport_ref` связывает полис с транспортным документом партии.

#### `vehicle_registration` — Свидетельство о регистрации ТС (СТС)
- Категория: прочие. Парсер: `llm_extract`. Tier: beta. prefer_vision: нет. Scope: global.
- **Поля:** `reg_number`, `vin`, `make` (марка/модель), `category`, `country` (ISO alpha-2), `first_registration_date`, `valid_until`, `holder{name}`, `tir_certificate_number`.
- **Валидаторы:** нет.
- **Keywords:** `свидетельство о регистрации`, `технический талон`, `registracijos liudijimas`, `transpordiamet`, `certificat d'immatriculation`, `TIR`, `carnet tir`, `certificate of approval`.
- **Заметка:** СТС / техталон, мультиязычный (LT/EE/FR формы). Сюда же — сертификат допущения TIR (`tir_certificate_number`). `holder` может быть физлицом (ПДн — редактируется). НЕ грузовой и НЕ товарный документ.

## Известные несоответствия БД

Что расходилось между прежней версией дока / данными БД и фактическим состоянием на 2026-07-21:

- **Датировка дока.** Прежнее «Обновлено: 2026-05-20» не отражало текущий прод: в БД 52 активных
  типа, док описывал 30. Настоящая версия — полная сверка.
- **Счётчик Registry.** «Всего в Registry: 30 (6 builtin typed + 24 custom)» устарел: в БД 52
  активных типа; `is_builtin=true` у 18 (к исходной шестёрке добавлены `bill_of_lading`,
  `cash_receipt`, `commercial_invoice`, `contract`, `contract_addendum`, `contract_specification`,
  `customs_declaration`, `packing_list`, `payment_order`, `transport_invoice`,
  `transport_request`, `waybill`), custom — 34.
- **Tier-распределение.** Прежнее «stable 6, beta 16, experimental 8» устарело: фактически
  stable 6 / beta 30 / experimental 16.
- **`bill_of_lading` / `CMR` / `TTN`: пустые `expected_fields` в БД.** UI-счётчик показывает
  «0 полей», хотя боевая схема в коде работает (BL_SCHEMA / builtin-схемы через фолбэк
  резолвера) и извлечение полноценное; `missing[]` у этих типов всегда пустой. Кроме того,
  `llm_prompt` коносамента в БД устарел (описывает `bl_number`/`vessel_name`, реальные ключи —
  `number`/`vessel` из BL_SCHEMA).
