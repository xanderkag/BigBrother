# SLAI ТЗ v1 — матрица покрытия (traceability)

**Дата:** 2026-06-02
**Назначение:** пройтись по **первоисточнику** (`SLAI_TZ_v1_2026-05-17.md` — продакт-контракт
SLAI) пункт за пунктом и убедиться, что каждое требование закрыто, расходится осознанно
или висит явным остатком. Это **проверочный лист для ревью** (не статус-бэклог — тот в
`SLAI_INTEGRATION_BACKLOG.md`, организован по слоям; здесь — по требованиям ТЗ).

**Источники сверки:** `SLAI_TZ_v1_2026-05-17.md` (ТЗ), `src/pipeline/webhook-delivery.ts`
(payload по факту кода), `docs/openapi/v1.yaml`, `DOCUMENT_TYPES.md`, `SLAI_INTEGRATION_BACKLOG.md`,
`INTEGRATION_QUEUE.md`, `MODEL_REPORT.md` #29–35, `../../docs/FILE_TYPES_SPEC.md`.

**Легенда:** ✅ реализовано · ⚠️ расхождение с ТЗ (есть, но иначе) · 🔴 отсутствует/блокер ·
🟡 ждём внешнего · ❓ проверить вместе · ⏸ заморожено до триггера.

---

## A. Контракт ответа (ТЗ §1 — webhook payload v1)

Сверка поле-в-поле с фактическим payload (`webhook-delivery.ts:110–123`).

| ТЗ-поле | В payload | Статус | Заметка |
|---|---|---|---|
| `version: "v1"` | ✅ да (:110) | ✅ | |
| `job_id` | ✅ да (:111) | ✅ | |
| `status` (done/needs_review/failed) | ✅ да (:112) | ✅ | enum совпадает |
| `document_type` | ✅ да (:114) | ✅ | нормализован в `lower_snake_case` |
| `confidence` | ✅ да (:115) | ✅ | |
| `extracted` | ✅ да (:117) | ✅ | |
| `_field_confidence` | ✅ да, top-level (:120) | ✅ | F2; калибровка по ИНН-checksum/plate |
| `_normalized_fields` | ⚠️ внутри `extracted`, не top-level | ❓ | в pipeline-результате это top-level (`extracted-fields.ts:76`, тесты `normalize-run-pipeline.spec.ts`), но в webhook отдельно НЕ хойстится. **Проверить: ждёт ли SLAI его top-level рядом с `extracted` (как в ТЗ-примере)?** |
| `target_entity_hint` (Transportation/Transfer/null) | 🔴 нет нигде в коде | 🔴/❓ | grep по `*.ts` — 0 совпадений. Matcher — зона SLAI (§11), но ТЗ §1 указывает поле как выход parsdocs. **Проверить: нужен ли hint, или SLAI считает сам?** |
| `metadata` (echo of POST /jobs) | ✅ да (:118) | ✅ | reserved-ключи (`_inline_llm_creds`) вычищаются |
| `needs_review` (bool) | ⚠️ отдельного булева нет | ❓ | информация несётся через `status='needs_review'`. **Проверить: нужен ли SLAI отдельный boolean?** |
| `raw_text_preview` (first 500 chars) | ⚠️ нет в payload | ❓ | вместо preview — отдельный `GET /jobs/:id/raw-text` (F21, полный текст). **Проверить: достаточно ли эндпоинта, или нужен 500-символьный preview прямо в payload?** |

**Сверх ТЗ (добавлено, back-compat, не ломает):** `ocr_engine`, `error`, `documents[]`
(F5 multi-doc). Версионирование «add field = compat» (OQ#2) — это допустимо.

---

## B. Типы документов (ТЗ §1)

**Фаза 1 — 10 типов, перечислены в ТЗ поимённо → все ✅** (builtin + LLM fallback):
`invoice`, `transport_request`, `ttn`, `transport_invoice`, `cmr`, `waybill`, `upd`,
`services_act`(=наш `AKT`), `tax_invoice`(=наш `factInvoice`), `payment_order`.
Нейминг-алиасы покрыты case-insensitive (F22). Реестр — `DOCUMENT_TYPES.md`.

**Фаза 2 — ВЭД:** ТЗ говорит «8 ВЭД-типов», но **поимённо их НЕ перечисляет**. Наш набор
(`commercial_invoice`, `proforma_invoice`, `packing_list`, `bill_of_lading`,
`customs_declaration`, `cert_of_origin`, `eac_conformity_certificate`,
`wire_transfer_application`) — **выбран нами**. ❓ **Проверить: совпадает ли наш ВЭД-8
с тем, что SLAI имеет в виду под Фазой 2.**

**Сверх ТЗ:** +12 типов (contract, weighing_act, price_list, UKD, …) — добавочно, не мешает.

---

## C. Спецификации полей по типам (ТЗ §3.1–3.3)

ТЗ даёт детальные JSON-примеры по `invoice` (3.1), `transport_request` (3.2), `ttn` (3.3).
Наши схемы — в `DOCUMENT_TYPES.md`. Закрытые gap'ы: банк-реквизиты в invoice
(`seller.bank/bik/account/corr_account`, F19 ✅), транспортные атрибуты в `items[]`
(`92745ce` ✅), EXT-LINE 6 line + 4 doc-level транспортных поля (`42adffc` ✅).

❓ **Проверить вместе пофайлово:** что наши схемы invoice / transport_request / ttn
покрывают **каждое** поле из JSON-примеров ТЗ §3 (особенно transport_request: cargo,
vehicle, trailer, driver, rate — ТЗ помечал как «отсутствует половина»).

---

## D. Confidence-пороги (ТЗ §2)

| Порог ТЗ | Поведение | Статус |
|---|---|---|
| `≥ 0.85` → auto-привязка | мы отдаём `confidence` + `_field_confidence`, решение о привязке — на SLAI | ✅ (значение отдаём) |
| `0.60 ≤ c < 0.85` → «требует проверки» | то же | ✅ |
| `c < 0.60` → `status='needs_review'` | реализовано (needs_review path) | ✅ ❓ сверить точку отсечки 0.60 в коде |

---

## E. SLA (ТЗ §3)

| Параметр | MVP | Прод | Факт сейчас | Статус |
|---|---|---|---|---|
| Время/doc (text-path) | ≤90с | ≤30с | ~5с мед / ~26с худш (Mistral Small 3.1, #34/#35) | ✅ с запасом |
| Время/doc (vision/сканы) | ≤90с | ≤30с | P50 186–202с / P95 733–820с (Qwen-VL 32B) | 🔴 мимо → hybrid-routing (код `ef24a8d`, ждёт включения) |
| Throughput | 5/мин | 60/мин | не нагрузо-тестировано | ❓ проверить |
| Размер PDF | 20 MB | 50 MB | 50 MB + `file_url` снимает лимит (EXT-D) | ✅ |
| Страниц | 10 | 30 | multi-doc splitter F5 ✅ | ❓ сверить лимит страниц |
| Формат | PDF/JPG/PNG | +TIFF/HEIC | PDF/JPG/PNG/BMP/TIFF/WebP ✅; **HEIC не принимаем** | ⚠️ HEIC — 🔴 (см. FILE_TYPES_SPEC, P0) |
| Availability | 95% | 99.5% | не измеряется на Asha | ❓ |

---

## F. Auth (ТЗ §6)

| Что | Статус |
|---|---|
| Входящие токены `pdpat_xxx` (их вызовы к нам) | ✅ `API_KEYS_JSON` / personal_access_tokens |
| Inbound HMAC `X-SLAI-Signature` (verify SLAI→parsdocs) | ✅ INT-1 |
| Outbound webhook HMAC (`X-DocService-` + alias `X-Extractor-Signature`) | ✅ код; 🔴 **подписать нечем — ждём webhook-secret S1** |

---

## G. Golden dataset (ТЗ §5/§7)

15 PDF + 15 `.gt.json` (5 invoice / 5 transport_request / 5 ttn). 🟡 **ANSWERED 29.05,
ждём файлы, ETA 02–04.06** (Q9). PR-канал заведён: `doc-service/test-fixtures/slai-golden/`.
Без них — нет baseline точности на **их** документах.

---

## H. Acceptance-критерии (ТЗ §8)

| Цель ТЗ | Факт | Статус |
|---|---|---|
| Критичные поля ≥ 95% | наши фикстуры: поля 98.3% | ✅ на наших данных |
| Остальные ≥ 80% | арифметика `total` 100% | ✅ на наших данных |
| invoice: seller.inn/buyer.inn/number/total ≥95% | — | ❓ замерить на SLAI golden |
| transport_request: client/carrier ИНН ≥90%, plate ≥95% | — | ❓ замерить на SLAI golden |
| ttn: ИНН/plate ≥95%, вес ±1кг ≥95% | — | ❓ замерить на SLAI golden |

⚠️ **Оговорка:** наши фикстуры — digital-PDF→картинка (text-layer), не растровые сканы.
Финальный замер — на golden-set SLAI (Q9).

---

## I. 8 встречных вопросов (ТЗ §4) — все ✅ отвечены

| # | Вопрос | Ответ | Реализация |
|---|---|---|---|
| 1 | Multi-document PDF разделяете? | да | F5 ✅ splitter |
| 2 | Версионирование | add=compat, rename/del=v2 | ✅ принцип зафиксирован |
| 3 | Retry job_id | `POST /jobs/:id/reprocess` + F20 one-shot prompt | ✅ |
| 4 | OCR-only режим | `document_hint:"raw_ocr"` + F21 `GET /:id/raw-text` | ✅ |
| 5 | Языки (китайский для AliExpress) | rus+eng сейчас, F23 `chi_sim` | ✅ |
| 6 | Rate limit per token | 200/мин default, 600 для SLAI | ✅ |
| 7 | Длительные: polling или webhook | webhook + опц. `GET /jobs/:id` | ✅ |
| 8 | Storage retention при redact_pii | 30д default, F27 delete-after-success | ✅ |

---

## J. Сроки / фазы (ТЗ §10) и K. Out-of-scope (ТЗ §11)

- **Фазы:** ТЗ — 3 месяца на 3 фазы. Пилот WW-23, **старт 02.06** (сегодня), shadow → замер W3 → prod W4.
- **Out of scope (зона SLAI):** matcher (привязка к Transportation/Transfer), справочники, UI.
  ✅ разделение подтверждено (Q7). Мы отдаём данные+confidence, привязку делает SLAI.

---

## Остатки — что проверяем вместе

**Расхождения контракта (A) — решить, чинить или согласовать как есть:**
- [ ] `target_entity_hint` — в коде нет совсем. Нужен ли SLAI hint от нас, или матчат сами? (если нужен — это новая задача)
- [ ] `_normalized_fields` — top-level рядом с `extracted` (как в ТЗ) или ок внутри `extracted`?
- [ ] `raw_text_preview` (500 симв.) в payload — нужен, или хватает `GET /:id/raw-text`?
- [ ] `needs_review` отдельным boolean — нужен, или `status` достаточно?

**Полнота схем (C):**
- [ ] Пройти invoice / transport_request / ttn пофайлово против JSON-примеров ТЗ §3 — каждое поле на месте?

**Содержание (B):**
- [ ] Сверить наш ВЭД-8 с тем, что SLAI понимает под Фазой 2 (ТЗ их не перечисляет).

**SLA (E):**
- [ ] Throughput 5→60 doc/min — провести нагрузочный замер.
- [ ] Лимит страниц 10→30 — проверить обработку в коде.
- [ ] HEIC (нужен для прод-формата) — сейчас не принимаем (P0 в FILE_TYPES_SPEC).
- [ ] Availability — как меряем на Asha.
- [ ] Сканы (vision-path) вне SLA → включить hybrid-routing на Asha.

**Точность (H):**
- [ ] Замерить acceptance на golden-set SLAI (ждём 15 PDF, Q9).

**Блокеры пилота (операционка):**
- [ ] 🔴 S1 — webhook-secret от SLAI (просрочен с 30.05): без него outbound HMAC не подписать.
- [ ] 🔴 S2 — age-публичный ключ SLAI: чтобы зашифрованно отдать sandbox-токен.
- [ ] 🟢 Снять `BACKEND=stub` на Asha → реальная модель + флаги `BYO_LLM_ENABLED`/`FILE_URL_INGEST_ENABLED`/`HYBRID_ROUTING_ENABLED` (наш шаг).

**Заморожено (не для пилота):** multi-instance Суперлогист, EXT-C multi-tenant LLM-ключи, kb-docker corp-prod деплой.
