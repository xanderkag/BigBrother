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

### Q12. EXT-D — Pre-upload signed URL ingestion

- **Status:** OPEN (deferred — после A+B, не блокер MVP)
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
SLAI — наш же микросервис, у него уже есть AI-инфра (Anthropic key для
AI-чата). Передача того же ключа в parsdocs per-request — архитектурное
удобство (parsdocs не настраивает свой ключ) + готовность к новым
consumer-микросервисам после SLAI. Не коммерческая модель — один общий
внутренний ключ. Exit criteria: снимаем когда parsdocs заведёт свои
LLM-контракты ИЛИ когда LLM-extraction переедет на сторону consumer'а.

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

### Q9. ТЗ от SLAI v1.0 — 18 типов документов, 8 open questions, golden dataset

- **Status:** ANSWERED (наш ответ создан, ждём golden dataset)
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

- **Status:** OPEN
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Решение когда генерить и передать SLAI dev сервис-токен (`API_KEYS_JSON`) для аутентификации их вызовов к нам
- **Что сделать когда ответят:**
  1. Сгенерить ключ через `openssl rand -hex 32`, добавить в `API_KEYS_JSON={"<key>":"slai"}` на staging
  2. Сгенерить также `SLAI_TO_PARSDOCS_HMAC_SECRET` для подписи их webhook'ов к нам (см. Q6 ответ 5)
  3. Отправить SLAI через защищённый канал (1Password / signal / encrypted email)
  4. Зафиксировать дату ротации (через 6 месяцев)

#### Question / Context
SLAI ответил (SLAI_REPLY_v2.md): «Сейчас в дев-фазе токен не нужен. Когда продакт скажет деплоим — сгенерим вам сразу через openssl rand -hex 32. Передам через 1Password / secure channel.»

То есть **они тоже ждут команды от продакта**. Q4 зависит от Q5 ETA.

#### Answer
<ждём ETA от продакта>

---

### Q5. ETA пилота с реальными документами

- **Status:** OPEN
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Когда планируется развернуть всё и начать получать реальные PDF от логистов
- **Что сделать когда ответят:**
  - **Сегодня-неделя** → F11 + F12 + F13 (cost tracking + dedupe + sync receiver)
  - **2-3 недели** → + F5 (multi-doc PDF) + F2 (per-field confidence)
  - **Месяц+** → широкий пакет + пересмотр моделей через bench

#### Question / Context
SLAI оценили (Q5 в их `SLAI_REPLY_v2.md`): **2-3 недели**, с распределением:
- Неделя 1: наш M3.4 + M3.5 (multi-doc + per-field confidence) + их TypeORM realtime sync
- Неделя 2: интеграционный smoke на обоих staging
- Неделя 3: 1-2 логиста пилот на прод

«Финальное решение за продактом SLAI.» **Ждём подтверждения.**

#### Answer
<ждём>

---

## Resolved Questions (последние 7 дней)

### Q1. ANTHROPIC_API_KEY для F11 baseline bench

- **Status:** RESOLVED (2026-05-17)
- **From:** CLAUDE → USER
- **Resolution:** прогон Claude Sonnet 4.6 на 10 синтетических PDF (1.3 мин total, 9/10 valid JSON, items_F1 70%, Cost $0.0165/doc → $25/мес для 50 doc/day). MODEL_REPORT.md прогон #21. Найдены F14/F15 (закрыты 2026-05-17). USER должен ротировать ключ в Anthropic Console.

---

### Q7. SLAI matcher / target_entity_hint / HMAC verify review

- **Status:** RESOLVED (2026-05-17)
- **From:** SLAI_DEV → PARSDOCS_DEV
- **Resolution:** ответ в `doc-service/docs/PARSDOCS_Q7_MATCHER_REVIEW.md` — их matcher принципиально устраивает (правильные сигналы plate/ИНН, threshold HIGH≥70+2×, timing-safe HMAC, `target_entity_hint` auto-detect). 3 nice-to-have уточнения зависли до пилота.

---

### Q8. 7 open questions по continuous category sync

- **Status:** RESOLVED (2026-05-16)
- **From:** SLAI_DEV → PARSDOCS_DEV / CLAUDE
- **Resolution:** ответ в `doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md` — receiver `POST /api/v1/integrations/slai/sync/nomenclature` + `/snapshot`, Redis lookup-table TTL 24ч, 2 отдельных HMAC секрета, header `X-SLAI-Version: v1`, retry-с-backoff + `sync_inbox`. F13 (closed) в TECH_DEBT_ARCHIVE.

---

### Q2. SLAI ответ на наш SLAI_OUR_REPLY.md

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** SLAI_DEV

#### Answer (2026-05-16, SLAI_DEV)
См. `SLAI_REPLY_v2.md` (xanderkag/SLAI commit `296b2b9f`, docs/PARSDOCS_REPLY_v2_2026-05-16.md). Сжато:
- **Все 14 [ПРОДУКТ]-решений приняты** ✅
- **Все 6 наших ответов приняты**, причём 4 из них уже реализованы в коде SLAI:
  - `target_entity_hint` в matcher (auto-detect через vehicle.plate)
  - HMAC verify (timing-safe)
  - `redact_pii: true` flag в DocPlatformProcessor
  - matcher scoring (+50/+30/+25/+15/+10/+5)
- 2 ждут нашей доставки:
  - multi-doc PDF (`documents: Array<>` типы готовы, активируют когда мы запустим F5)
  - per-field confidence (типы готовы `_field_confidence`, добавят в matcher в M3.3 когда мы запустим F2)

#### Resolution
- Q2 закрыт. Все принципиальные продуктовые расхождения сняты — переходим к технической имплементации
- Q7 (новый) — нужно прочитать их код matcher/HMAC и подтвердить детали реализации (TODO для Claude)
- Q8 (новый) — 7 вопросов по category sync, ответы в этом же commit'е

---

### Q3. Hist категорий номенклатуры

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** SLAI_DEV

#### Answer (2026-05-16, SLAI_DEV)
Endpoint **`GET /api/v1/admin/nomenclature/hist`** уже реализован (SLAI commit `65f731c`). SQL и формат описаны в `SLAI_REPLY_v2.md` раздел Q3.

**Реальные данные — после деплоя SLAI на prod** (на дев-стенде синтетика, отдавать смысла нет).

**Workflow после деплоя:** admin прогоняет `curl` → кладёт `slai_hist.json` в общую папку → parsdocs Claude подгружает и сравнивает с нашими 17 категориями → обновляет keyword-mapper в `categories.ts` → push в 3 ремоута.

#### Resolution
- Q3 закрыт принципиально (механизм согласован)
- Реальная синхронизация будет через Q8 механизм (continuous sync), а разовый hist остаётся как fallback
- На дев пока не нужен, ждём prod-деплой

---

### Q0. (пример формата) Sonnet vs Opus как production default

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER

#### Answer (2026-05-16, USER)
Sonnet. Опус только если будут провалы качества на пилоте.

#### Resolution (2026-05-16, Claude)
F9 — изменено в `inference-service/.env.example`:
`ANTHROPIC_MODEL_ID=claude-sonnet-4-7-20260301`. Commit `e8f3f6f`.
Через provider_settings UI пользователь может переключить на Opus для отдельных типов документов.

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
