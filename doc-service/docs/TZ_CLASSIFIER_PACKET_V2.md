# ТЗ: Классификатор v2 — таможенные пакеты (сегментация композитов, ВЭД-типы, ПДн, мультиязычность)

| | |
|---|---|
| **Эпик** | CLASSIFIER-PACKET-V2 |
| **Дата** | 2026-07-11 |
| **Статус** | DRAFT v2 — review-hardened (прошёл адверсариал-ревью в 4 линзы; все claim'ы сверены с кодом) |
| **Основание** | ручной разбор всех 51 док. БКТ Транзит → [BCTT_GROUNDTRUTH.md](./BCTT_GROUNDTRUTH.md) (51/51 прочитано) |
| **Затрагивает** | doc-service (`pipeline/classifier`, `pipeline/multidoc`, `pipeline/normalize/pii-redact`, `config.ts`, `routes/jobs.ts`, `webhook-delivery.ts`, `types/slug-normalize.ts`, `migrations/`), inference-service (`src/inference_service/prompts/classify.py`), контракт SLAI |
| **Совместимость** | не ломает СХЕМУ `/api/v1`, но **меняет семантику** `payload.extracted` для файлов, ставших multi-doc (см. §7) — требует подписи SLAI |

> **⚠️ Два блокера до продакшена** (выявлены ревью, подтверждены кодом): **(1) ПДн-утечки** —
> паспортный текст сейчас хранится в `jobs.raw_text` и отдаётся наружу, `documents[]` обходит
> `redact_pii`, а сегментный extract может уйти в **облачный LLM** (нарушение 152-ФЗ / правила
> asha «не корп-данные»). **(2) Механизм сегментации** в черновике был нереализуем (граница
> открывала сегмент с `type=null`, который `runner.ts:112` выбрасывает). Оба закрыты в §8 и §4.

---

## 1. Контекст и проблема

Прогон реального корпуса БКТ (51 документ, 5 поставок, **все 51 прочитаны вручную**) показал,
что провалы — **не там, где чинили** (keyword-точность на одном документе):

1. **Композиты** — ~35/51 это СТОПКА из 3–15 разных документов в одном скане
   (EAD + акциз + инвойс + packing + CMR + СТС + паспорт). Пайплайн вешает один тип на всю
   стопку. `SKMBT → «ТТН»`, `noreply → «не разобрали»` — именно это.
2. **Пробелы каталога** — постоянно встречаются типы, которых нет (§5.1).
3. **Мультиязычность** — RU/EN/DE/LV/LT/ES/HR/HU/PL/BY. `classifier/keywords.ts` RU-центричен.

### 1.1 Структура корпуса

**Три физических паттерна файла** (классификатор умеет только A):

| Паттерн | Где | Что нужно |
|---|---|---|
| A. один файл = один чистый док | p01-paper | уже справляется |
| B. один файл = один док, пёстрый набор + фото + ID | p02-oskar, p03-mnj | недостающие типы + классиф. фото/ID |
| C. один файл = стопка N разных доков (композит) | root, p04-ltk | **сегментация** |

Шаблон пакета (подтверждён на всех композитах): `EAD(MRN) [+ акциз e-AD] + инвойс + packing +
CMR + СТС [+ паспорт]`. **Порядок сегментов внутри пакета плавает** (EAD всегда стр.1, дальше
packing/invoice/spec в разном порядке), **спец бывает в 2-3 копиях**, **есть многостраничные
одиночные доки** (инвойс SICHEL стр.8-11, EAD стр.1-2) — значит фиксированный шаблон хардкодить
нельзя, нужен per-page + границы + защита от over-segmentation.

### 1.2 Диагноз по коду (сверено)

Машинерия сегментации есть (`multidoc/runner.ts` `tryMultiDoc` → `multidoc/splitter.ts`),
постраничный текст есть (`ocr/pdf-text.ts` pagerender; `ocr/yandex.ts` per-PNG). Схлопывание —
на **постраничной классификации**:

- **Per-page идёт keyword-only.** `orchestrator.ts:98` `const classifier = new KeywordClassifier()`;
  `:486` `tryMultiDoc(ocr, {classifier, …})` получает именно этот keyword-классификатор. Полный
  LLM-каталог путь (`llmDocClassifier`, `:101`, `:1284`) в мультидоке **не** используется. Значит
  `llmConfidence` (`llm-classifier.ts:320`) на per-page пути не производится.
- Иноязычная/фото-страница → keyword `null`/low-conf → `splitter.ts:82`
  `isEmpty || isLowConf || noType || sameType` ⇒ **приклеивается к предыдущему сегменту**.
- Итог: N разнотипных страниц сливаются в 1 сегмент → `segments.length < 2` →
  `isMultiDocument()=false` (`splitter.ts:140`) → single-doc → один тип на пакет.

**Вывод:** P0 = (а) дать per-page настоящую классификацию (LLM-адаптер + мультиязычность +
детект ID/фото по маркеру); (б) **границы документов**, которые ПЕРЕЗАПИСЫВАЮТ тип сегмента, а не
полагаются на null-класс; (в) защита от over/under-segmentation через per-page identity.

---

## 2. Цели / Не-цели / Метрики

**Цели:** G1 сегментация композитов; G2 покрыть типы ВЭД-пакета; G3 языко-независимость;
G4 надёжный дискриминатор invoice↔packing↔spec (+комбинированные); **G5 ПДн паспортов не
хранятся, не отдаются, не уходят в облако**; G6 измеримая приёмка.

**Не-цели:** полный VLM-only пайплайн (P2); извлечение персональных полей из ID (§8); version bump до v2.

**Метрики** (замер `scripts/eval-bctt.ts`, golden = [BCTT_GROUNDTRUTH.md](./BCTT_GROUNDTRUTH.md) §2, **все 51 файла**):
- M1. **≥85%** файлов с корректным набором типов по сегментам. Применяется **пофазно** (§11): после
  фазы 2 — по не-фото файлам (A/D/ltk); фото-кейсы (B/C) входят в M1 после фазы с классиф. фото/ID.
- M2. **100%** флагманов: SKMBT, noreply, viber 448, viber 632 (noreply зависит от детекта паспорта — §11).
- M3. **0** регрессий формы `extracted` на p01-paper (D1) и текущих smoke-фикстурах.
- M4. **0** утечек ПДн: ни в `documents[].extracted`, ни в `payload.extracted`, ни в `jobs.raw_text`,
  ни в webhook при `redact_pii`, ни отправки паспортного текста в облачный LLM (§8).

---

## 3. Обзор архитектуры (было → станет)

```
OCR (ocr.text + ocr.pages[])
   │ [P0-0] guard: для multi-page источника ocr.pages.length ДОЛЖЕН = числу физ. страниц;
   │        если скан склеился в 1 blob — форсить per-page OCR (render PNG) до single-doc пути
   ▼
tryMultiDoc(ocr)  (multidoc/runner.ts)
   1. per-page classify   [P0-1] LLM-адаптер + мультиязычность + детект ID/фото; параллельно
   2. detectDocumentStart [P0-2] границы с identity → перезапись типа сегмента (boundaries.ts)
   3. split + 2nd-pass    [P0-2] continuation-rule + retro-split при конфликте identity
   4. per-segment extract [P1] + ПДн-гейт для ID-сегментов (§8)
   ▼
webhook payload.documents[]  (+ redactPii на КАЖДЫЙ entry — §7/§8)
```

---

## 4. P0 — Сегментация композитов (наибольший ROI, ~70% ошибок)

### P0-0. Гарантия постраничного OCR
`orchestrator.ts:485` — оставить триггер `ocr.pages && ocr.pages.length > 1`, но **добавить
предусловие**: для любого multi-page источника проверять `ocr.pages.length === физ. число страниц`.
Если многостраничный скан вышел как `ocr.pages.length === 1` (Yandex OCR склеил в blob) — форсить
per-page рендер (PDF→PNG постранично) и повторный OCR, иначе сегментация не запустится вообще.
Одностраничные фото (паттерн B) сегментации не требуют — single-doc путь для них не ломать.

### P0-1. Настоящая постраничная классификация

**Проблема (сверено):** `runner.ts:76` зовёт `classifier.classify(page.text, orgId)` на
`KeywordClassifier` и читает `cls.type`/`cls.confidence` (`ClassificationResult`). `LlmDocClassifier`
**не** `implements Classifier`: сигнатура `classify(input:{text,fileName?,organizationId?},
isCatalogSlug, log, context): Promise<LlmClassificationOutcome>` (`llm-classifier.ts:101-110`),
возвращает `{documentType, metadata}`. Просто подставить нельзя — не скомпилируется.

**Задача:**
1. **LLM-адаптер.** Новый `classifier/llm-page-adapter.ts`: класс, `implements Classifier`, оборачивает
   `LlmDocClassifier`; поставляет `isCatalogSlug = (s)=>documentTypeResolver.get(s)!==null`, `Logger`;
   маппит `LlmClassificationOutcome{documentType,confidence?}` → `ClassificationResult{type,confidence}`.
   Инжектить его как `deps.classifier` в `tryMultiDoc` (`orchestrator.ts:486`) вместо `KeywordClassifier`.
   Альтернатива: расширить `MultiDocRunnerDeps.classifier` + call-site `runner.ts:74-83` под сигнатуру
   `LlmDocClassifier` и протянуть `deps.log` + `isCatalogSlug`. Выбрать адаптер (меньше диффа).
2. **Мультиязычность keyword-prior** (§6) — иноязычная страница получает тип, не null.
3. **Детект ID/фото по маркеру БЕЗ облачного LLM.** Если `page.text.trim().length < minText` ИЛИ
   найден passport-маркер (MRZ `P<[A-Z]{3}`, «ПАШПАРТ/PASSPORT») — классифицировать страницу
   `driver_passport` **локально по маркеру** (не слать в облачный classify/extract — §8). Полноценный
   VLM-classify для прочих плохих фото — P2, но детект паспорта/ID обязателен уже в P0 (нужен M2/A5/A7/C2).
4. **Стоимость и латентность.** Per-page classify = отдельная стоимость (НЕ 4.8₽/док — это per-doc
   extract). 15-стр композит ≈ 15 classify + ~6 extract. Митигации: (а) **keyword-prior gate** —
   если keyword уверенно решил страницу или сработала hard-boundary, LLM-вызов не делать; (б)
   **параллелить** per-page classify с bounded concurrency (p-limit 4-6) вместо серийного `for`-await
   в `runner.ts:74`. Отдельную строку per-page-classify-cost внести в §11.

### P0-2. Границы документов и сплиттер

**Детектор.** Новый `multidoc/boundaries.ts`:
`detectDocumentStart(text: string, prev?: {slug, identity}): {slug: DocumentTypeSlug, identity: DocIdentity} | null`.
Возвращает НЕ только slug, но и **identity** (`{invoice_no?, mrn?, arc?, order_no?}`), извлечённую из
первых ~500 симв. — нужна для continuation/anti-over-split. Два класса сигналов:

**(а) Безусловные якоря** (открывают новый сегмент всегда, даже при low-conf классификатора):

| Тип | Маркер (case-insensitive, unicode-fold; в первых ~500 симв.) |
|---|---|
| customs_export_ead | `Ausfuhrbegleitdokument`, `Eksporta deklarācija`, `EXPORT ACCOMPANYING`, `EUROPÄISCHE GEMEINSCHAFT`, `EUROPEAN COMMUNITY` + структурный MRN (см. ниже) |
| **excise_ead** | `АКЦИЗЕ ПРЕЦЕС`, `AKCĪZES PRECES`, `684/2009` |
| packing_list | `PACKING LIST`, `Упаковочный лист`, `Packliste`, `Lista de embalaje` |
| cmr | `CMR` в рамке / `Международная … накладная` / `Frachtbrief` / `tovarni list` |
| vehicle_registration | `REGISTRACIJOS LIUDIJIMAS`, `ТЕХНИЧЕСКИЙ ТАЛОН`, `Transpordiamet`, `Certificat d'immatriculation` |
| driver_passport | MRZ `P<[A-Z]{3}`, `PASSPORT`, `ПАШПАРТ`, `РЭСПУБЛIКА` |
| transport_permit | `Engedély`, `Permit`, `разовое разрешение`, `SPECIAL SINGLE-TRIP` |
| **contract_specification** | `Спецификация №… к Контракту`, `Specification № … to Contract`, `Spezifikation`, `Especificación` |
| **certificate_register** | `Реестр … сертификатов`, `Annex to invoice`, повторяющиеся строки `Сертификат соответствия ЕАЭС` |
| **delivery_note** | `Delivery Note`, `Расходная накладная`, `Lieferschein`, `Pavadzīme` |

**(б) Identity-условные якоря** (открывают сегмент ТОЛЬКО если identity ≠ предыдущего):

| Тип | Правило |
|---|---|
| commercial_invoice | `Invoice No / Факт / Factura / Rēķins / Rechnung / Facture` + **`invoice_no` ≠ prev.identity.invoice_no** |
| excise_ead (по ARC) | ARC как якорь ТОЛЬКО совместно с excise-заголовком; голый ARC на инвойсе — back-reference, не граница |

**MRN-строгость (против false-positive):** требовать литерал `MRN` в той же строке / ±40 симв. И
структуру (2 цифры года + 2 буквы страны + офис/серия + контрольный символ), И **подавлять**, если
тот же код уже встречался на более ранней странице, типизированной как EAD (back-reference).

**Прецеденс детектора:** самое специфичное первым — `excise_ead`/`driver_passport` проверять
**до** generic EAD-заголовков (акцизная страница содержит EU-текст, матчащий EAD). Юнит-тест
excise-vs-EAD (позитив/негатив) обязателен.

**Открытие сегмента (критично — иначе сегмент выбрасывается):** когда `detectDocumentStart`
вернул slug, сплиттер создаёт сегмент с `document_type = boundarySlug` (**перезаписывая** null/low-conf
классификатора), `confidence = max(page.confidence, 0.6)` (boundary-floor), и ставит `boundary = slug`.
Без перезаписи сегмент откроется с `document_type=null` → `runner.ts:112` `if(!seg.document_type) continue`
его пропустит.

**Continuation-rule (против over-split многостраничного одиночного дока):** страница БЕЗ якоря, чья
identity пуста ИЛИ равна identity текущего сегмента, **приклеивается даже при смене типа
классификатором** (стр. 2-4 инвойса SICHEL теряют «Invoice No» и выглядят как packing/spec — не
должны открывать новый сегмент). Новый сегмент — только когда сработал якорь И identity сменилась.

**Второй проход (против пропущенной границы в greedy single-pass):** после склейки — дешёвая
валидация: если внутри сегмента mid-страница несёт identity (`invoice_no`/`mrn`), отличную от
identity открытия сегмента, — ретро-split там. Логировать конфликты identity, чтобы `eval-bctt`
видел «молчаливые слипания», а не засчитывал их как один верный сегмент.

**`DocumentSegment`/`PageClassification` (`multidoc/types.ts`):** добавить поля `boundary: slug|null` и
`identity: DocIdentity`.

**`isMultiDocument()` (`splitter.ts:139-155`):** починка в источнике — раз граница открывает сегмент
с реальным типом, `segments.length>=2` и `typedCount>=1` срабатывают сами. Дополнительно:
**boundary-открытые сегменты считать typed безусловно** (не через порог `confidence>=0.5`, `splitter.ts:150`).
Спец-правило «≥1 hard-boundary ⇒ multi-doc» становится следствием, а не костылём.

### P0-3. Конфиги (`config.ts`) — по реальному паттерну хелперов

Хелперы `numberFromEnv/booleanFromEnv/confidence01FromEnv` (`config.ts:3-37`) принимают **один**
аргумент (default); имя env-переменной привязывается отдельно в `loadConfig()`.

```ts
// в z.object 'classifier' (config.ts:248-258):
segmentMinConf:       confidence01FromEnv(0.4),   // порог открытия сегмента
segmentTypedConf:     confidence01FromEnv(0.5),   // порог "typed" в isMultiDocument (был хардкод 0.5)
segmentHardBoundary:  booleanFromEnv(true),
segmentMaxPagesPerDoc:numberFromEnv(0),           // 0=выкл; circuit-breaker под UNDER-seg (§12)

// в loadConfig() classifier-блоке (config.ts:671-678):
segmentMinConf:        env.SEGMENT_MIN_CONF,
segmentTypedConf:      env.SEGMENT_TYPED_CONF,
segmentHardBoundary:   env.SEGMENT_HARD_BOUNDARY,
segmentMaxPagesPerDoc: env.SEGMENT_MAX_PAGES,
```
Аналогично добавить `CLASSIFY_PROVIDER_ID` (§P2-3) и `ID_EXTRACT_ENABLED` (§8). `segmentMaxPagesPerDoc`
— это НЕ защита от over-segmentation (cap только форсит ДОП. split); если >0 — circuit-breaker против
under-segmentation (сегмент вырос >N стр. → перезапустить детекцию границ внутри). Default 0.

### P0-4. Тесты
`tests/multidoc-boundaries.spec.ts` — все якоря §P0-2 (позитив/негатив, мультиязычные, excise-vs-EAD
прецеденс, MRN back-reference); `tests/multidoc-splitter.spec.ts` — фикстуры страниц SKMBT/SARASA/ltk/
SICHEL (`tests/fixtures/bctt/*.txt`): SKMBT→4, ltk→3-4 (spec отдельным сегментом), SICHEL инвойс
стр.8-11 = ОДИН сегмент (не over-split), single-doc→1 (backwards-compat).

---

## 5. P1 — Каталог типов + дискриминаторы

### 5.1 Новые типы (миграция)

`migrations/2026071100000X_ved_packet_types.sql` по образцу `20260703000001_customs_export_ead_type.sql`.
**Важно:** `document_types.tier` = `NOT NULL DEFAULT 'experimental'` (`20260525000001_document_types_tier.sql:24`)
— чтобы типы были beta, `tier` надо задать явно (иначе они experimental).

| slug | display_name | Дискриминатор (`description`) | expected_fields (P0) | ПДн |
|---|---|---|---|---|
| `excise_ead` | Акцизный e-AD (АКЦИЗЕ ПРЕЦЕС) | Электронный админ-документ на подакцизные товары (алкоголь), Reg.684/2009, ARC-код, % спирта. НЕ обычный EAD. | arc, sender_excise_id, consignee, items[]{name,kn_code,alcohol_pct,gross,net} | низкий |
| `vehicle_registration` | Свид-во о регистрации ТС (СТС) | СТС/техталон/Registracijos liudijimas/Transpordiamet: рег.номер ТС, VIN, марка, категория. НЕ груз. | reg_number, vin, make, category, holder, valid_until | низкий |
| `driver_passport` | Паспорт водителя | Удостоверение личности с фото, MRZ `P<XXX`. **Extract ПДн выключен, allowlist-фильтр (§8).** | doc_kind='id', country, present | **высокий** |
| `transport_permit` | Дозвол / разовое разрешение | Разрешение на межд. автоперевозку (Engedély/СРР). НЕ негабарит-special_permit. | number, issued_by, valid_from, valid_to, truck_plate, trailer_plate | низкий |
| `certificate_register` | Реестр сертификатов (annex) | Приложение к инвойсу — ТАБЛИЦА сертификатов ЕАС (много строк). НЕ одиночный сертификат. | invoice_ref, items[]{cert_number,issue_date,expiry_date,issuing_body,holder} | низкий |
| `delivery_note` | Расходная накладная / Delivery Note | Отгрузочная накладная: позиции + LOT + сроки годности, БЕЗ цен. Отличать от packing_list (нет LOT/сроков) и waybill (транспортная). | number, date, supplier, consignee, items[]{name,lot,best_before,qty,net} | низкий |

`tir_identification` **НЕ заводим отдельно** — фолдим в `vehicle_registration` **безусловно** (не
«или special_permit»). Даже отдельно сфотографированный TIR-сертификат (oskar 104137) → `vehicle_registration`.
Добавить в его `classification_keywords`: `TIR`, `Carnet TIR`, `сертификат одобрения`, `Certificate of approval`.

`classification_keywords` — мультиязычные (§6). `llm_schema` — минимальные P0-схемы в
`document-json-schemas.ts` (+ override в `document_types.llm_schema`), расширение после SLAI (§13).

**Скетч миграции (с `tier`):**
```sql
INSERT INTO document_types (slug, display_name, description, tier, is_active, is_builtin,
  parser_kind, expected_fields, classification_keywords, confidence_threshold, organization_id)
VALUES
('excise_ead','Акцизный e-AD (АКЦИЗЕ ПРЕЦЕС)','<дискриминатор>','beta',true,false,'llm_extract',
  ARRAY['arc','sender_excise_id','items'], ARRAY['АКЦИЗЕ ПРЕЦЕС','AKCĪZES PRECES','684/2009','ARC'],0.6, NULL),
-- vehicle_registration, driver_passport, transport_permit, certificate_register, delivery_note ...
;
-- Down: DELETE FROM document_types WHERE slug IN (...);
```

### 5.2 Дискриминаторы (переписать `description` существующих — UPDATE-миграцией)
`catalog.ts` строит LLM-каталог как `slug — description` (`describeRow`). Переписать как отличия:
- `commercial_invoice` — «колонки цена/сумма. Если цен НЕТ — packing_list или contract_specification.»
- `packing_list` — «вес нетто/брутто, кол-во мест/паллет, БЕЗ цен и БЕЗ LOT/сроков.»
- `contract_specification` — «перечень к контракту (Spec №… к Контракту №…); может быть с ценами и без.»
- `delivery_note` — «позиции + LOT + сроки годности, отгрузочная, без цен (отличие от packing_list — есть LOT).»
- `customs_export_ead` — «экспортная декларация с MRN-баркодом. Не ТТН, не CMR, не акциз.»
- `quality_certificate` vs `certificate_register` — одиночный сертификат vs ТАБЛИЦА сертификатов.

### 5.3 Дискриминатор цены/вес + двойные документы
- Правило: цены (`Цена/Unit price/Amount/Precio/Preis/Prix`) → invoice; вес без цен → packing/спец.
- **Двойные документы в одном физическом листе** (не расщепляем — один файл/страница = один сегмент):
  - Комбинированный «Invoice Packing List» (Mondelez, oskar 125452): `commercial_invoice` + `also_packing=true`.
  - СТС поверх дозвола (mnj 251/319): доминирующий по площади/содержанию + вторичный флаг —
    `transport_permit` + `also_vehicle_registration=true` (или наоборот; правило «доминантный = тот, чьи
    поля заполнены/крупнее»). Общий механизм: `{document_type, secondary_role?}` в extracted.

---

## 6. P2 — Мультиязычность, VLM, развязка модели
- **P2-1 keywords** (`classifier/keywords.ts`): unicode-fold (ā/ē/š/ő/ç), флаг `u`; якоря LV/DE/ES/FR/HU/HR/LT/EE/PL.
  Нейтрализовать RU-хардкод в `inference-service/src/inference_service/prompts/classify.py` (НЕ путать с
  `src/inference_service/routes/classify.py` — это роут, не промпт).
- **P2-2 VLM-classify** (`ocr/vision-llm.ts`): полноценный image→slug для плохих фото (кроме паспортов — §8).
- **P2-3** `CLASSIFY_PROVIDER_ID` (config, default = текущая модель) → A/B qwen3.6 vs yandexgpt-5-pro.

---

## 7. Модель данных и контракт SLAI

- `documents[]` (`multidoc/types.ts`) v1-совместим по СХЕМЕ. НО:
  1. **Семантический слом (не схемный):** файлы, сегодня идущие single-doc, станут multi-doc → семантика
     `payload.extracted` для них меняется с «весь документ» на «доминирующий сегмент». v1-only консьюмер,
     читающий только `extracted`, увидит поля лишь первого сегмента. Задокументировать; огейтить
     per-consumer флагом (по образцу `classify_only`/hybrid) ИЛИ зафиксировать контракт и получить подпись
     SLAI. `eval-bctt` проверяет: D1 (p01-paper) не меняет форму `extracted`.
  2. **Новые слаги утекают в v1.** `OUTBOUND_SLUG_ALIASES` (`slug-normalize.ts:27`) не содержит 6 новых
     слагов → `normalizeSlugForApi` (`:47`) пропускает их дословно и в `documents[].document_type`, и в
     **верхнеуровневое** `payload.document_type` (когда доминант композита — новый тип, напр. C2 чистый
     паспорт → `document_type='driver_passport'`). До согласования с SLAI (§13.4) — гейтить фиче-флагом
     или маппить в известные SLAI-алиасы. Явно указать: top-level `document_type` тоже может нести новые слаги.
  3. **`documents[].confidence`** — усреднённое (running average в `splitter.ts`), boundary-сегмент открыт
     на floor 0.6. Определить семантику в контракте; предусмотреть per-segment `needs_review`/`status`
     (сейчас needs_review-гейт per-job, сегмент-паспорт/ошибочный сегмент не уходит на ревью независимо).
- `payload.extracted` = доминирующий сегмент (как сейчас), `payload.documents` = все. Version bump не делаем.

---

## 8. ПДн / паспорта (БЛОКЕР — расширено по ревью, сверено с кодом)

Требование «не извлекаем/не храним/не отдаём/не шлём в облако ПДн» сейчас **не выполняется**. Пять дыр:

1. **`jobs.raw_text`.** `orchestrator.ts:732` `rawText: ocr.text` персистит OCR ВСЕХ страниц (включая
   паспортную с MRZ/ФИО/номером). Отдаётся наружу `GET /jobs/:id/raw_text` (`routes/jobs.ts:745`
   `reply.send(job.raw_text)`), переиспользуется в reprocess (`:1343`). F27 `delete_after_processing`
   чистит только `file_path`, `raw_text` остаётся. **Фикс:** для job с ID-сегментом маскировать диапазон
   ID-страниц в `ocr.text` до персиста; `markFileDeleted` (F27) должен NULL-ить и `raw_text`;
   огейтить/скрыть `/jobs/:id/raw_text` для ID-содержащих job'ов.
2. **`documents[]` обходит redact.** `webhook-delivery.ts:75-85` строит `documents` из `multidocRaw`
   только через `normalizeSlugForApi`, БЕЗ `redactPii`; `:106` редактирует лишь основной `extractedNoMultidoc`.
   Клиент с `?redact_pii=true` получает `documents[].extracted` паспорта нередактированным. **Фикс:** map
   `redactPii` по каждому `documents[].extracted` когда `shouldRedact`.
3. **Extract-нейтрализация не существует.** Одна `llm_schema`/`expected_fields` не фильтрует вывод LLM
   (модель отдаёт лишние поля). **Фикс:** жёсткий **allowlist-пост-фильтр в doc-service** (не только промпт):
   для `doc_kind='id'` после extract выбрасывать все ключи кроме `{doc_kind,country,present}`. Применять и
   к сегментному, и к основному extract. Юнит-тест: LLM вернул name/passport_no → на выходе их нет.
4. **Основной `payload.extracted` блендует все страницы.** После мультидок-блока orchestrator гонит
   `runDocumentPipeline(ocr.text)` по всему склеенному тексту (v1-поле). Может вытащить ФИО/номер паспорта,
   не гейтится `ID_EXTRACT_ENABLED`. **Фикс:** allowlist-гейт применять и к основному extract; либо для
   файлов, где `detectDocumentStart` нашёл passport, не блендить эти страницы в основной extract.
5. **Облачный LLM + слабый redact.** `PII_PATTERNS` (`pii-redact.ts:36`) = только `passport_rf`,
   `driver_license`; нет MRZ, нет LV/LT/EE персональных кодов; `PII_FIELD_PATHS` без holder/name/
   personal_number/mrz/date_of_birth. Корпус мультиязычный → иностранные ПДн выживают. Хуже:
   `extractSegment` шлёт `combined_text` сегмента (и per-page classify — §P0-1) в LLM → **MRZ/номер
   паспорта уходят во внешнюю модель** (на asha/kb-docker — нарушение 152-ФЗ и «asha: не корп-данные»).
   **Фикс:** (а) добавить в `PII_PATTERNS` MRZ + нац. коды, в `PII_FIELD_PATHS` — поля ID; (б) страницы/
   сегменты с passport-hard-boundary **не отправлять в облачный classify/extract** — классифицировать по
   маркеру `detectDocumentStart` без LLM, а extract либо пропускать, либо только локальной моделью.
   Конфиг + тест.

`ID_EXTRACT_ENABLED=false` по умолчанию (config). Приёмка M4: `raw_text` job'а с паспортом не содержит
MRZ/номера; `documents[]` и `extracted` с `redact_pii` не содержат ID-полей; композит с паспортом не
инициирует облачный вызов на паспортных страницах.

---

## 9. Приёмка / eval-harness

**`scripts/eval-bctt.ts`** грузит ожидаемый набор типов **для каждого из 51 файла** из
[BCTT_GROUNDTRUTH.md](./BCTT_GROUNDTRUTH.md) §2 (golden — включая ◦по-шаблону ltk и все oskar/mnj файлы),
не только перечисленные кейсы. Ключевые проверки:

| # | Кейс | Ожидаемо |
|---|---|---|
| A1 | SKMBT | customs_export_ead, cmr, commercial_invoice, vehicle_registration |
| A2 | SARASA | customs_export_ead, commercial_invoice, packing_list, cmr, vehicle_registration |
| A4 | LAROCHE/SUMEIRE | customs_export_ead, **excise_ead**, commercial_invoice, packing_list, cmr, vehicle_registration |
| A5 | SICHEL (15 стр) | **7 типов**: customs_export_ead, excise_ead, commercial_invoice(стр.8-11=ОДИН сегмент), packing_list, cmr, driver_passport, vehicle_registration |
| A6 | ltk 123042/123324/123719/123810 | customs_export_ead, packing_list, commercial_invoice, **contract_specification (обязателен, не опц.)** |
| A7 | noreply | driver_passport, cmr, vehicle_registration (проверить: 2×СТС тягач+прицеп — см. §12) |
| B1 | viber 448/259 | contract_specification (НЕ invoice) |
| B2 | viber 526 | commercial_invoice |
| B3 | viber 632 | certificate_register (НЕ quality_certificate) |
| B4 | oskar 125452 | commercial_invoice + also_packing |
| B5 | oskar 125423 | **delivery_note** |
| C1 | oskar 104005/104017 / mnj 100 / **104137 (standalone TIR)** | vehicle_registration |
| C2 | oskar 104051 / mnj 173 / SICHEL p14 / **noreply-passport** | driver_passport, extract/raw_text/webhook ПДн ПУСТ (M4) |
| C3 | oskar 115954 / mnj 251,319 | transport_permit (mnj 251/319 — + also_vehicle_registration) |
| D1 | p01-paper CMR/inv/pac | без регрессии; форма `extracted` не меняется |

---

## 10. Тест-план
- `multidoc-boundaries.spec.ts`, `multidoc-splitter.spec.ts` (§P0-4).
- `classifier-keywords.spec.ts` — мультиязычные якоря (LV/DE/ES/LT → тип, не null).
- `classifier-discriminator.spec.ts` — invoice/packing/spec/delivery_note/combined.
- `driver-passport-pii.spec.ts` — **M4 на композит-паспорте (noreply) и фото-паспорте**: extract пуст,
  `raw_text` без MRZ, `documents[]`+`extracted` с redact без ID-полей, нет облачного вызова.
- integration: `eval-bctt.ts` в CI на golden-слепках всех 51 файла.

---

## 11. Фазы / порядок / метрик-гейты

| Фаза | Состав | Метрик-гейт | Риск | Оценка |
|---|---|---|---|---|
| **1 (P1 + ПДн-основа)** | миграция 6 типов (+tier) + описания + правило цены/вес + мультиязычные якоря + **allowlist-фильтр ПДн (§8.3) + redact documents[] (§8.2) + PII_PATTERNS MRZ (§8.5а)** | M4 (ПДн) базово; single-doc типизация | низкий | 2–3 дня |
| **2 (P0 сегментация)** | `boundaries.ts` (identity) + splitter (перезапись типа, continuation, 2nd-pass) + LLM-адаптер per-page + детект паспорта по маркеру + config + `raw_text`-маскирование (§8.1) + не-слать-паспорт-в-облако (§8.5б) | M1 по A/D/ltk; M2 (SKMBT, viber 448/632); **noreply/A5-passport входят сюда т.к. детект паспорта по MRZ в P0** | средний | 4–6 дней |
| **3 (P2)** | VLM-classify (не паспорт) + мультиязычный prompt + `CLASSIFY_PROVIDER_ID` + slug-согласование с SLAI | M1 полностью (вкл. фото B/C) | средний | 2–3 дня |

Каждая фаза — деплой на **asha** (ручной per DEPLOY_TOPOLOGY: `git pull` → build api/worker → up
`--no-deps` → **проверить/переподключить proxy-net** → /health), прогон `eval-bctt.ts`.

---

## 12. Риски
- R1. **Облачный LLM + ПДн** (БЛОКЕР) — паспортный текст в classify/extract. Митигация §8.5б.
- R2. **False-positive границ** — MRN матчит container/ref-номера, ARC как back-reference. Митигация:
  строгий MRN (литерал+структура+подавление back-ref), ARC только с excise-заголовком (§P0-2).
- R3. **Over-segmentation** многостраничного одиночного дока (инвойс SICHEL стр.8-11). Митигация:
  continuation-rule по identity (§P0-2), НЕ `segmentMaxPagesPerDoc` (он про under-seg).
- R4. **Under-segmentation** — пропущенная граница склеивает 2 дока; greedy single-pass не восстанавливает.
  Митигация: 2nd-pass по identity + лог конфликтов.
- R5. **Same-type merge** — 2×СТС (тягач+прицеп) в noreply сливаются (`splitter.ts:82` sameType→attach),
  теряется различие. Решение: если SLAI нужны per-vehicle — same-type boundary по разному reg_number/VIN
  в первых ~500 симв.; иначе явно задокументировать намеренную склейку.
- R6. **Стоимость per-page classify** — 10-20× инфляция вызовов на композитах. Митигация: keyword-prior
  gate + параллелизм (§P0-1.4).
- R7. **Семантический слом v1** `extracted` для ставших-multi файлов (§7.1).

---

## 13. Открытые вопросы к SLAI (онтология + контракт)
1. `driver_passport`/`id_document` — заводим? Политика ПДн (allowlist `{doc_kind,country,present}`, не извлекаем — ок?).
2. `excise_ead` — отдельный тип (акциз ≠ обычный EAD)? Критично для алкоголя.
3. `certificate_register` — тип или под-вид `eac_conformity_certificate`?
4. `vehicle_registration` + `transport_permit` + `delivery_note` — заводим? Согласовать 6 новых слагов
   для v1-контракта (top-level `document_type` тоже может их нести).
5. Двойные доки (Invoice Packing List; СТС+дозвол) — доминант + `secondary_role` или расщепляем?
6. Композит: `documents[]` достаточно, или нужен `jobs.parent_job_id` родитель-ребёнок + per-segment `needs_review`?
7. Семантика `extracted` для ставших-multi файлов — фиксируем «доминантный сегмент» + per-consumer флаг?
8. Целевой M1 — 85%?

---

## Приложение A. Затрагиваемые файлы (для реализующего агента)
- `src/pipeline/multidoc/boundaries.ts` — **новый**, `detectDocumentStart(text, prev)` c identity + прецеденс.
- `src/pipeline/multidoc/splitter.ts` — перезапись типа сегмента boundary-слагом, continuation-rule, 2nd-pass, `segmentTypedConf`, boundary-typed.
- `src/pipeline/multidoc/types.ts` — `boundary`, `identity` в `DocumentSegment`/`PageClassification`; `DocIdentity`.
- `src/pipeline/multidoc/runner.ts` — LLM-адаптер как `deps.classifier`; параллельный per-page classify; детект паспорта по маркеру (без облака).
- `src/pipeline/classifier/llm-page-adapter.ts` — **новый**, `Classifier`-адаптер над `LlmDocClassifier`.
- `src/pipeline/classifier/keywords.ts` — unicode-fold + мультиязычные якоря.
- `src/pipeline/orchestrator.ts` — инжект адаптера в `tryMultiDoc` (:486); ПДн-гейт основного extract; маскирование `raw_text` ID-страниц (:732); P0-0 guard.
- `src/pipeline/webhook-delivery.ts` — `redactPii` на каждый `documents[].extracted` (:75-85).
- `src/pipeline/normalize/pii-redact.ts` — MRZ + нац. коды в `PII_PATTERNS`; ID-поля в `PII_FIELD_PATHS`.
- `src/routes/jobs.ts` — гейт `/jobs/:id/raw_text` (:745) для ID-jobs.
- `src/storage/jobs.ts` — `markFileDeleted` (F27) NULL-ит `raw_text`.
- `src/types/slug-normalize.ts` — решение по 6 новым слагам (алиасы/флаг).
- `src/config.ts` — `segmentMinConf/segmentTypedConf/segmentHardBoundary/segmentMaxPagesPerDoc`, `CLASSIFY_PROVIDER_ID`, `ID_EXTRACT_ENABLED` (двухчастный паттерн :248-258 + :671-678).
- `src/pipeline/document-json-schemas.ts` — схемы 6 новых типов + allowlist для ID.
- `migrations/2026071100000X_ved_packet_types.sql` — **новый**, 6 типов (tier=beta) + UPDATE описаний.
- `inference-service/src/inference_service/prompts/classify.py` — язык-агностичный промпт.
- `scripts/eval-bctt.ts` — **новый**, harness на все 51 файла.
- `tests/multidoc-boundaries.spec.ts`, `tests/multidoc-splitter.spec.ts`, `tests/classifier-discriminator.spec.ts`, `tests/driver-passport-pii.spec.ts` — **новые**.
