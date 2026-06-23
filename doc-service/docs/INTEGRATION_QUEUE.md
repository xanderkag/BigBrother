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

### Q-EXT-CLASS. Новые типы документов (очередь, после пилота)

- **Status:** `OPEN` (To: CLAUDE)
- **Asked:** 2026-06-21
- **From:** PARSDOCS_DEV
- **To:** CLAUDE / SLAI_DEV
- **Что нужно:** Расширение каталога типов под ВЭД/логистику. Делать **по очереди**, **после стабилизации пилота WW-23**. Подробные определения эпиков — в ROADMAP § Перспектива. Детальные spec-блоки по конкретным типам — ниже (Q-PERMIT-1, Q-CLASS-MATRIX).
- **Что сделать когда дойдёт очередь:** каждый тип = 1 seed-миграция (рецепт отработан на 30/30); согласовать со SLAI, нужны ли эти типы в их матчере и какие поля они читают.

#### Очередь
- **EXT-CLASS-1** (~2 д): `special_permit` (Росавтодор) — см. Q-PERMIT-1, `booking_request` (клон `transport_request`, `requestor.kind=forwarder`), тюнинг классификатора `waybill`.
- **EXT-CLASS-2** (~3 д): AWB (Air Waybill), `manifest`, `phytosanitary_certificate`, `veterinary_certificate`, тюнинг `commercial_invoice` под ВЭД.
- **EXT-CLASS-3** (~1.5 д): CIM + СМГС (международные ж/д).

#### Интеграционные заметки (актуальное на 2026-06-21)
- **Каталог типов закрыт 30/30** — добавлены 4 складских (`power_of_attorney`/М-2, `warehouse_receipt`/МХ-1, `warehouse_return`/МХ-3, `material_requisition`/М-11), миграция `20260621000001`, задеплоено + проверено вживую.
- **Дефолт-модель извлечения = `phi4`** (бенч 2026-06-18: 91% против mistral 48%; фикс мис-ярлыков сторон ТТН/CMR). Все типы на `parser_kind=llm_extract`.
- **Акт-lockstep с SLAI ЗАКРЫТ с обеих сторон** — projector `services_act` в `_match_signals` (party_a→`executor`, party_b→`customer`); SLAI читает `executor`+`customer` по ИНН.

---

### Q-DADATA-1. DaData passthrough в LLM-gateway (третий внешний канал)

- **Status:** `ANSWERED` (spec OK; код влит в `main` merge 2026-06-23, **не задеплоен**) — ждём cutover SLAI после WW-23 демо (в пакете с активацией chat/embeddings)
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

**Статус кода:** DaData-passthrough влит в `main` этим merge (github→main, 2026-06-23) вместе с Anthropic-бэкендом шлюза и `/v1/embeddings`. **На прод не выкачено** — деплой и cutover отдельным шагом.

**Действие после демо:** активировать в пакете с chat/embeddings для единого cutover'а.

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

**Что у нас уже зарегистрировано** (из 26 active document types на
vanga.sls24.ru): `waybill`, `bill_of_lading` (BL_SCHEMA полная от
2026-06-04), `commercial_invoice`, `packing_list`, `cert_of_origin`,
`transport_request`. Реально не хватает: `TN`, `special_permit`, `AWB`,
`CIM`, `СМГС`, `manifest`, `phytosanitary_certificate`,
`veterinary_certificate`.

**Что ждём от SLAI:**

1. **§(a):** ack по ETA EXT-CLASS-1/2/3 (1.5-2.5д + 3д + 1.5д = ~7 рабочих
   дней, после WW-23 пилот-стабилизации).
2. **§(b):** beta-доступ не делаем — добавляем в main без флагов.
3. **§(c) КРИТИЧНО:** `transport_request` (заявка от заказчика к
   экспедитору) vs `booking_request` (экспедитор → перевозчик плеча) —
   разделять или мерджить? У них в БД разные сущности, наш голос —
   разделить. Жду подтверждение.
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
