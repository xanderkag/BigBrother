# Досье. Позиции счёта: parsdocs ↔ SLAI

> **Назначение документа.** Сводка с двух сторон по тому, какие поля
> извлекаются из позиций (`items[]`) накладных, счетов и фрахт-документов,
> и что нужно SLAI как заказчику. Документ — **сырьё для отдельного
> агента-аналитика**, который должен сделать gap-анализ и рекомендации
> (раздел § 6).
>
> Никаких выводов и рекомендаций в этом файле нет — только факты
> со ссылками на код и оригинальные документы.
>
> **Версия:** v0.1, 2026-06-03.
> **Источники:**
> - parsdocs side: `doc-service/src/types/document-json-schemas.ts`,
>   `inference-service/src/inference_service/prompts/extract.py`,
>   `docs/MODEL_REPORT.md` (прогоны #21–#28).
> - SLAI side: `doc-service/docs/SLAI_TZ_v1_2026-05-17.md`,
>   `doc-service/docs/PARSDOCS_REPLY_TO_SLAI_TZ.md`,
>   `doc-service/docs/PARSDOCS_REPLY_SLAI_EOD_2026-05-18.md`,
>   `doc-service/docs/INTEGRATION_QUEUE.md`.

---

## 1. Контекст

parsdocs принимает скан/PDF документа → возвращает структурированный JSON
с распознанными полями. SLAI потребляет результат, привязывает к сущностям
ERP (Transportation/Transfer). Часть полей у SLAI — критичные для matcher'а
(ИНН сторон, госномер ТС, номер контейнера, номер заявки).

Главный вопрос, ради которого собирается это досье:
**достаточно ли глубока наша схема `items[]` и наш prompt, чтобы покрыть
реальные потребности SLAI по позициям (фрахт-счета с несколькими рейсами,
контейнерные перевозки, мультистоп)?**

---

## 2. Сторона A — parsdocs (что есть сейчас в коде)

### 2.1. Поддержанные типы документов

`doc-service/src/types/document-json-schemas.ts:682-721`:

```ts
DOCUMENT_JSON_SCHEMAS = {
  invoice: INVOICE_SCHEMA,
  factInvoice: INVOICE_SCHEMA,       // структурно равен invoice + vat_summary
  UPD: INVOICE_SCHEMA,
  TTN: TTN_SCHEMA,
  CMR: CMR_SCHEMA,
  AKT: AKT_SCHEMA,
}

EXTENDED_SCHEMAS = {                   // через document_types в БД
  waybill: WAYBILL_SCHEMA,
  transport_invoice: TRANSPORT_INVOICE_SCHEMA,
  transport_request: TRANSPORT_REQUEST_SCHEMA,
}
```

EXPECTED_FIELDS на верхнем уровне:

| Тип | Поля шапки + items |
| --- | --- |
| `invoice` | number, date, seller, buyer, total, items |
| `factInvoice` | + vat, vat_summary |
| `UPD` | + vat |
| `TTN` | number, date, shipper, consignee, cargo, vehicle, items |
| `CMR` | number, date, sender, recipient, carrier, items |
| `AKT` | number, date, party_a, party_b, total, items |

### 2.2. Схема позиции (`ITEM_PROPERTIES`)

`doc-service/src/types/document-json-schemas.ts`, 26 полей одной строки `items[]`:

| Группа | Поле | Тип | Описание (как видит модель в prompt) |
| --- | --- | --- | --- |
| Идентификация | `line_no` | integer | Порядковый номер строки |
| | `code` | string | Внутренний артикул / код товара |
| | `barcode` | string | Штрих-код (EAN-13, UPC, GTIN) |
| | `name` | string | Наименование товара/услуги |
| ВЭД | `hs_code` | string | Код ТН ВЭД (10 цифр РФ/ЕАЭС, 8 цифр ЕС). Только для импорта/таможни |
| | `country_of_origin` | string | ISO 3166-1 alpha-2 |
| Меры | `unit` | string | Ед. изм. (шт, кг, м, л, упак, …) |
| | `qty` | number | Количество |
| | `qty_per_package` | number | Кол-во единиц в упаковке |
| | `packages` | number | Кол-во упаковок/мест |
| | `weight_net` | number | Вес нетто, кг |
| | `weight_gross` | number | Вес брутто, кг |
| Цена | `price` | number | Цена за единицу без НДС |
| | `vat_rate` | number | Ставка НДС строки (0, 10, 20) |
| | `vat_amount` | number | Сумма НДС по строке |
| | `total_without_vat` | number | Стоимость без НДС |
| | `total_with_vat` | number | Стоимость с НДС |
| | `currency` | string | ISO 4217 (RUB, USD, EUR, CNY) |
| Транспорт (per-line, фрахт-счета SLAI 2026-05-20) | `vehicle_plate` | string | Госномер ТС рейса. «А123ВС797», парсить из `name` после «Госномер:» / «а/м» |
| | `order_ref` | string | Номер заказа/заявки. Парсить из `name` после «Заказ:»/«Заявка:» |
| | `route_from` | string | Из «Маршрут: A → B» — это A |
| | `route_to` | string | Из «Маршрут: A → B» — это B |
| | `trip_date` | string | Дата рейса (ISO YYYY-MM-DD) |
| Прочее | `notes` | string | Произвольные комментарии |

### 2.3. Схема контрагента (`PARTY`)

`doc-service/src/types/document-json-schemas.ts`:

| Поле | Описание |
| --- | --- |
| `name` | Наименование |
| `inn` | 10/12 цифр |
| `kpp` | 9 символов NNNNCCNNN |
| `address` | — |
| `bank` | Наименование банка |
| `bik` | БИК (9 цифр) |
| `account` | Расчётный счёт (20 цифр) |
| `corr_account` | Корр-счёт банка (20 цифр) |
| `phone` | +7XXXXXXXXXX |

(Банковские реквизиты добавлены F19 «банковские реквизиты для invoice / payment_order».)

### 2.4. Промпт, который улетает в LLM

`inference-service/src/inference_service/prompts/extract.py`. Два варианта
(`build` и `build_cacheable` для Anthropic prompt caching). Структурно
одно и то же: **system-блок** (статика) + **user-блок** (текст документа).

В system-блоке модели даётся:
1. Описание 13 типов российских деловых документов (invoice, УПД, ТТН,
   CMR, акт, ПП, СФ, **commercial_invoice, packing_list, bill_of_lading,
   customs_declaration**, кассовый чек, договор). См. `extract.py:147-225`.
2. Целевая JSON-схема выбранного типа (буквально `json.dumps(schema)`).
3. Жёсткое правило: «**используй только эти поля, лишних не добавляй**».
4. Правила нормализации (числа без пробелов, даты YYYY-MM-DD, ИНН формат,
   роли seller/buyer, **«Госномер ТС — кириллица в верхнем регистре,
   без пробелов (А123ВВ77)»**).
5. Один few-shot example (УПД).

Релевантные цитаты из текущего prompt (`extract.py`):

— `extract.py:215-216` про коносамент:
> 10. Коносамент B/L (bill_of_lading) — для морских перевозок. Поля:
>     vessel, voyage, **контейнер (ISO-6346 формат ABCD1234567)**.

— `extract.py:232` единственное упоминание госномера:
> Госномер ТС — кириллица в верхнем регистре, без пробелов (А123ВВ77)

— `extract.py:171-183` про invoice банковские реквизиты:
> ВАЖНО для invoice — извлекать банковские реквизиты поставщика:
>   seller.bank / seller.bik / seller.account / seller.corr_account / seller.phone
> Эти поля критичны для SLAI matcher'а — он сверяет «тот ли поставщик»
> не только по ИНН но и по расч.счёту.

Цитата про per-field confidence (`extract.py:28-49`):
> Минимальный набор путей которые ОБЯЗАТЕЛЬНО присутствуют в field_confidence:
>   "number", "date", "seller.inn", "buyer.inn", "total_with_vat"
> Плюс по возможности: "seller.name", "buyer.name", "vehicle.plate",
> "items[*].name" (общая уверенность по всем строкам).

### 2.5. Замеренное качество (по golden-set, `docs/MODEL_REPORT.md`)

Прогон #28 (qwen2.5vl 7b vs 32b, 6 PDF реального golden-set, 40
field-ассертов):

| Метрика | 7b | 32b | Гейт SLAI |
| --- | --- | --- | --- |
| Exact-match | 0.850 | 0.900 | ≥ 0.85 |
| Critical-field (ИНН/total/number/date) | 0.923 | 0.962 | ≥ 0.95 |
| Classification | 0.667 | 1.000 | ≥ 0.95 |
| Items F1 | ~0.80 | ~0.80 | ≥ 0.80 |
| Hallucination ИНН | 0 | 0 | — |
| Latency P50 | 21 с | 202 с | ≤ 90 с (MVP) |

Известные просадки на позициях:
- `total` (итог документа) — недо-чтение на многострочных счетах
  (7b: 11890/0 vs ожид. 12000+; 32b: 10542/189). Это шапка, но
  считается из items.
- Гомоглифы в `name` (4мм↔4mm, MT115↔МТ115).
- `quantity` (path-артефакт скоринга: значение в `items[0].qty` есть,
  харнесс не маппит).

Узких мест по полям рейса (`vehicle_plate`, `route_from`, `route_to`,
`order_ref`, `trip_date`) в #28 не замерено отдельно — на golden-set v1
нет фрахт-счетов с этими атрибутами в строке.

---

## 3. Сторона B — SLAI (что просит ТЗ)

Источник: `doc-service/docs/SLAI_TZ_v1_2026-05-17.md` (ТЗ v1, доставлено
2026-05-17, статус «получено, на проработку»).

### 3.1. Поддерживаемые типы документов (SLAI Фаза 1, 10 типов)

| # | Тип | Slug у SLAI | Slug у нас | Совпадает? |
| --- | --- | --- | --- | --- |
| 1 | Счёт на оплату | `invoice` | `invoice` | ✅ |
| 2 | Заявка на перевозку | `transport_request` | — | ❌ (F16) |
| 3 | ТТН | `ttn` | `TTN` | нейминг (F22) |
| 4 | Транспортная накладная (2013) | `transport_invoice` | — | ❌ (F17) |
| 5 | CMR | `cmr` | `CMR` | нейминг (F22) |
| 6 | Путевой лист | `waybill` | — | ❌ (F18) |
| 7 | УПД | `upd` | `UPD` | нейминг (F22) |
| 8 | Акт услуг | `services_act` | `AKT` | нейминг (F22) |
| 9 | Счёт-фактура | `tax_invoice` | `factInvoice` | нейминг (F22) |
| 10 | Платёжное поручение | `payment_order` | `payment_order` | ✅ |

Фаза 2 — 8 типов ВЭД (commercial_invoice, packing_list, bill_of_lading,
ГТД и др.).

### 3.2. Контракт webhook-ответа (раздел 1 их ТЗ)

```json
{
  "version": "v1",
  "job_id": "uuid",
  "status": "done | needs_review | failed",
  "document_type": "invoice",
  "confidence": 0.94,
  "extracted": { /* зависит от типа */ },
  "_normalized_fields": {
    "seller.inn": "7707083893",
    "buyer.inn":  "5024079777",
    "vehicle.plate": "А123АА777"
  },
  "_field_confidence": {
    "seller.inn": 0.99,
    "seller.name": 0.94,
    "items[0].name": 0.71
  },
  "target_entity_hint": "Transportation | Transfer | null",
  "metadata": { "echo": "of POST /jobs metadata" },
  "needs_review": false,
  "raw_text_preview": "first 500 chars of OCR for debugging"
}
```

Полей `extracted` SLAI ТЗ v1 буквально не перечисляет — отсылка к
acceptance критериям (§ 3.4 ниже).

### 3.3. Acceptance критерии (раздел «Acceptance критерии (резюме)»
из их ТЗ)

**Invoice:**
- `seller.inn`, `buyer.inn`, `document_number`, `total_with_vat` → **≥ 95 %**
- `items[*]`, банковские реквизиты → ≥ 80 %

**Transport request:**
- `client.inn`, `carrier.inn`, route addresses → ≥ 90 %
- `vehicle.plate` нормализован → ≥ 95 %
- даты в ISO → ≥ 85 %

**TTN:**
- shipper / consignee / carrier ИНН, `vehicle.plate` → ≥ 95 %
- `total_weight_kg` ±1 кг → ≥ 95 %
- `driver.fio`, route → ≥ 90 %

Общий гейт confidence:
- `≥ 0.85` → auto-предложить привязку
- `0.60–0.84` → пометить «требует проверки»
- `< 0.60` → `status='needs_review'`

### 3.4. SLA

| Параметр | MVP | Прод |
| --- | --- | --- |
| Время / doc | ≤ 90 с | ≤ 30 с |
| Throughput | 5 doc/min | 60 doc/min |
| Размер PDF | до 20 MB | до 50 MB |
| Страниц | до 10 | до 30 |
| Формат | PDF/JPG/PNG | + TIFF/HEIC |
| Availability | 95 % | 99.5 % |

### 3.5. 8 open questions SLAI (раздел 4 ТЗ) и статус ответа parsdocs

| # | Вопрос | Статус ответа |
| --- | --- | --- |
| Q1 | Multi-document PDF (счёт+УПД+СФ в одном) | F5 в roadmap, 14 дней. Workaround: SLAI делит на стороне |
| Q2 | Версионирование контракта | Принято: add field = v1, rename = v2, double-support 1 мес, v1 живёт ≥ 6 мес |
| Q3 | `POST /jobs/:id/retry` с другим промптом | Есть `reprocess` + `redeliver-webhook`. One-shot prompt override — F20 если попросят |
| Q4 | OCR-only `raw_ocr` режим | Есть `parser_kind: passthrough`, endpoint `/raw-text` — F21 |
| Q5 | Языки (кириллица + латиница + китайский для AliExpress) | rus+eng в Tesseract, китайский F23 (1 час) |
| Q6 | Rate limit per token | 200/min default, для SLAI предложено 600/min |
| Q7 | Длинные обработки — polling или webhook | Webhook прилетит когда готов независимо от длительности |
| Q8 | Storage retention при `redact_pii` | 30 дней default, `delete_after_processing` — F27 если попросят |

### 3.6. EOD-issues от SLAI (2026-05-17, разобраны в
`PARSDOCS_REPLY_SLAI_EOD_2026-05-18.md`)

| # | Issue | Резолюция |
| --- | --- | --- |
| 1 | `payment_order` определялся на 1С-счёте | Исправлен classifier |
| 2 | `transport_request` не матчит «ЗАЯВКА-ДОГОВОР» | Расширены keywords |
| 3 | UPPERCASE `document_type` в webhook | Lower-case в API |
| 4 | webhook body без `version` поля | Добавлен |
| 5 | HMAC header name (`X-Signature` vs `X-Signature-256`) | Договорились |
| 6 | LLM fallback не триггерится | ⏸ открыт |

---

## 4. Раскладка по позициям счёта — таблица для gap-анализа

Слева — что SLAI matcher'у нужно для привязки строки рейса к
Transportation/Transfer (выведено из их ТЗ и acceptance). Справа —
что у нас есть в `ITEM_PROPERTIES` и упоминается в prompt.

| Кейс / поле строки | Нужно SLAI | Есть в schema | Есть в prompt | Замерено качество |
| --- | --- | --- | --- | --- |
| Госномер ТС (А123ВС797) | Да (gate ≥ 95 % normalized) | ✅ `vehicle_plate` | ✅ правило «кириллица uppercase, без пробелов» (`extract.py:232`) | ⚠ не замерено per-line на real-set |
| Номер заказа / заявки | Да (привязка к Transportation) | ✅ `order_ref` | ⚠ только в описании поля схемы, отдельной инструкции в шапке нет | ⚠ не замерено |
| Маршрут (откуда → куда) | Да (route addresses ≥ 90 %) | ✅ `route_from` + `route_to` | ⚠ только в описании поля схемы | ⚠ не замерено |
| Дата рейса | Да | ✅ `trip_date` | ⚠ только в описании поля схемы | ⚠ не замерено |
| **Номер контейнера** (ISO-6346, ABCD1234567) | Предположительно да (морские/мультимодальные перевозки, Фаза 2 ВЭД) | ❌ **отсутствует в `ITEM_PROPERTIES`** | ⚠ упомянут **только для `bill_of_lading`** (`extract.py:215-216`), `bill_of_lading` нет в `DOCUMENT_JSON_SCHEMAS` | — (нет ни схемы, ни замеров) |
| **Номер пломбы (seal)** | Сопровождает контейнер | ❌ отсутствует | ❌ не упомянут | — |
| Номер прицепа на строке | Да на фрахт-счёте (каждая строка — свой рейс) | ❌ (есть только в `TTN.vehicle.trailer_plate` — шапка ТТН, не строка) | ❌ не упомянут per-line | — |
| **ФИО водителя на строке** | TTN: gate ≥ 90 %. Для фрахт-счёта тоже релевантно | ❌ (есть только в `TTN.vehicle.driver`, шапка) | ❌ per-line не упомянут | — |
| **Booking ref / номер B/L** | Связь рейса с морским коносаментом | ❌ | ❌ | — |
| Номер связанной ТТН / CMR | Связь рейса с конкретной накладной | ❌ | ❌ | — |
| Объём (м³) на строку | Релевантно для LTL/контейнерной | ❌ (есть `weight_net`/`weight_gross`) | ❌ | — |
| Артикул / barcode / HS-code | Стандартный товарный счёт | ✅ | ✅ (в шапке промпта типы документов) | — |
| Цена / vat_rate / vat_amount / total | Acceptance items ≥ 80 % | ✅ | ✅ | F1 ≈ 0.80 (#28) |
| `currency` на строку | Если строка в другой валюте | ✅ | ⚠ только в описании поля схемы | — |

### 4.1. Замечание о механике «потери» поля

В promp'е (`extract.py`) есть жёсткое правило:
> используй только эти поля, лишних не добавляй

Это означает: если модель **видит** в документе номер контейнера или
пломбы, но в переданной ей `schema` (`json.dumps(ITEM_PROPERTIES)`) нет
соответствующего ключа, она:
1. либо втиснет его в `name` строки (мусор для matcher'а),
2. либо положит в `notes`,
3. либо просто отбросит.

Других путей нет. То есть пробел в схеме = реальная потеря данных,
а не «модель не справилась».

---

## 5. Открытые вопросы (для следующих итераций)

### 5.1. К SLAI — не подтверждены

1. Какие именно поля рейса нужны matcher'у на уровне строки фрахт-счёта?
   Текущая инвентаризация в `ITEM_PROPERTIES` (`vehicle_plate`, `order_ref`,
   `route_from`, `route_to`, `trip_date`) — это **наша гипотеза по ТЗ
   2026-05-20**, не подтверждённая отдельным ответом SLAI. ТЗ v1 в § 3.4
   acceptance даёт критерии только на шапочный уровень (transport_request:
   `vehicle.plate`, route addresses).
2. Контейнерные перевозки — будут ли в Фазе 1 или только Фаза 2 ВЭД?
   Если Фаза 1 — нужен `container_no` в `items` уже сейчас.
3. Какой минимальный набор полей per-line для acceptance строки фрахт-счёта?
4. Нужны ли поля driver/trailer/seal **на уровне строки** или достаточно
   шапочных в TTN/CMR?
5. Формат номера контейнера — только ISO-6346 (ABCD1234567) или принимаются
   и внутренние номера без чек-цифры?

### 5.2. К parsdocs (внутренние)

1. Если расширяем `ITEM_PROPERTIES` — нужны ли соответствующие нормализаторы
   в `pipeline/normalize/` (валидация ISO-6346 чек-цифры контейнера, формат
   пломбы)?
2. Нужно ли расширить `field_confidence` обязательный набор
   (`extract.py:33-39`) полями уровня строки?
3. Где хранить golden-фикстуру фрахт-счёта с контейнерами? `eval/real/`?
4. Что делать с уже извлечёнными счетами в БД, если меняем схему?
   (Backfill не нужен — старые поля = `null`, миграция не требуется
   потому что `extracted` хранится как JSONB.)

---

## 6. Задание для агента-аналитика

Этот документ — сырьё. Агент-аналитик, получив его, должен выдать:

1. **Gap-матрицу** позиций счёта по формату § 4, дополненную:
   - конкретными slug'ами новых полей (`container_no`, `seal_no`,
     `trailer_plate`, `driver`, `volume_m3`, `booking_ref`, `waybill_ref`);
   - оценкой приоритета (high / medium / low) исходя из:
     (a) acceptance-критериев SLAI ТЗ (§ 3.3),
     (b) текущего покрытия schema (§ 2.2),
     (c) механики потери данных (§ 4.1).

2. **Дельту по prompt'у** (`extract.py`):
   - какие правила нормализации добавить (ISO-6346 для контейнера и т.д.);
   - какие типы документов из перечня SLAI Фазы 2 (commercial_invoice,
     packing_list, bill_of_lading) добавить в `DOCUMENT_JSON_SCHEMAS`,
     потому что сейчас они есть только в описательной части prompt'а
     без целевой схемы.

3. **Список вопросов к SLAI** в формат `INTEGRATION_QUEUE.md` — какой
   минимум подтверждений нужен, чтобы не делать ничего лишнего и не
   пропустить ничего критичного.

4. **Оценка риска** по acceptance: если оставить items[] как сейчас,
   на каких сценариях SLAI matcher провалится (контейнерные грузы /
   мультистоп / морские) и что эта точность будет стоить в KPI Фазы 1
   (где Фаза 1 включает `transport_request`, `ttn`, `transport_invoice`,
   `cmr`, `waybill` — § 3.1).

5. **План синхронизации:** последовательность шагов (schema → prompt →
   нормализаторы → fixtures → миграция БД при необходимости → bench),
   с ETA в часах/днях.

Если у агента возникают противоречия в фактах — фиксировать их отдельным
списком («inconsistencies found»). Этот документ не претендует на
последнее слово; противоречия должны вылавливаться, а не сглаживаться.

---

## 7. История

| Версия | Дата | Изменения |
| --- | --- | --- |
| v0.1 | 2026-06-03 | Первоначальный свод обеих сторон по теме «позиции счёта». |
