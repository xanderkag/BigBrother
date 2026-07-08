# Integration Queue — parsedocs ↔ SLAI

> **Очередь нерешённых вопросов и pending-задач интеграции.**
> При работе над parsedocs Claude **читает этот файл в начале сессии**,
> ищет блоки со статусом `ANSWERED` (есть ответ — надо что-то сделать) или
> `OPEN` (ждём ответ).
>
> Файл живёт в git → синхронизация между машинами и сторонами автоматическая
> (через `git pull`). SLAI зеркалит копию в `xanderkag/SLAI/docs/PARSDOCS_QUEUE.md`.

---

## Convention

Каждый вопрос — отдельный блок `### Q{N}. ...` со структурой:

```
### Q{N}. <короткое название>

- **Status:** `OPEN` | `ANSWERED` | `RESOLVED`
- **Asked:** YYYY-MM-DD
- **From:** USER | SLAI_DEV | CLAUDE | PARSDOCS_DEV
- **To:** USER | SLAI_DEV | CLAUDE | PARSDOCS_DEV
- **Что нужно:** короткое описание
- **Что сделать когда ответят:** action plan

#### Question / Context
<свободный текст>

#### Answer
<ответ когда придёт — Status переходит в ANSWERED>

#### Resolution
<что сделано + ссылка на commit — Status переходит в RESOLVED>
```

### Действия Claude по статусам

| Status | Что делать |
|---|---|
| `OPEN` (To: USER) | Напомнить пользователю в чате что вопрос ждёт ответа |
| `OPEN` (To: SLAI_DEV) | Если уже неделя — спросить пользователя, может стоит напомнить |
| `OPEN` (To: CLAUDE) | TODO для Claude — выполнить когда подходящая сессия |
| `ANSWERED` | **Обработать**: выполнить action plan, commit + push, перевести в RESOLVED |
| `RESOLVED` | Ничего; можно вычистить если старше 2 недель → переезжает в `INTEGRATION_LOG.md` |

---

## Active Questions

### Q-REDELIVER-1. Переотдача 30 «пустых» инвойсов webhook'ом (Q16 branch)

- **Status:** `OPEN` (To: PARSDOCS_DEV — реализовать batch-переотдачу; SLAI ack получен).
- **Asked:** 2026-07-08 (SLAI reply на сверку 2026-07-07)
- **From:** SLAI_DEV → PARSDOCS_DEV
- **Что нужно:** переотдать webhook для 30 инвойсов, которые до фикса 8192-токен cap отдавали ПУСТОЕ извлечение (Q16 §Context). Приём у SLAI **идемпотентный по `job_id`** — дублей не создаст, ручные правки не затрёт. Их выбор: не re-pull, а именно webhook-переотдача.
- **Что сделать:** (1) собрать список 30 `job_id` из БД (те commercial_invoice/invoice, что были пустые до батча 2026-06-30 и переобработаны qwen3.6:27b); (2) скрипт/CLI-вызов для re-delivery (использовать существующий webhook-sweeper или отдельный admin-endpoint); (3) переотдать; (4) пинг SLAI в чате «переотдано».
- **Связано:** Q16 (закрыт), `PARSDOCS_SVERKA_SLAI_2026-06-30.md` §2, `PARSDOCS_SVERKA_SLAI_2026-07-07.md` §5.B.

#### Resolution
<пусто — реализация переотдачи не готова>

---

### Q-HSCODE-1. `hs_code` как кросс-док match-ключ (commercial_invoice ↔ packing_list ↔ ГТД)

- **Status:** `DEFERRED` (backlog — sign-off SLAI 2026-07-08: полезно, но не в этот заход; отдельной итерацией после WW-23 демо, тогда и bump 1.3).
- **Asked:** 2026-06-30 (Q16 §branch) → повторно 2026-07-07 (сверка §5.C)
- **From:** PARSDOCS_DEV → SLAI_DEV
- **Ответ SLAI (2026-07-08):** «полезно для ВЭД-цепочки, но не сейчас. Отдельной итерацией после демо, тогда и bump 1.3.»
- **Что сделать когда переоткроем:** (1) HS-ключ в `_match_signals.hs_codes` для commercial_invoice + packing_list + customs_declaration (нужен свой projector или расширение generic); (2) bump `WEBHOOK_SCHEMA_VERSION` 1.2→1.3 (по политике Q17 MINOR); (3) обновить OpenAPI; (4) сообщить SLAI.
- **Связано:** Q16, Q17, Q18 (price_list — тот же кросс-док кластер).

#### Resolution
<отложено до после WW-23 демо; переоткрыть Q как только SLAI даст сигнал>

---

### Q-DOCSTAGE-1. Семантика `document_stage` — copy бывает часто (BL до 7 копий)

- **Status:** `RESOLVED` 2026-07-08 (heads-up SLAI, действий не требует — но полезно помнить в pipeline).
- **Asked:** 2026-07-07 (сверка §5.G)
- **From:** PARSDOCS_DEV → SLAI_DEV
- **Ответ SLAI (2026-07-08):** «В основном `original`, но `copy` реально бывает: по коносаментам до 7 копий на заказ. `draft` редко. Расширять enum не нужно, `copy` в потоке учитывать.»
- **Импликация для parsdocs:** матч-логика на нашей стороне не строится (это SLAI-side), но при повторных webhook-доставках одного и того же груза с `document_stage=copy` — не создавать дублирующий job (SHA-256 cache должен закрывать). Проверить, что при разных PDF-копиях с идентичным контентом cache-hit срабатывает. **Не обязательство сейчас — verify only.**
- **Связано:** schema 1.2 (`document_stage` в `_match_signals`), `MATCH_SIGNALS_SCHEMA_VERSION 1.0→1.1`.

#### Resolution
Ответ SLAI получен; enum не расширяется. Verify cache-hit при copy-документах — вошло в TECH_DEBT «copy-cache».

---

### Q-NEG-SECRET-1. Отдельный webhook_hmac_secret для `slai-negabarit`

- **Status:** `AWAITING-CHANNEL` (SLAI пришлёт secret безопасным каналом; после — applied в БД).
- **Asked:** 2026-07-07 (сверка §5.F)
- **From:** PARSDOCS_DEV → SLAI_DEV
- **Ответ SLAI (2026-07-08):** «Давайте заведём отдельный, так чище. Передадим безопасным каналом, не в переписке.»
- **Что сделать когда получим:** положить в `organizations.webhook_hmac_secret` для `slai-negabarit` (73d314a6-c6bf-4860-a910-548fb6040d65), убрать global env-fallback для этого tenant'а. Записать в SLAI_SECRETS_INBOX.
- **Связано:** Q-NEG-1 (RESOLVED 2026-06-01, base provisioning).

#### Resolution
<пусто — ждём secret от SLAI>

---

### Q-CUTOVER-1. Пилот WW-23 → cutover Asha на корп-прод parsdocs

- **Status:** `SCHEDULED-AFTER-DEMO` (SLAI reply 2026-07-08: точную дату назовут, как зафиксируют показ).
- **Asked:** 2026-07-07 (сверка §5.A)
- **From:** PARSDOCS_DEV → SLAI_DEV
- **Ответ SLAI (2026-07-08):** «Открытых багов за нами не держим. За cutover сразу после демо. Точную дату назовём, как зафиксируем показ.»
- **Что сделать когда получим дату:** (1) на прод parsdocs (kb-docker) — включить `HYBRID_ROUTING` + `FILE_URL_INGEST` заранее (SLAI разрешил включать когда удобно); (2) активировать `chat` + `embeddings` + `dadata` **одним пакетом** с пингом SLAI за 24-48ч до включения; (3) на нашей стороне — cutover-runbook (ключи, HMAC-секреты обоих sandbox'ов, webhook_url, backup Asha на N дней).
- **Связано:** SLAI_INTEGRATION_BACKLOG.md §3 (пилот), фича-флаги ROADMAP.md §Готово-но-выключено.

#### Resolution
<ждём дату демо от SLAI>

---

### Q19. `unrecognized` состояние + bump `schema_version 1.0 → 1.1` (аддитивно)

- **Status:** `RESOLVED` 2026-07-08 — финал: `document_type: "unknown"` литерал (не `null`), без отдельного флага `unrecognized`. SLAI подтвердил приём + hold-for-manual (SLAI reply 2026-07-08, наш commit `41a256a` + bump 1.2 `2264fbe`).
- **Asked:** 2026-07-01
- **From:** PARSDOCS_DEV
- **To:** SLAI_DEV
- **Что нужно:** SLAI подтверждает, что принимает `document_type: null` без падения и трактует `unrecognized: true` как «hold-for-manual / review», не как fail.
- **Что сделать когда подтвердят:** после деплоя webhook-поля + ack SLAI → RESOLVED с commit-ссылкой.
- **Связано:** Q17 (top-level `schema_version`, старт `1.0` — это первый MINOR-bump), Q16 (переотдача — исправленные типы придут на переотданных доках), CONTRACT_TECH_APPENDIX §4.5 (аддитив = back-compat), TECH_DEBT `LLM-CLASSIFIER (2026-07-01)` + `FILENAME-SIGNAL + DOC (2026-07-01)`. Note-док: `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md` (обновлён 2026-07-02: §4 — 4 новых значения `document_type`, `schema_version` не меняется).

> **2026-07-02 (note-only, heads-up без действия SLAI):** в каталог добавлено 4 новых типа (миграция `20260702000001`, задеплоено): `insurance_policy` + `safety_data_sheet` (реальные, могут прийти сейчас), `export_declaration` + `quality_certificate` (beta, предварительная схема). Это **новые значения строки `document_type`**, аддитивно — конверт и `schema_version` (`1.1`) не меняются. Heads-up вложен в §4 ноты `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md` (не отдельный Q-блок). SHOULD от SLAI: незнакомый `document_type` не роняет приём. Схемы полей — по запросу.

#### Question / Context
Классификация переработана: имя файла как weighted-сигнал + фикс regex АКТ (миграция `20260701000001`) + новый LLM-классификатор qwen3.6:27b (прогон на КАЖДОМ доке ~1s, выбор slug из ~38-типового каталога, fallback на keyword-классификатор при любой ошибке/таймауте — **никогда не роняет док**). `document_type` стал заметно точнее; пофикшены мис-классификации (Акт→`customs_declaration`, ТТН→`invoice`, УПД→`factInvoice`).

**Единственное реальное изменение контракта:** док, не подходящий ни под один тип каталога, раньше получал уверенно-неверный тип; теперь приходит как **`document_type: null` + новое опциональное top-level поле `unrecognized: true`** (осознанное «не опознан», present-only — только когда типа нет). Это НЕ ошибка обработки: док извлечён и доставлен нормально, просто без уверенного типа.

**Контракт-дельта:** `schema_version` бампается **1.0 → 1.1** — **аддитивно, back-compat** (одно новое опциональное поле + `document_type` может быть `null`). По политике Q17 это **MINOR** (SLAI логирует/замечает, не гейтит). Envelope `version` остаётся `"v1"`. Код SLAI формально может не меняться и не сломается, но SHOULD: (а) принимать `document_type: null` без падения / без форс-роутинга по типу; (б) трактовать `unrecognized: true` как hold-for-manual/review.

**Внутренняя наблюдаемость (НЕ контракт, FYI):** пер-документная метаданная классификации (`method` llm/keyword/filename/fallback, `duration_ms` ~1s, `candidates`, `confidence`) пишется в `jobs.classification` (jsonb) для нашего оператора — это **внутренний job-API, в webhook-payload её НЕТ**, SLAI её не видит и ничего не делает. Опционально можем позже отдать в вебхуке confidence-сигнал (hint авто-vs-ручная), если понадобится SLAI — не обязательство.

#### Что сделать когда подтвердят
1. **parsdocs (backend):** добавить в `WebhookPayload` опц. top-level `unrecognized?: true` + разрешить `document_type: null` для неопознанных, во всех местах сборки payload (`deliver.ts`, `routes/jobs.ts`, `webhook-sweeper.ts`, `webhook-delivery.ts`); bump константы `schema_version 1.0→1.1` (связано с Q17-внедрением top-level ключа). Тесты payload-shape (`unrecognized` present-only, `document_type` nullable). Commit → деплой → сообщить SLAI «задеплоено».
2. **SLAI (ждёт ответа):** подтвердить приём `document_type: null` + чтение флага `unrecognized` (hold-for-manual, не fail). Проверить, нет ли жёсткого допущения «`document_type` всегда непустой».

#### Resolution
<пусто — webhook-поле ещё не реализовано/не задеплоено; ждём ack SLAI>

---

### Q17. schema_version — drift-маркер состава `extracted` (отдельно от envelope `version`)

- **Status:** `RESOLVED` 2026-07-08 — SLAI начал читать top-level `schema_version` (reply 2026-07-08), подтвердил трактовку: MINOR/PATCH логируем, MAJOR гейтим. Уже добавили лог на матчере, добавляют и на приёме. Текущее значение на проде — `"1.2"` (commit `2264fbe`).
- **Asked:** 2026-06-30 (микро-сверка SLAI, Q1)
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / SLAI_DEV
- **Связано:** webhook v1 (`src/webhooks/deliver.ts` — top-level `version: 'v1'`), `src/pipeline/normalize/match-signals.ts` (`MATCH_SIGNALS_SCHEMA_VERSION = '1.0'`, скоупит ТОЛЬКО `_match_signals`, не весь `extracted`), CONTRACT_TECH_APPENDIX §4.5. Ответ: `PARSDOCS_REPLY_TO_SLAI_SVERKA_2026-06-30.md`.

#### Question / Context
SLAI валидируют envelope `version` (принимают только `v1`). Сегодня parsdocs **НЕ** шлёт отдельный top-level `schema_version` (verified в коде: `version: 'v1'` стоит в `deliver.ts`/`routes/jobs.ts:1119`/`webhook-sweeper.ts:79`/`webhook-delivery.ts:126`; отдельного `schema_version` на верхнем уровне нет). Существующий `_match_signals.schema_version = "1.0"` скоупит **только проекцию match-сигналов**, не полный состав `extracted`. → Дрейф состава `extracted` (новые/переименованные поля, новые типы) сегодня **ничем не маркируется**. SLAI просят явный маркер, чтобы детектить дрейф, а не молча ломаться. Их вопрос: бампать envelope `version` ИЛИ отдельный `schema_version` — что удобнее на нашей стороне?

#### Решение (sign-off Александра 2026-06-30)
- **Принят отдельный top-level `schema_version`** (НЕ bump envelope `version`).
- Envelope `version` остаётся `"v1"` под транспорт (HMAC/заголовки/форма конверта/retry) — **НЕ** бампается на изменения состава полей.
- Ключ: `schema_version`, **top-level** payload (semver-lite `MAJOR.MINOR`), рядом с `version`/`document_type`, **НЕ** внутри `extracted` — дрейф виден до парсинга тела. Текущее значение `"1.0"`. **Внедряется сейчас** — SLAI может начинать читать.
- Bump-политика: **MINOR** (`1.0→1.1`) = аддитивно (§4.5 back-compat) → SLAI логирует/замечает; **MAJOR** (`1.x→2.0`) = ломающе (rename/del) → SLAI hard-gate; обе версии параллельно ≥ 6 мес.
- Старт: top-level `schema_version = "1.0"` на включении как базовая точка (маркер отслеживает дрейф «с этого момента», прошлую историю задним числом не версионируем). Дельта этой сессии (price_list + commercial_invoice) **входит в базовую `1.0`**.
- Top-level `schema_version` — единый источник версии состава; `_match_signals.schema_version` продолжает версионировать проекцию сигналов независимо (при желании SLAI — синхронизируем по MAJOR, для старта не требуется).

#### Что сделать
1. **SLAI ack:** начать читать top-level `schema_version` для drift-детекта + подтвердить трактовку MINOR=log / MAJOR=gate.
2. **parsdocs (backend):** ввести `schema_version` в `WebhookPayload` (`deliver.ts`) + во все 4 места сборки payload (`routes/jobs.ts`, `webhook-sweeper.ts`, `webhook-delivery.ts`), константа версии, старт `"1.0"`. Тесты payload-shape. Commit → RESOLVED. Envelope `version` НЕ трогать.

#### Resolution
<в реализации backend; RESOLVED после внедрения ключа + commit-ссылки. Ждём ack SLAI (чтение ключа).>

---

### Q18. price_list — enrichment vs полноценная матч-сущность (бизнес-назначение)

- **Status:** `DEFERRED` (backlog — sign-off Александра 2026-06-30: price_list **пока НЕ нужен как сущность**; хранить карточкой достаточно, SLAI ничего не строит. Переоткрыть по реальной потребности.)
- **Asked:** 2026-06-30 (микро-сверка SLAI, Q2)
- **From:** SLAI_DEV
- **To:** —
- **Связано:** миграция `20260630000001` (price_list), сверка `PARSDOCS_SVERKA_SLAI_2026-06-30.md` §3.1 (HS-линковка отложена), Q16 (price_list.hs_code как richer extraction, не match-ключ). Ответ: `PARSDOCS_REPLY_TO_SLAI_SVERKA_2026-06-30.md`.

#### Question / Context
`price_list` — новый тип, SLAI его пока не парсят → приходит карточкой без маппинга. Спрашивали: нужен ли им как сущность/обогащение (конкретно `price_list.hs_code` → втянуть в сверку ТН ВЭД), или хранить карточкой достаточно?

#### Решение (sign-off Александра 2026-06-30 — DEFERRED)
**price_list НЕ нужен как сущность сейчас — паркуем в беклог.** Бизнес-цель документа в матчинге не закреплена; не коммитим SLAI на постройку обработки под цель, которой ещё нет. SLAI: храните карточку как есть, ничего строить не нужно. HS как кросс-док match-ключ (прайс ↔ ГТД ↔ инвойс) остаётся отложенным (та же «HS-линковка» сверки §3.1). Контракт под price_list не расширяется, `schema_version` из-за него не бампается.

**Условие переоткрытия:** если/когда у SLAI появится конкретный сценарий, где price_list должен матчиться к заказу/договору/ГТД по позициям/HS — переоткрыть Q18 и завести отдельной фичей (HS-ключ в `_match_signals` у источников + bump `1.0→1.1` + работа на обеих сторонах, связано с Q17).

#### Resolution
<отложено в беклог по решению Александра 2026-06-30; код не трогается (карточка уже отдаётся). Re-open при реальной потребности.>

---

### Q16. commercial_invoice.containers[] не доходит до `_match_signals` + сверка 2026-06-30

- **Status:** `RESOLVED` 2026-07-08 — (1) наш собственный projector для `commercial_invoice` с `collectContainers()` в проде (commit `2264fbe`, `src/pipeline/normalize/match-signals.ts:388-401`); SLAI подтвердил чтение (reply 2026-07-08). (2) Развилка переотдачи 30 пустых инвойсов — SLAI попросил webhook-переотдачу по списку `job_id` (идемпотентно), в работе (см. новый Q-REDELIVER-1). (3) `hs_code` как кросс-док match-ключ — отложен до после WW-23 демо (см. новый Q-HSCODE-1).
- **Asked:** 2026-06-30
- **From:** PARSDOCS_DEV
- **To:** CLAUDE / SLAI_DEV
- **Связано:** PD-CONTRACT-1 §2.1, `src/pipeline/normalize/match-signals.ts`, миграции `20260630000001` (price_list) + `20260630000002` (commercial_invoice). Сверка: `PARSDOCS_SVERKA_SLAI_2026-06-30.md`, сообщение SLAI: `PARSDOCS_TO_SLAI_2026-06-30_SVERKA_MSG.md`.

#### Question / Context
Сессионный аудит извлечения 2026-06-30: новые поля живой схемы.
- **price_list** (мигр. `...0001`): header `incoterms`/`contract_ref`/`supplier_address`; items[] `hs_code`/`country_of_origin`/`brand`/`manufacturer`/`model`/`description`.
- **commercial_invoice** (мигр. `...0002`): `buyer.inn`/`buyer.kpp`, `containers[].number`, `total`/`total_with_vat`.
- Модель извлечения переключена phi4 14B → **qwen3.6:27b** (98.3% golden vs 88.3%, fast-mode `reasoning_effort:"none"`, MODEL_REPORT #36). Контракт не меняется — выше fill-rate.
- ~24% боевого корпуса (30/32) раньше отдавали ПУСТОЕ извлечение (8192-токен cap) — переобработаны, теперь полные сигналы. 2 near-dup инвойса остаются пустыми.

**Дельта контракта `_match_signals` (verified в коде):**
`PROJECTORS.commercial_invoice = PROJECTORS.invoice` (alias), invoice-проектор **не вызывает** `collectContainers()`, generic fallback тоже. → `commercial_invoice.containers[].number` **НЕ** проецируется в `_match_signals.containers`. Разрыв линковки commercial_invoice ↔ B/L ↔ packing_list ↔ ГТД по грузовой единице. Остальные новые match-кандидаты (`buyer.inn/kpp`, `total/total_with_vat`) — **уже** проецируются. `price_list.hs_code` — richer extraction, не match-ключ (HS-линковка = отдельная фича + bump 1.0→1.1, отложено до ack SLAI).

#### Что сделать когда подтвердят
1. **parsdocs (backend):** добавить `collectContainers()` в проектор семейства invoice (или дать `commercial_invoice` обёртку invoice-логика + контейнеры). Хелпер уже есть (B/L/TTN/CMR/Акт). `schema_version` **НЕ** меняется (ключ `containers` уже в 1.0, расширяется только множество типов-источников). Обновить `tests/match-signals.spec.ts` (кейс commercial_invoice + containers). Commit → перевести в RESOLVED.
2. **SLAI (развилка, ждёт ответа):** (a) переотдача «пустых» доков — re-pull самим (`GET /jobs/:id`) или мы переотдаём webhook по списку `job_id`? (b) нужен ли `hs_code` как кросс-док match-ключ (тогда 1.0→1.1, работа на обеих сторонах)?

#### Resolution
<пусто — фикс ещё не сделан>

---

### Q-EXT-CLASS. Новые типы документов (создание сделано; осталась доводка)

- **Status:** `OPEN` (To: CLAUDE)
- **Asked:** 2026-06-21
- **From:** PARSDOCS_DEV
- **To:** CLAUDE / SLAI_DEV
- **Что нужно:** Расширение каталога типов под ВЭД/логистику. **Создание типов EXT-CLASS-1/2/3 ВЫПОЛНЕНО** (все 8 slug'ов в проде, см. ниже). Осталась **доводка существующих типов**: тюнинг классификатора `waybill` + тюнинг `commercial_invoice` под ВЭД — обе правки ждут реальных PDF от SLAI. Детальные spec-блоки — ниже (Q-PERMIT-1 расширенная схема `special_permit`, Q-CLASS-MATRIX).
- **Что сделать:** каждый новый тип уже = 1 seed-миграция (рецепт отработан); по доводке `waybill`/`commercial_invoice` — согласовать со SLAI, какие поля они читают, и калибровать на их образцах.

#### Сделано (создание типов)
Все 8 EXT-CLASS-типов созданы и задеплоены на прод (миграции `20260621000002/3/4`), каталог = **38 активных типов**:
- `special_permit` (Росавтодор), `booking_request` (клон `transport_request`, `requestor.kind=forwarder`).
- `awb` (Air Waybill), `manifest`, `phytosanitary_certificate`, `veterinary_certificate`.
- `cim`, `smgs` (международные ж/д).

#### Осталось (доводка существующих типов — ждёт PDF от SLAI)
- **Тюнинг классификатора `waybill`** — чтобы не падал в unknown/ttn на реальных хитах (Q-CLASS-MATRIX §6, ждёт 1-2 PDF).
- **Тюнинг `commercial_invoice` под ВЭД** — incoterms / hs_code / country_of_origin / customs_value (ждёт PDF с ВЭД-полями).
- **Расширенная extraction-схема `special_permit`** — slug создан, поля расширяем по Q-PERMIT-1 (ждёт 1-2 PDF Росавтодора, W24).

#### Интеграционные заметки (актуальное на 2026-06-23)
- **Каталог типов = 38 активных в проде** — создание новых типов закрыто (4 складских миграцией `20260621000001` + 8 EXT-CLASS миграциями `20260621000002/3/4`), задеплоено + проверено вживую.
- **Дефолт-модель извлечения = `phi4`** (бенч 2026-06-18: 91% против mistral 48%; фикс мис-ярлыков сторон ТТН/CMR). Все типы на `parser_kind=llm_extract`.
- **Акт-lockstep с SLAI ЗАКРЫТ с обеих сторон** — projector `services_act` в `_match_signals` (party_a→`executor`, party_b→`customer`); SLAI читает `executor`+`customer` по ИНН.

---

### Q-DADATA-1. DaData passthrough в LLM-gateway (третий внешний канал)

- **Status:** `ANSWERED` (spec OK; задеплоен на прод 2026-06-23 `6532be5`, **спит за флагом `dadata` (`enabled=false` → `503`)**) — ждём включения флага + cutover SLAI после WW-23 демо (в пакете с активацией chat/embeddings)
- **Asked:** 2026-06-XX (SLAI PM, follow-up к LLM-gateway)
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV
- **Связано:** EXT-LLM-GATEWAY-DADATA в ROADMAP.md.

**Что просят:** добавить в наш gateway `POST /v1/dadata/findById/party`
(+ опц. `/v1/dadata/suggest/party`) как тонкий passthrough к
`suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party`. SLAI шлёт
только их PAT, мы подставляем `Authorization: Token <DADATA_API_KEY>`.
По той же схеме что chat/embeddings — централизация ключей у parsdocs.

**ETA:** ~1-2 часа (тонкий passthrough, DaData geo-доступен с Asha, нет
проблемы Anthropic/OpenAI с outbound-блоком).

**Контракт:**
- Headers от SLAI: `Authorization: Bearer pdpat_<тот же что для /jobs>`
- Body: DaData-native verbatim (`{"query":"<ИНН>", "type"?, "count"?, ...}`)
- Response: DaData-native verbatim (`{"suggestions":[{value, data:{inn,kpp,ogrn,okved,name,address,management,state,...}}]}`)
- Ключ: env `DADATA_API_KEY` ИЛИ `provider_settings.kind='dadata'` (как у Anthropic/OpenAI fallback)
- Usage-log в `llm_gateway_usage` с alias `dadata-findById`/`dadata-suggest`

**Статус кода:** DaData-passthrough влит в `main` (merge github→main, 2026-06-23 `6532be5`) вместе с Anthropic-бэкендом шлюза и `/v1/embeddings` и **задеплоен на прод** (api/worker пересобраны). Эндпоинт `/v1/dadata` **спит за флагом `dadata` (`enabled=false`)** — отдаёт `503` fail-closed.

**Действие после демо:** включить флаг + активировать в пакете с chat/embeddings для единого cutover'а.

---

### Q-PERMIT-1. special_permit (Росавтодор) — extraction-схема для негабарит-перевозок

- **Status:** `ANSWERED` (spec frozen) — SLAI подтвердил все 3 уточнения 2026-06-XX,
  ждём 1-2 реальных PDF после встречи их с клиентом, потом impl в W24.
- **Asked:** 2026-06-XX (SLAI PM, classifier roadmap follow-up)
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV
- **Связано:** EXT-CLASS-1 в ROADMAP.md / Q-EXT-CLASS.
- **Action plan (когда стартуем EXT-CLASS-1):**
  1. Добавить новый slug `special_permit` в DB + EXTENDED_SCHEMAS со
     своим SPECIAL_PERMIT_SCHEMA (top-level, не вложен в transport.*).
  2. Расширить TRANSPORT-схему: `permit.valid_from`, `permit.restrictions`,
     `route.waypoints[]` (массив строк как в PDF), `cargo.axle_loads_kg[]`,
     `cargo.dimensions.{length_cm,width_cm,height_cm}` КАК ДУБЛИКАТ к
     метрам (cm обязательны — SLAI код-путь читает именно `*Cm`-поля
     `CargoUnit.lengthCm/widthCm/heightCm`).
  3. **escort.type ENUM из SLAI 1:1** (kebab-case, не snake!):
     `'gibdd' | 'cover-vehicle' | 'pilot-driver' | 'none'`. Поле у них
     `transfer.customFields.escortType`. Перекодировка не нужна.
  4. P0-минимум для матчера (если что-то нестабильно): `permit_number` +
     `permit_valid_until` + `vehicle.plate` (тягач). Остальное human-
     in-loop.
  5. `_normalized_fields` для permit: `permit.number` (uppercase+trim),
     `vehicle.plate` (canonical РФ-номер) — критичны для SLAI
     `matcher.phase='permit'` (новая фаза, по аналогии с cmr/declaration).
  6. Vision-llm path обязателен (сканы/печати Росавтодора).
  7. Калибровка regex/LLM-prompts на 1-2 реальных PDF после встречи.

**Контекст:** SLAI просит поднять `special_permit` с классификации до
полноценной extraction-схемы (P0 для первого негабарит-авто РФ клиента).
Без авто-полей фишка «приложил → распозналось» на ключевом документе не
работает.

**Поля (с маппингом на наши существующие):**

| SLAI поле | Наш путь | Статус |
|-----------|----------|--------|
| `permit_number` | `transport.permit.number` (уже в TTN/invoice) | ✅ переиспользуем |
| `permit_valid_from` | НОВОЕ — добавить в `transport.permit.valid_from` | ❌ дельта |
| `permit_valid_until` | `transport.permit.valid_to` | ✅ |
| `issuing_authority` | `transport.permit.issued_by` (есть Росавтодор/Ространснадзор/ЦОДД enum) | ✅ |
| `vehicle_plate` (тягач) | `vehicle.plate` | ✅ |
| `vehicle_plate` (трал) | `vehicle.trailer_plate` | ✅ |
| `route.from`, `route.to` | `transport.route.from`, `transport.route.to` | ✅ |
| `route.waypoints[]` | НОВОЕ — массив именованных точек | ❌ дельта |
| `cargo_dimensions.length_cm/width_cm/height_cm` | `transport.cargo.dimensions.{length_m, width_m, height_m}` (у нас метры) — добавим unit alias или вернём оба | ⚠️ unit |
| `cargo.total_weight_kg` | `transport.cargo.weight_kg` | ✅ |
| `cargo.axle_loads_kg[]` | НОВОЕ — массив нагрузок по осям | ❌ дельта |
| `cargo.axles_count` | `vehicle.axles` | ✅ |
| `escort_required` | `transport.escort.required` | ✅ |
| `escort_type` enum {ГИБДД, прикрытие, пилот-авто, нет} | `transport.escort.type` (был string, добавим enum) | ⚠️ enum |
| `restrictions` | НОВОЕ — `transport.permit.restrictions` text | ❌ дельта |

**Покрытие:** 11 из 14 полей уже работают через переиспользование. Дельта:
4 новых поля (`valid_from`, `waypoints[]`, `axle_loads_kg[]`, `restrictions`)
+ 2 тюнинга (`dimensions` cm-alias, `escort_type` enum).

**Ответы на вопросы SLAI:**

**(a) ETA:** **2-2.5 дня** одним разработчиком (входит в EXT-CLASS-1 в
ROADMAP). Большую часть — за счёт переиспользования. Старт после
стабилизации WW-23 пилота.

**(b) Vision-режим на сканах/печатях:** у нас 3-engine OCR pipeline
(`pdf-text` → `tesseract` → `vision-llm`) с автоматическим cascade'ом.
Vision-LLM (Qwen-VL / Anthropic Sonnet) **специально подбирается под
сканы и штампы Росавтодора**. По нашему bench v3 — точность полей 98.3%
на vision-path. **Минимально-надёжный набор P0 если что-то промахивается:**
`permit_number`, `permit_valid_until`, `vehicle_plate` — критичные для
матчера. Остальные — добиваются human-in-loop в SLAI карточке.

**(c) Маршрут — минимум:** для start'а возьмём `route.from` + `route.to`
+ `route.waypoints[]` (массив строк именованных точек как они написаны
в PDF). Парсинг полного маршрута со всеми участками — тюним по
калибровке на реальных образцах (Q-CLASS-MATRIX §6 — ждём 1-2 PDF).

**Что нужно от SLAI:**
- 1-2 реальных разрешения Росавтодора (с замазанным PII, формулировки
  блоков «Маршрут», «Габариты», «Нагрузки по осям», «Сопровождение»,
  «Особые условия» оставить живыми) — после их встречи с клиентом.

---

### Q-CLASS-MATRIX. Расширение classifier'а под roadmap SLAI (P0/P1/P2 матрица типов перевозок × документов)

- **Status:** OPEN (To: SLAI_DEV)
- **Asked:** 2026-06-XX (SLAI PM, classifier roadmap message)
- **From:** SLAI_DEV → PARSDOCS_DEV
- **Связано:** EXT-CLASS-1/2/3 в ROADMAP.md.

**Что прислал SLAI:** roadmap классификатора на 3 квартала с типами:
P0 (waybill / TN / special_permit), P1 (BL / AWB / CIM / SMGS / manifest),
P2 (commercial_invoice ВЭД / packing_list / cert_of_origin / phyto / vet).

**Что у нас уже зарегистрировано** (38 active document types на
vanga.sls24.ru): `waybill`, `bill_of_lading` (BL_SCHEMA полная от
2026-06-04), `commercial_invoice`, `packing_list`, `cert_of_origin`,
`transport_request`, плюс созданные EXT-CLASS slug'и `special_permit`,
`booking_request`, `awb`, `manifest`, `phytosanitary_certificate`,
`veterinary_certificate`, `cim`, `smgs` (миграции `20260621000002/3/4`,
задеплоены). Из исходного gap-листа SLAI создано **всё кроме `TN`** —
`TN` (форма 2013) остаётся открытым вопросом, см. §(d). `booking_request`
заведён отдельным slug'ом — мы фактически разделили его с
`transport_request` (см. §(c)).

**Что ждём от SLAI:**

1. **§(a):** создание EXT-CLASS-типов выполнено (все 8 slug'ов в проде,
   38 типов). Осталась доводка `waybill`/`commercial_invoice` под их
   реальные образцы (см. §6) — нужен ack, что приоритеты не сдвинулись.
2. **§(b):** beta-доступ не делаем — добавлены в main без флагов (сделано).
3. **§(c):** `transport_request` (заявка от заказчика к экспедитору) vs
   `booking_request` (экспедитор → перевозчик плеча) — **мы разделили**
   (`booking_request` заведён отдельным slug'ом, наш голос был разделять).
   Нужно подтверждение SLAI, что разделение совпадает с их сущностями в БД.
4. **§(d) КРИТИЧНО:** TN (форма 2013) vs TTN — отдельно держать или
   мерджить с TTN? У SLAI разные сущности по нормативке. Жду решение.
5. Полная матрица «тип перевозки × документы» — обещали прислать
   отдельным файлом. Поможет приоритизации P1/P2 (AWB vs CIM vs phyto
   что важнее).
6. **Образцы для калибровки** когда дойдём до P1/P2:
   - 1-2 PDF waybill (если classifier на их хитах падает в unknown/ttn)
   - 1 PDF commercial_invoice / packing_list / cert_of_origin (если
     текущие schemas промахиваются на ВЭД-полях)
   - 3-5 PDF AWB и CIM/SMGS перед EXT-CLASS-2/3

**Case-конвенция (вопрос §(d) случай букв):** уже решено outbound в нашем
коде через `OUTBOUND_SLUG_ALIASES`: `TTN→ttn`, `UPD→upd`, `UKD→ukd`,
`CMR→cmr`, `AKT→services_act`, `factInvoice→tax_invoice`. В webhook
payload приходит только lowercase snake_case. Если видят uppercase —
протекает в обход нормализации, нужен `job_id` для диагностики.

---

### Q-NEG-1. Второй sandbox-тенант для negabarit-стенда

- **Status:** RESOLVED 2026-06-01
- **Asked:** 2026-06-01 (SLAI)
- **Provisioned:** 2026-06-01 on Asha
- **From:** SLAI_DEV → PARSDOCS_DEV

```
organization_id : 73d314a6-c6bf-4860-a910-548fb6040d65
token_name      : slai-negabarit-bot
webhook_url     : https://negabarit.sls24.ru/api/v1/parsdocs/webhook
expires         : 90 дней
```

Plain token доставлен в чат. webhook_hmac_secret для negabarit — пока
пустой (используется global env-fallback); SLAI должна решить нужен ли
отдельный secret под этот endpoint.

---

### Q12. EXT-D — Pre-upload signed URL ingestion

- **Status:** IMPLEMENTED (код + тесты, не задеплоен; ждёт `FILE_URL_INGEST_ENABLED=true` + интеграции SLAI. RESOLVED после деплоя.)
- **Asked:** 2026-05-26
- **From:** SLAI_DEV (`slai-response-to-parsdocs-2026-05-26.md`)
- **To:** PARSDOCS_DEV
- **Что нужно:** принимать файл по URL (`POST /jobs {file_url, ...}`) вместо
  multipart — снимает 50MB-bottleneck на больших фрахт-документах.
- **Что сделать:** скачать с URL внутри upload-handler (sha256-verify,
  size-cap, mime-sniff), дальше нормальный pipeline. ~1 день.

#### Question / Context
SLAI у себя планирует pre-upload в свой blob (signed URL), затем
передавать parsdocs ссылку. Снимает зависимость от multipart-лимита и
позволяет дедупить на их стороне до отправки нам.

#### Реализация (2026-05-26)
`POST /api/v1/jobs` принимает `file_url` (+опц. `file_sha256`) вместо multipart;
server-side download → обычный pipeline (magic-bytes, SHA-dedup, job). SSRF-защита
в `src/pipeline/ingest/url-fetch.ts`: scheme-whitelist `http(s)`, блок private/
loopback/link-local/metadata/CGNAT IP **до** сетевого запроса (любой приватный
A-record), no-redirect, mid-stream byte-ceiling, опц. allowlist
`FILE_URL_ALLOWED_HOSTS`, sha-mismatch. Коды `FILE_URL_*`, флаг
`FILE_URL_INGEST_ENABLED` (default off, fail-closed). Тесты
`tests/file-url-ingest.spec.ts` (27, network/dns замоканы). Webhook v1 не тронут.

---

### Q11. EXT-B — BYO LLM credentials через X-LLM-* заголовки

- **Status:** IMPLEMENTED (код + тесты `808e5cb`; ждёт деплоя + `BYO_LLM_ENABLED=true`. RESOLVED после интеграции SLAI)
- **Asked:** 2026-05-26
- **From:** SLAI_DEV (`slai-response-to-parsdocs-2026-05-26.md`)
- **To:** PARSDOCS_DEV
- **Что нужно:** parsdocs принимает per-request заголовки `X-LLM-Provider`,
  `X-LLM-Api-Key`, `X-LLM-Model`, `X-LLM-Base-Url`. Использует их для
  этого job вместо default из `provider_settings`. Ключ — никогда в логах,
  events, audit, last_llm_call.
- **Что сделать:** withForceProvider-эквивалент через AsyncLocalStorage
  (паттерн уже есть), redaction в trace-логике, ENV-флаг `BYO_LLM_ENABLED`,
  метрики `extractor_llm_credentials_supplied_total{provider}` и
  `extractor_llm_provider_errors_total{provider, code}`. 1-2 дня.

#### Question / Context
Контракт и детали — `EXT_B_BYO_LLM_TZ.md`. Кратко: SLAI (наш микросервис) шлёт
свой Anthropic-ключ per-request, parsdocs не настраивает свой. Не коммерческая
модель. Exit: снимаем когда parsdocs заведёт свои LLM-контракты.

---

### Q10. EXT-A — GET /capabilities + X-Extractor-Signature alias

- **Status:** IMPLEMENTED (код `d798917` + тесты `808e5cb`; RESOLVED после деплоя + contract-test SLAI)
- **Asked:** 2026-05-26
- **From:** SLAI_DEV (`slai-response-to-parsdocs-2026-05-26.md`)
- **To:** PARSDOCS_DEV
- **Что нужно:**
  1. `GET /api/v1/capabilities` → `{adapter:'parsdocs', contractVersion:'1',
     supportedDocumentTypes:[...slugs], maxFileMB:50, webhookSupported:true}`.
     Polling всегда доступен (явно не флагается).
  2. Outbound webhook подписывается `X-Extractor-Signature: sha256=<hex>`
     как alias к существующему `X-DocService-Signature`. Старый заголовок
     не убираем (back-compat).
- **Что сделать:** новый route, переиспользовать `documentTypeResolver`
  для списка типов и `config.version` (EPIC-7) для contractVersion. В
  webhook-delivery добавить второй заголовок (тот же HMAC). ½ дня.

#### Question / Context
Без этого SLAI не может написать contract-test для своего
`ParsdocsAdapter` в их новом `ExtractorGateway`. Разблокирующий минимум —
делать первым.

---

### Q13. AC9 — Sandbox-тенант формат изоляции

- **Status:** ANSWERED 2026-05-29 (SLAI FOLLOWUP)
- **Asked:** 2026-05-26 (наш ответ EXT)
- **From:** PARSDOCS_DEV
- **To:** SLAI_DEV
- **Что нужно:** определить параметры sandbox-тенанта для contract-test'ов
- **Action plan:** после P0 deploy → `INSERT INTO organizations` (separate),
  `INSERT INTO personal_access_tokens` (60 req/min, 7d retention) →
  envelope-encrypt token → положить в `SLAI_SECRETS_INBOX.md` (блок S2)

#### Answer (2026-05-29, SLAI FOLLOWUP)
- (1) separate organization
- retention 7d
- rate-limit 60 req/min
- Канал передачи токена нам→SLAI: `SLAI_SECRETS_INBOX.md` (envelope-encrypted PR)

---

### Q9. ТЗ от SLAI v1.0 — 18 типов документов, 8 open questions, golden dataset

- **Status:** ANSWERED 2026-05-29 (SLAI FOLLOWUP §Q9, ETA 2026-06-02..04)
- **Asked:** 2026-05-17
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / USER

#### Answer (2026-05-17, SLAI_DEV)
Прислано полное ТЗ — `doc-service/docs/SLAI_TZ_v1_2026-05-17.md`. 12 секций:
- 10 типов документов в Фазе 1 + 8 ВЭД в Фазе 2 (3 месяца работы)
- Контракт JSON v1 + per-field confidence + normalized fields
- Acceptance критерии: критичные поля ≥ 95%, остальные ≥ 80%
- SLA: ≤ 90 сек/doc MVP, ≤ 30 сек прод
- Golden dataset `~/Desktop/SLAI/test-docs/` — 15 PDF + 15 .gt.json
- 8 встречных open questions к нам

#### Resolution (2026-05-17, parsdocs)
Файл-ответ: `doc-service/docs/PARSDOCS_REPLY_TO_SLAI_TZ.md`.

**Ответы на 8 questions:**
1. Multi-document PDF — F5 в roadmap (14 дней), workaround делить на SLAI
2. Versioning — add=compat, rename/del=v2, 1 мес preview, 6 мес legacy
3. Retry — есть `POST /jobs/:id/reprocess` для пересчёта + новый F20 для one-shot prompt
4. OCR-only — `document_hint: "raw_ocr"` + F21 `GET /:id/raw-text`
5. Языки — rus+eng сейчас, F23 китайский (1 час) для AliExpress
6. Rate limit — 200 req/min default, для SLAI 600 (10× запас)
7. Длительные — webhook прилетит когда готов, polling через `GET /jobs/:id` опционально
8. Storage — 30 дней default, `redact_pii` не удаляет файл, можем F27 для delete-after

**Gap по типам:** 3 новых типа нужно создать
- F16: `transport_request` (заявка на перевозку)
- F17: `transport_invoice` (новая ТН 2013)
- F18: `waybill` (путевой лист)

**Gap по полям:**
- F19: bank/bik/account в invoice schema (1 день)

**Sync slug'ов** — F22 case-insensitive lookup (1 час).

**Блокер:** ждём golden dataset (15 PDF) — без него не запустим baseline.
Запросили scp / Yandex.Disk / положить в репо. См. секцию 5 в PARSDOCS_REPLY_TO_SLAI_TZ.md.



### Q4. Service-token для SLAI side

- **Status:** ANSWERED 2026-05-29 (SLAI FOLLOWUP §Q4, ETA secret 2026-05-30)
- **Answer:** callback URL `https://api.demo.sls24.ru/api/v1/parsdocs/webhook`,
  HMAC secret SLAI генерирует (`openssl rand -hex 32`), передаст через
  `SLAI_SECRETS_INBOX.md` (блок S1) envelope-encrypted PR. ETA 2026-05-30.
- **Action plan:** ждём envelope в S1 → расшифровать → положить в
  `provider_settings` (encrypted-at-rest) или env `SLAI_WEBHOOK_SECRET` →
  включить F3 webhook-receiver.
- **was-OPEN:** asked 2026-05-16, ANSWERED 2026-05-29 (13 дней).
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Решение когда генерить и передать SLAI dev сервис-токен (`API_KEYS_JSON`) для аутентификации их вызовов к нам
- **Что сделать когда ответят:**
  1. Сгенерить ключ через `openssl rand -hex 32`, добавить в `API_KEYS_JSON={"<key>":"slai"}` на staging
  2. Сгенерить также `SLAI_TO_PARSDOCS_HMAC_SECRET` для подписи их webhook'ов к нам (см. Q6 ответ 5)
  3. Отправить SLAI через защищённый канал (1Password / signal / encrypted email)
  4. Зафиксировать дату ротации (через 6 месяцев)

---

### Q5. ETA пилота с реальными документами

- **Status:** ANSWERED 2026-05-29 (SLAI FOLLOWUP §Q5: **WW-23, start 2026-06-02**)
- **Plan:** W1 (WW22) подготовка → **W2 (WW23, 02-06.06) пилот старт** —
  parsdocs шлёт первую дюжину webhook'ов, SLAI shadow-mode → W3 (WW24)
  замер AC §B.4 + diff vs ручная привязка → W4 (WW25) prod rollout при метриках.
- **Action plan parsdocs до 2026-06-02:** (a) P0 ROADMAP-deploy (API_KEY +
  deploy-parsdocs.yml), (b) получить HMAC secret из S1, (c) поднять
  sandbox-тенант (Q13/AC9), (d) confirm callback URL `api.demo.sls24.ru`.
- **was-OPEN:** asked 2026-05-16, ANSWERED 2026-05-29 (13 дней).
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Когда планируется развернуть всё и начать получать реальные PDF от логистов
- **Что сделать когда ответят:**
  - **Сегодня-неделя** → F11 + F12 + F13 (cost tracking + dedupe + sync receiver)
  - **2-3 недели** → + F5 (multi-doc PDF) + F2 (per-field confidence)
  - **Месяц+** → широкий пакет + пересмотр моделей через bench

---

## Resolved Questions (сжато; переписка — в `archive/`)

| Q | Тема | Итог |
|---|------|------|
| Q1 | ANTHROPIC_API_KEY для baseline bench | RESOLVED 17.05 — прогон Sonnet 4.6 на 10 синт. PDF ($0.0165/doc, 9/10 valid JSON, items_F1 70%), `MODEL_REPORT.md` #21; нашли F14/F15. |
| Q7 | SLAI matcher / target_entity_hint / HMAC | RESOLVED 17.05 — matcher устраивает (сигналы plate/ИНН, threshold HIGH≥70+2×, timing-safe HMAC, auto-detect hint); 3 nice-to-have до пилота. `archive/PARSDOCS_Q7_MATCHER_REVIEW.md`. |
| Q8 | 7 вопросов по continuous category sync | RESOLVED 16.05 — receiver `/sync/nomenclature`+`/snapshot`, Redis TTL 24ч, 2 HMAC, `X-SLAI-Version: v1`, retry+`sync_inbox`. `archive/PARSDOCS_CATEGORY_SYNC_REPLY.md`. |
| Q2 | SLAI ответ на наш reply | RESOLVED 16.05 — **все 14 [ПРОДУКТ]-решений + 6 наших ответов приняты** (4 уже в коде SLAI: target_entity_hint, timing-safe HMAC, redact_pii, scoring). Ждут нашей доставки F5 multi-doc + F2 confidence. `SLAI_REPLY_v2.md` (`296b2b9f`). |
| Q3 | Hist категорий номенклатуры | RESOLVED 16.05 — endpoint `GET /admin/nomenclature/hist` (SLAI `65f731c`); реальные данные после prod-деплоя SLAI, иначе fallback к Q8-sync. |
| Q0 | Sonnet vs Opus как prod default | RESOLVED 16.05 — Sonnet (Opus только при провалах на пилоте); `ANTHROPIC_MODEL_ID` в `inference-service/.env.example`, commit `e8f3f6f`. |

---

## История изменений этого файла

| Дата | Действие |
|---|---|
| 2026-05-16 | Файл создан как `Desktop\OPEN_QUESTIONS.md`. 5 active questions: Q1-Q5. |
| 2026-05-16 | Переехал в git: `doc-service/docs/INTEGRATION_QUEUE.md` (рекомендация SLAI A vs B). Q2, Q3 RESOLVED. Добавлены Q7, Q8 от SLAI. |
| 2026-05-17 | Q7 RESOLVED — review matcher/HMAC/target_entity_hint, файл `PARSDOCS_Q7_MATCHER_REVIEW.md`. Q8 переведено из ANSWERED в RESOLVED (action plan был выполнен ещё `4087510`). |
| 2026-05-17 | Q1 RESOLVED — прогон Claude Sonnet 4.6 на синт. PDF: $0.0165/doc, F1 70%, 4× быстрее локальных. Найдены F14 (prefilled `{`) и F15 (cache boost). Model_id в `.env.example` исправлен с фейкового `claude-sonnet-4-7-20260301` на реальный `claude-sonnet-4-6`. |
| 2026-05-17 | F14 + F15 закрыты: prompt-based JSON enforcement + расширенный SYSTEM_PROMPT с 13 типов + few-shot. Bench #22: 10/10 valid JSON, cache 62-83%, items_F1 80%, type/number/date 100%. Claude сравнялся с Gemma 27B при 5× скорости. |
| 2026-05-17 | Q9 ANSWERED — получено ТЗ SLAI v1.0 (18 типов в 3 фазы, 8 open questions). Наш ответ в `PARSDOCS_REPLY_TO_SLAI_TZ.md`. Заведены 12 новых долгов F16-F27. Блокер: ждём golden dataset (15 PDF). |
| 2026-05-17 | F2 закрыто — per-field confidence end-to-end: prompt → backend → calibration → webhook. 18 unit-тестов. |
| 2026-05-17 | F18 (waybill), F19 (bank), F21 (raw-text), F22 (slug aliases) закрыты — quick wins по SLAI ТЗ. |
| 2026-05-17 | F17 (transport_invoice форма 2013), F16 (transport_request) закрыты. **Все 10 типов Фазы 1 SLAI ТЗ покрыты**. Создан `Desktop\parsdocs-validation-bench\SLAI_SYNC_QUEUE.md` для async-вопросов к SLAI команде. |
| 2026-05-19 | F5 закрыто полностью. PdfTextEngine теперь эмитит per-page text через кастомный pagerender в pdf-parse; Tesseract уже это умел; orchestrator + runner + webhook payload собраны раньше. Multi-doc путь активируется для xlsx multi-sheet, тексто-слойных PDF и сканов. Stale тесты `multidoc-splitter.spec.ts` (после relax'а 2026-05-18 commit 255d9e8) обновлены под новую `isMultiDocument` логику. |
| 2026-05-19 | F3 item 4 закрыто — `doc-service/docs/openapi/v1.yaml` (OpenAPI 3.1, 13 схем, 4 примера, описаны HMAC headers, retry/idempotency, versioning, redact_pii, slug aliasing). Items 1/3 остаются заблокированы Q4/Q5 (ждём продакта SLAI). |
| 2026-05-20 | 4 P0 фрахт-счетов SLAI закрыты (`92745ce`): UTF8 0x00 краш, items[] пустой, number=«на»/«No», ИНН продавца=покупателя. Добавлены транспортные атрибуты в `items[]` (vehicle_plate, order_ref, route_from, route_to, trip_date). Schema-echo defensive unwrap. Verified end-to-end на 3 эталонных счетах. |
| 2026-05-26 | Получен `slai-response-to-parsdocs-2026-05-26.md`. Перефреймили как внутренний микросервис (не внешний клиент): отпали коммерческие пункты, A/B-встреча через квартал не нужна. Заведены Q10-Q12 (EXT-A/B/D). EXT-C `blocked-on-trigger` без даты, в очередь не пишем. Ответ — `PARSDOCS_REPLY_TO_SLAI_EXT_2026-05-26.md`. |
| 2026-05-29 утро | EXT-LINE (`42adffc`): 6 line + 4 doc-level транспортных полей в schema + adapterVersion 2026.05.29 + supportedLineFields[]/supportedDocFields[] в /capabilities. Ответ — `PARSDOCS_REPLY_TO_SLAI_LINE_SIGNALS_2026-05-29.md`. |
| 2026-05-29 день | Followup-нудж по 4 блокерам production (`05e5c32`): Q4 service-token + Q5 ETA пилота + Q9 golden dataset + AC9 sandbox формат. Deadline 2026-06-05. |
| 2026-05-29 вечер | SLAI FOLLOWUP закрыл все 4: Q4 webhook secret ETA 2026-05-30, Q5 пилот WW-23 (2026-06-02), Q9 golden dataset 2026-06-02..04, AC9 (separate org / 7d retention / 60 req/min). Заведён Q13 (AC9). Создан `SLAI_SECRETS_INBOX.md` (envelope-encrypted channel) с блоками S1/S2 + `doc-service/test-fixtures/slai-golden/` (PR-канал для PDF). /capabilities supportedLineFields переведён на `{name, since}` формат по их рекомендации. |
| 2026-05-26 | Q12 (EXT-D) реализовано: `file_url`-ingest в `POST /jobs` с SSRF-защитой (`src/pipeline/ingest/url-fetch.ts` — scheme/private-IP/redirect/byte-cap guards), флаг `FILE_URL_INGEST_ENABLED`, error_codes `FILE_URL_*`, тесты `tests/file-url-ingest.spec.ts` (27). Не задеплоено. Webhook v1 не тронут. |
| 2026-05-26 | Нудж SLAI по Q4/Q5/Q9 (все OPEN >7 дней) подготовлен — `doc-service/docs/PARSDOCS_NUDGE_SLAI_2026-05-26.md` (лид: EXT-A/B/D реализованы, 26 типов, vision проходит гейты 96%/90%; оговорки про digital-PDF и latency 186с). Статусы Q4/Q5/Q9 без изменений — ждём ответ. |
| 2026-06-21 | Интеграционные заметки обновлены: Акт-lockstep ЗАКРЫТ с обеих сторон (projector `services_act`, executor/customer по ИНН), дефолт-модель `phi4`, каталог типов 30/30 (+4 складских, миграция `20260621000001`). Заведён `Q-EXT-CLASS` (OPEN, To: CLAUDE) — очередь новых типов EXT-CLASS-1/2/3 после пилота WW-23. |
| 2026-06-23 | Merge github/main→main (сборка LLM-gateway): сведены конфликты, сохранены оба набора Q-блоков — июньский `Q-EXT-CLASS` (HEAD) + github-овые `Q-DADATA-1`, `Q-PERMIT-1`, `Q-CLASS-MATRIX`. Q-DADATA-1 и Q-PERMIT-1 приведены к `ANSWERED`, дубль строки `Asked` в Q-PERMIT-1 убран. Код gateway-фич (Anthropic-бэкенд, `/v1/embeddings`, DaData-passthrough, providers-fallback) влит в `main`; на прод НЕ задеплоено. |
| 2026-06-30 | Сверка извлечения для SLAI (`PARSDOCS_SVERKA_SLAI_2026-06-30.md` + сообщение `PARSDOCS_TO_SLAI_2026-06-30_SVERKA_MSG.md`). Заведён **Q16** (OPEN): новые поля price_list/commercial_invoice (мигр. `20260630000001/0002`), модель phi4→qwen3.6:27b (98.3%), восстановление ~24% пустых доков. Контракт-дельта: `commercial_invoice.containers[].number` НЕ проецируется в `_match_signals` (invoice-alias не зовёт `collectContainers`) — фикс на нашей стороне, `schema_version` без изменений (1.0). Развилки к SLAI: переотдача пустых + нужен ли HS как match-ключ. |
| 2026-06-30 | Микро-сверка от SLAI (подтвердили: плоские bl/container + containers[], `_normalized_fields`/`_match_signals`, order_refs[], hs_code как ТН ВЭД-поле не ключ, **идемпотентная переотдача инвойса безопасна** → закрывает §2-вопрос переотдачи «пустых»: переотдаём webhook по `job_id`, правки SLAI не пострадают). 2 встречных вопроса. Заведены **Q17** (schema_version: top-level drift-маркер состава `extracted`, отдельно от envelope `version` — рекоменд. top-level `schema_version` semver MINOR=log/MAJOR=gate, старт 1.0; verified: top-level `schema_version` сегодня НЕТ, `_match_signals.schema_version=1.0` скоупит только проекцию) и **Q18** (price_list: enrichment-дефолт vs полная матч-сущность через HS — назначение = решение Александра). Ответ-док `PARSDOCS_REPLY_TO_SLAI_SVERKA_2026-06-30.md` (DRAFT, 2 пункта ждут sign-off Александра до отправки SLAI). |
| 2026-06-30 | Sign-off Александра по 2 пунктам микро-сверки. **Q17 → ANSWERED**: принят отдельный top-level `schema_version` (НЕ bump envelope `version`), старт `"1.0"`, политика MINOR=log/MAJOR=gate — в реализации backend, SLAI начать читать ключ. **Q18 → DEFERRED**: price_list пока НЕ нужен как сущность, хранить карточкой, SLAI ничего не строит; переоткрыть по реальной потребности (HS-линковка остаётся отложенной). Reply-док `PARSDOCS_REPLY_TO_SLAI_SVERKA_2026-06-30.md` доведён до send-ready (оба `[НУЖЕН SIGN-OFF]`-гейта убраны); переотдача восстановленных «пустых» доков — мы, по `job_id`, сначала TEST-батч затем остальное. |
| 2026-07-01 | Переработка классификации (имя файла как сигнал + фикс regex АКТ, миграция `20260701000001` + LLM-классификатор qwen3.6:27b на каждом доке, fallback на keyword). Заведён **Q19** (OPEN, To: SLAI_DEV): новое состояние `unrecognized` — неопознанный док приходит как `document_type: null` + опц. top-level поле `unrecognized: true` (present-only), bump `schema_version 1.0→1.1` (аддитивно/back-compat, MINOR по Q17). Просим SLAI подтвердить приём `null` + чтение флага (hold-for-manual, не fail). **Blocked-on-deploy** (webhook-поле реализуется, не в проде). Метаданные классификации (method/duration/candidates/confidence в `jobs.classification`) — внутренние, НЕ в payload. Note-док `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md`. Drafting-only, прод-код/схемы не трогали. |
| 2026-06-23 | Чистка устаревших фактов после merge+деплой `6532be5`. **EXT-CLASS:** создание всех 8 типов выполнено и в проде (миграции `20260621000002/3/4`, каталог = 38 типов) — `Q-EXT-CLASS` переписан с «очередь будущих типов» на «создание сделано, осталась доводка `waybill`/`commercial_invoice`»; «30/30» → 38. `Q-CLASS-MATRIX` освежён: зарегистрировано 38 типов, из gap-листа создано всё кроме `TN`, §(c) split `booking_request` отмечен сделанным. **Merge+deploy:** формулировки «код влит в main, НЕ задеплоено» исправлены на «задеплоен на прод, спит за флагами (503)» в `Q-DADATA-1`. Реально открытые вопросы (§(d) TN vs TTN, полная матрица типов, образцы для калибровки, Q-PERMIT-1 ждёт PDF) сохранены. |
| 2026-07-02 | 4 новых типа задеплоены (миграция `20260702000001`): `insurance_policy` + `safety_data_sheet` (реальные), `export_declaration` + `quality_certificate` (beta). SLAI heads-up **свёрнут в §4 ноты** `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md` (обновлены заголовок/дата/summary + резюме-таблица), отдельного Q-блока не заводили — это новые значения строки `document_type`, аддитивно, конверт и `schema_version` (`1.1`) не меняются. В Q19 добавлена note-only заметка. Drafting-only, прод-код/схемы не трогали. |
