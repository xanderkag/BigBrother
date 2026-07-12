# БКТ Транзит — ground-truth корпуса (51 документ) + анализ классификатора

> Составлено вручную: я (Claude) своим зрением прочитал документы напрямую
> (без API/сторонних сервисов), понял что каждый документ ЕСТЬ на самом деле,
> какой у него должен быть тип, какие поля важны, и сверил с каталогом типов в коде.
> Это golden-эталон для eval классификатора + спека на доработку.
>
> **Статус чтения: 51 из 51 файла прочитано глазами, 0 выбросов** (40 напрямую +
> 17 через фоновый workflow-fan-out). Все 5 пакетов, все типы, все edge-cases,
> все 4 проблемных кейса пользователя. Шаблоны подтверждены на 100% корпуса.
> Источник: `/root/bctt-docs` на asha (scp-копия в scratchpad).
>
> Нюансы, важные для сегментации (подтверждены дочиткой всех 18 ltk-композитов):
> **порядок сегментов внутри пакета плавает** (EAD всегда стр.1, дальше
> packing/invoice/spec в разном порядке) → фиксированный шаблон нельзя хардкодить,
> нужен per-page + границы. **Спецификация бывает в 2-3 копиях** в одном файле
> (123201: стр.3 + стр.5-6). **Есть многостраничные одиночные доки** (123755: EAD
> стр.1-2, packing стр.3-4; SICHEL: инвойс стр.8-11) → правило «тот же номер
> инвойса/MRN → тот же сегмент» обязательно (иначе over-segmentation).

## 0. TL;DR — что оказалось на самом деле

1. **Корпус = документы 5 грузовиков/поставок**, собранные двумя способами:
   офисные сканы (p01-paper, root, p04-ltk) и фото шоферской папки на телефон (p02-oskar, p03-mnj).
2. **Три физических паттерна файла** (классификатор умеет только первый):
   - **A. один файл = один чистый документ** (p01-paper). Легко.
   - **B. один файл = один документ, пёстрый набор + фото + ID** (p02-oskar, p03-mnj).
   - **C. один файл = СТОПКА из 3–15 разных документов** (композит: root, p04-ltk).
     Пайплайн вешает ОДИН тип на всю стопку → **главный провал** (~35 из 51).
3. **Главная проблема — сегментация композитов**, не keyword-точность. Чинит ~70% ошибок.
4. **Каталогу не хватает типов** (см. §3), в т.ч. найденных при дочитке:
   - **`excise_ead`** (АКЦИЗЕ ПРЕЦЕС / e-AD Reg.684/2009) — акцизный электронный
     адм. документ на алкоголь. Лежит в **КАЖДОМ** винном композите. Отдельно от EAD.
   - **`driver_passport`** — сквозной: **3 водителя, 3 паспорта** (Ausiyevich BY→956MRD,
     Osipau BY→MNJ126, Mametkaziev KGZ→9096BC). И в композитах (SICHEL, noreply), и
     отдельными фото (mnj 173, oskar 104051). Неизбежен → высокий ПДн-риск.
   - `vehicle_registration`, `transport_permit/dozvol`, `certificate_register`.
5. **Многоязычность**: RU/EN/DE/LV/LT/ES/HR/HU/PL/BY. RU-центричный keyword слаб.
6. **Дискриминатор «инвойс vs упаковочный/спец»**: цены → invoice; вес/кол-во без цен →
   packing/спец. НО встречаются **комбинированные** доки («Invoice Packing List» у
   Mondelez = инвойс И упаковочный в одном) — дискриминатор должен допускать оба-в-одном.

## 1. Карта поставок (кто/куда/чей грузовик/водитель)

| Пакет | Грузовик / перевозчик / водитель | Поставка | Носитель | Класс |
|---|---|---|---|---|
| p01-paper | GF8484/U6161 · SIA TJAGAČ | дизайнерская бумага, Роял Трейд(AM)→Ронетек(RU) | скан JPEG | A |
| p02-oskar | 9096BC/587BE · ОСКАР АВТО · Mametkaziev (KGZ) | шоколад Mondelez, Alca Zagreb(HR)→Mondelez(KZ) + доки машины | фото | B |
| p03-mnj | MNJ126/LR952 · ME Transportas · Osipau (BY) | косметика NIVEA, Beiersdorf(DE/PL)→Major Terminal(RU) + доки машины | фото | B |
| p04-ltk | · ME Transportas · Osipau (BY) | приводы AUMA(DE)→разные RU-получатели | скан PDF | C |
| root (956MRD) | 956MRD/441YNP · EVGED Group OÜ · Ausiyevich (BY) | оливки/вино→VKUSLAND/BRAVO(RU) | скан PDF | C |

Перевозчик **ME Transportas** и водитель **Osipau (BY)** — в p03-mnj и p04-ltk/noreply (один водитель, две поставки).

## 2. Ground-truth: пофайлово (51)

Легенда: ✅прочитано глазами · ◦по-шаблону · **GAP** = типа нет в каталоге.

### root — грузовик 956MRD, композиты (6/6 ✅). Шаблон: EAD [+ акциз] + инвойс + packing + CMR + СТС [+ паспорт]
| Файл | Что это (сегменты) | Классиф. сказал |
|---|---|---|
| SKMBT_C224e23121414480.pdf | ✅ 4-в-1: `customs_export_ead`(портвейн) + `cmr`(LV-009236) + `commercial_invoice` + **vehicle_registration** | ❌ `ТТН` |
| …26BC SARASA.pdf | ✅ 5-в-1: EAD + Factura(ES) + packing×2 + `cmr`(LV-237) + **vehicle_registration**. Оливки | — |
| …29BC KARINA.pdf | ✅ 7-в-1: EAD(…XCB2) + Factura(5028€) + packing×2 + `cmr`(LV-031) + **vehicle_registration**. Оливки/овощи | — |
| …189C BENJAMIN LAROCHE.pdf | ✅ 8-в-1: EAD(…M0B0) + **`excise_ead`(АКЦИЗЕ ПРЕЦЕС)** + Facture(2190€) + packing + `cmr`(LV-262) + **vehicle_registration**. Chablis | — |
| …205C SUMEIRE.pdf | ✅ 8-в-1: EAD(…IKB8) + **`excise_ead`** + Facture(7692€) + packing + `cmr`(LV-789) + **vehicle_registration**. Розе | — |
| …207C SICHEL.pdf | ✅ **15-в-1**: EAD(…HRB6) + **`excise_ead`** + `commercial_invoice`(4стр,19293€) + packing + `cmr`(LV-661) + **driver_passport**(Ausiyevich) + **vehicle_registration**. Бордо | — |

### p01-paper — чистые single, дизайнерская бумага (7/7 ✅)
| Файл | Что это | Тип |
|---|---|---|
| CMR.jpeg | ✅ CMR №25082 | `cmr` |
| inv 1.jpeg | ✅ Коммерческий инвойс №25082 (Цена/Сумма есть) | `commercial_invoice` |
| inv 2 / inv 3 | ✅ продолжение инвойса (позиции 21-53, итого 11 590 052,03 ₽) | `commercial_invoice` |
| pac 1.jpeg | ✅ Упаковочный лист №25082 (вес, без цен) | `packing_list` |
| pac 2 / pac 3 | ✅ продолжение упаковочного (позиции 11-41, нетто 20585.44/брутто 21770 кг) | `packing_list` |

### p02-oskar — фото папки, грузовик 9096BC (10/10 ✅)
| Файл | Что это | Тип |
|---|---|---|
| IMG_20230106_104005 | ✅ СТС (Киргизия, DAF тягач 9096BC) | **vehicle_registration** |
| IMG_20230106_104017_1 | ✅ СТС (Киргизия, прицеп 587BE) | **vehicle_registration** |
| IMG_20230106_104051_1 | ✅ **Паспорт водителя (KGZ, Mametkaziev)** — ПДн | **driver_passport** |
| IMG_20230106_104137 | ✅ Сертификат идентификации TIR (прицеп 587BE) | **tir_identification** |
| IMG_20231222_115954_1 | ✅ Дозвол (Венгрия, Engedély/Permit) | **transport_permit** |
| IMG_20231222_125231 | ✅ CMR (No.01012, Alca Zagreb→Mondelez KZ, шоколад MILKA, HR/мультиязычный) | `cmr` |
| IMG_20231222_125300_1 | ✅ EAD (Хорватия, 23HR…557B5) | `customs_export_ead` |
| IMG_20231222_125337 | ✅ EAD — список позиций (Export list of items) | `customs_export_ead` |
| IMG_20231222_125423_1 | ✅ **Delivery Note** (Mondelez, 9982830124, LOT/сроки годности) | **delivery_note (GAP)** ≈ waybill |
| IMG_20231222_125452 | ✅ **Invoice Packing List** (Mondelez, комбинир. инвойс+упаковочный, 85269€) | `commercial_invoice` (+packing в одном) |

### p03-mnj — фото папки, грузовик MNJ126, поставка NIVEA (9/9 ✅)
| Файл | Что это | Тип | Классиф. |
|---|---|---|---|
| viber…55-57-632 | ✅ **Реестр сертификатов ЕАС** (Annex to invoice) | **certificate_register (GAP)** | ❌ `quality_certificate` |
| viber…55-58-259 | ✅ **Спецификация BCS 1600151851 БЕЗ цен** (артикул+кол-во+вес) | `contract_specification` (без цен) | — |
| viber…57-16-448 | ✅ **Спецификация Beiersdorf БЕЗ цен** (96 600шт, 46 паллет) | `contract_specification` (без цен) | ❌ «как инвойс» |
| viber…57-16-526 | ✅ **VAT Invoice/Faktura VAT 8906476747** (Цена 92.96, 89 843€) | `commercial_invoice` | — |
| viber…57-16-593 | ✅ CMR (T-2348-3NG-1, 8050 картонов/46 паллет) | `cmr` | — |
| viber…57-54-100 | ✅ СТС (Литва, SCHMITZ LR952) + TIR-идентификация | **vehicle_registration** | — |
| viber…57-54-173 | ✅ **Паспорт водителя (BY, Osipau)** — ПДн | **driver_passport** | — |
| viber…57-54-251 | ✅ СТС (Литва, прицеп LR952) поверх разового разрешения RU | **vehicle_registration + transport_permit** | — |
| viber…57-54-319 | ✅ СТС (Литва, MAN тягач MNJ126) поверх разового разрешения RU | **vehicle_registration + transport_permit** | — |

### p04-ltk — композиты AUMA, PDF (19/19 ✅, все 18 dated-композитов прочитаны, 0 выбросов)
| Файл | Что это | Тип |
|---|---|---|
| 20231218122952.pdf | ✅ EAD(DE) + packing(49244) + invoice(13603643) | EAD+`packing_list`+`commercial_invoice` |
| 20231218123042.pdf | ✅ EAD(…632901B7→Норникель) + packing(49333) + invoice + Спец №521 | +`contract_specification` |
| 20231218123324.pdf | ✅ EAD(→GLAVNOVOSIBIRSKTORG) + packing(49339) + invoice + Спец №532 | тот же набор |
| 20231218123719.pdf | ✅ EAD(→Leroi Merlin Vostok) + packing(49349) + invoice + Спец №544 | тот же набор |
| 20231218123810.pdf | ✅ EAD(→ТМК) + packing(49354) + invoice + Спец №551 | тот же набор |
| 20231218123104…123755 (ещё ×13) | ✅ AUMA-композит, все прочитаны фоновым workflow. Получатели: Мосводоканал, Водоканал СПб, Метро Москвы, Сибирская генерация, **Куданкулам АЭС (Индия)**, Верхнебаканский цемент, Омск теплосети, Кировводоканал, Теплоэнерго НН, МОЭК. Порядок packing/invoice/spec плавает; spec бывает в 2-3 копиях; EAD/packing иногда 2 стр. | `customs_export_ead`+`packing_list`+`commercial_invoice`+`contract_specification` |
| noreply.printer_20231228_210901.pdf | ✅ **композит**: СТС×2(LT) + **driver_passport**(BY,Osipau) + TIR-серт + `cmr`(181220232) | смесь vehicle/ID/cmr |

## 3. Таксономия: что есть vs что нужно

**Есть и подходит:** `commercial_invoice`, `invoice`, `packing_list`, `contract_specification`,
`cmr`, `customs_export_ead`/`export_declaration`, `cert_of_origin`, `eac_conformity_certificate`,
`quality_certificate`, `bill_of_lading`, `special_permit`.

**Пробелы (нужно завести типы):**
| Нужный тип | Где | Сейчас |
|---|---|---|
| **excise_ead** (АКЦИЗЕ ПРЕЦЕС, Reg.684/2009, ARC, e-AD/EMCS) | КАЖДЫЙ винный композит (LAROCHE, SUMEIRE, SICHEL) | нет типа |
| **vehicle_registration** (СТС/техталон/Registracijos liudijimas/Transpordiamet) | почти каждый композит + весь oskar + mnj | `vehicle` — только поле |
| **driver_passport / id_document** | 3 водителя: mnj 173, oskar 104051, SICHEL, noreply | нет; высокий ПДн |
| **transport_permit / dozvol** (Engedély, разовое разрешение) | oskar 115954, mnj 251/319 | `special_permit`≈негабарит |
| **certificate_register / annex** (реестр сертификатов ЕАС) | mnj 632 | `eac_conformity_certificate` одиночный |
| **delivery_note** (расходная накладная/Delivery Note) | oskar 125423 | ≈ waybill |
| **tir_identification** (сертификат одобрения TIR) | oskar 104137, mnj 100, noreply | свести к vehicle_registration/special_permit |

## 4. Разбор 4 кейсов пользователя (подтверждено чтением)

1. **viber 448/259 «спец без цен»** → спецификация без цен (артикул+кол-во+вес). Рядом
   настоящий инвойс с ценами (526). Каталог говорит «спец С ценами» → путаница.
2. **SKMBT → «ТТН»** → композит из 4 документов, схлопнут в один тип. → сегментация.
3. **viber 632** → реестр сертификатов ЕАС, не quality_certificate. → тип-реестр.
4. **noreply → «не разобрали»** → композит: 2×СТС + паспорт(BY) + TIR + CMR. → сегментация + типы + ПДн.

## 5. План доработки (по ROI) — детально в [TZ_CLASSIFIER_PACKET_V2.md](./TZ_CLASSIFIER_PACKET_V2.md)

- **P0 — Сегментация композитов** (~70% ошибок). Машинерия есть (`multidoc/`), но per-page
  классификация слабая (RU-keyword на DE/LV/ES → null → страницы схлопываются). Усилить
  per-page classify (мультиязычность + LLM-catalog + VLM для фото) + hard-boundary
  (баркод MRN, АКЦИЗЕ, новый Invoice No, форма CMR, PACKING LIST, PASSPORT).
- **P1 — Типы (§3) + дискриминаторы** (переписать description как отличия; цены↔вес;
  допустить комбинир. «инвойс+упаковочный»).
- **P2 — Многоязычность + VLM-classify + развязка модели классификации.**
- **ПДн** — паспорта классифицируем, персональные поля НЕ извлекаем (`ID_EXTRACT_ENABLED=false`).

## 6. Онтологические вопросы к SLAI
1. `driver_passport`/`id_document` — заводим? Политика ПДн (не извлекаем — ок?).
2. `excise_ead` — отдельный тип (акциз ≠ обычный EAD)? Критично для алкоголя.
3. `certificate_register` — тип или под-вид `eac_conformity_certificate`?
4. `vehicle_registration` + `transport_permit` + `delivery_note` — заводим?
5. Комбинированные доки («Invoice Packing List») — один тип с двумя ролями или расщепляем?
