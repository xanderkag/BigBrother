# parsdocs → SLAI: сверка 2026-06-30 → 2026-07-07

**Дата:** 2026-07-07
**От:** parsdocs (Vanga / Big Brother)
**Кому:** SLAI dev / SLAI PM
**Канал:** webhook v1 + `extracted._match_signals` (PD-CONTRACT-1)
**Предыдущая сверка:** `PARSDOCS_SVERKA_SLAI_2026-06-30.md`

> Что зашло на прод у parsdocs с прошлой сверки. Каждый пункт со
> статусом «требует действия SLAI / только heads-up» и ссылкой на
> коммит/миграцию. Значения документов не приводятся — только имена
> полей и структурные факты.

---

## 0. TL;DR

- **Q19 (unknown-документы) — закрыт с обеих сторон.** Наша сторона
  ушла на `document_type: "unknown"` литерал (не `null`), SLAI
  подтвердил 2026-07-01. `WEBHOOK_SCHEMA_VERSION` 1.1 → 1.2.
- **Q16 (containers у `commercial_invoice`) — правка parsdocs зашла.**
  Отдельный проектор для `commercial_invoice` добавлен, `containers[]`
  теперь проецируются в `_match_signals`. SLAI ничего не менять.
- **schema 1.2 добавляет 4 top-level/match-signals поля** для SLAI
  дедупликации (surfaced из уже существующих данных): `file_sha256`
  top-level + `document_stage` / `release_type` / `bl_type` /
  `master_bl_number` / `number_of_original_bls` в `_match_signals`.
  Аддитивно, back-compat.
- **`MATCH_SIGNALS_SCHEMA_VERSION` 1.0 → 1.1** (внутри `_match_signals`
  добавились новые ключи). Envelope `version: "v1"` не меняется.
- **Требуется решение SLAI:** переотдача пустых доков (Q16 branch —
  30 инвойсов); `hs_code` как кросс-док match-ключ.
- **Пилот WW-23:** тесты прошли, часть дефектов закрыта. Открытых
  замечаний по нашей стороне не помним. Просим подтвердить: остались
  ли за нашу сторону баги, и когда переход на регулярный поток
  (cutover Asha → корп-прод parsdocs).

---

## 1. Q19 закрыт: `document_type: "unknown"` вместо `null` + drop `unrecognized`

**Раньше (пред-релиз):** мы предлагали `document_type: null` +
опциональный top-level `unrecognized: true`.

**Финал (SLAI confirmed 2026-07-01):** `document_type: "unknown"` —
явная строка, без отдельного флага. Их receiver нормализует и
возвращает 201.

- Commit `239a1c0` (initial 1.1 + flag) → `41a256a` (переход на
  literal `"unknown"`, drop flag) → `2264fbe` (bump до 1.2).
- В БД jobs.document_type остаётся `null` + `classification.unknown = true`
  — это только wire-представление.
- Note-док `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md` был про
  переработку classifier'а (имя файла как сигнал + LLM на каждом доке
  через qwen3.6:27b + fallback на keyword, никогда не роняет док).

**Для SLAI:** ничего делать не надо, кроме как убедиться, что
`document_type: "unknown"` больше не роняет валидатор (по вашему ack
2026-07-01 — уже не роняет).

---

## 2. Q16 закрыт: `commercial_invoice.containers[]` в `_match_signals`

**Правка parsdocs:** у `commercial_invoice` теперь СОБСТВЕННЫЙ проектор
(не alias на invoice), который вызывает `collectContainers()` — тот же
хелпер, что уже работает для B/L / TTN / CMR / AKT.

- `src/pipeline/normalize/match-signals.ts:388-401` — новый projector.
- Commit — в составе `2264fbe`.
- `schema_version` НЕ бампается по этому пункту (ключ `containers`
  уже был в 1.0, просто расширяем множество типов-источников —
  аддитивно, back-compat по CONTRACT_TECH_APPENDIX §4.5).

**Для SLAI:** ничего делать. После нашего фикса commercial_invoice
начал заполнять `_match_signals.containers[]` — вы уже умеете его
читать по B/L/TTN/CMR/AKT.

---

## 3. `WEBHOOK_SCHEMA_VERSION` 1.1 → 1.2 (top-level `file_sha256` + \_match_signals доп.поля)

Драйвер: SLAI-side дедупликация/версионирование. Всё аддитивно,
back-compat.

### 3.1 Top-level `file_sha256`

Уже жил в `jobs.file_sha256` (миграция 0027) с 2026-06-XX для нашей
кэш-логики. По просьбе SLAI вывели в верхний уровень webhook payload
как отдельный ключ (hex lowercase, 64 chars) или `null` для legacy
job'ов до миграции.

- `src/webhooks/deliver.ts:55-63`.

### 3.2 `_match_signals` — новые ключи (только у B/L и commercial_invoice)

| Ключ | Тип | Где живёт | Смысл |
|---|---|---|---|
| `document_stage` | `"original" \| "copy" \| "draft" \| null` | всегда-present (default `null`) | стадия жизненного цикла документа |
| `release_type` | `"telex" \| "seaway" \| null` | B/L проектор | тип релиза BL |
| `bl_type` | `"master" \| "house" \| null` | B/L проектор | master vs. house BL |
| `master_bl_number` | `string \| null` | B/L проектор | номер master BL для house BL |
| `number_of_original_bls` | `number \| null` | B/L проектор | количество original BL |

- Миграция `20260702000002_commercial_invoice_document_stage.sql` —
  сеет `document_stage` в схему commercial_invoice.
- `MATCH_SIGNALS_SCHEMA_VERSION` **1.0 → 1.1** (Q17 bump-семантика,
  MINOR: логировать, не гейтить).
- Commit `2264fbe`, тесты `tests/match-signals.spec.ts` (190 pass).

**Для SLAI:** начинать использовать эти ключи для дедупа/приоритетов
(например: `document_stage=copy` — не пересчитывать матч, если уже есть
`original` с тем же `bl_number`). Само чтение не обязательно —
present-only. Envelope `version: "v1"` не меняется.

---

## 4. Другие изменения на проде (heads-up, не контракт)

Все следующие пункты — **инфраструктура/качество извлечения**, контракт
не меняют. SLAI ничего делать не нужно, но полезно знать что улучшилось.

### 4.1 Классификатор: LLM + фильтр по имени файла

- Классификация теперь идёт через **qwen3.6:27b на каждом доке** (~1с),
  fallback на keyword-классификатор при любой ошибке/таймауте. **Никогда
  не роняет док.**
- Имя файла как weighted-сигнал (миграция `20260701000001` фикс regex АКТ
  + `filename-signals`).
- Мис-классификации починены: Акт→`customs_declaration`, ТТН→`invoice`,
  УПД→`factInvoice`. Реальный корпус SLAI выиграл fill-rate.

### 4.2 Каталог типов = 42 активных

Плюс 4 новых ВЭД-типа (миграция `20260702000001_ved_class_4_types.sql`,
commit `f37dab7`): `insurance_policy`, `safety_data_sheet`,
`export_declaration`, `quality_certificate`. Первые два — реальные,
могут прийти сейчас. Последние два — beta, схема предварительная.
Heads-up отправлен в `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md` §4.

### 4.3 Office-файлы v2 (`docs/OFFICE_FILES_V2_TZ.md`)

- **P1-A DOCX-таблицы → Markdown** (`3bfb541`) — таблицы теперь
  сохраняют структуру в plain-text, LLM видит колонки.
- **P1-B DOCX vision-fallback** (`1621263` + `aa6d9dd` — тюнинг
  триггера картинко-доминированности) — «скан в ворде» рендерится в
  картинку и уходит на vision-путь.
- **P2.2 DOCX колонтитулы** (`6558b7d`) — реквизиты из header/footer
  теперь попадают в `extracted.party_*`.
- **P2.1 antiword** (`0037260`) — legacy .doc через catdoc-fallback.
- **item_rows промпт** (миграция `20260706000001`) — «извлеки КАЖДУЮ
  строку» для packing_list + инвойсов (`bf69060`) — фикс усечённых
  items[] на длинных списках.

### 4.4 Excel в UI

- `GET /jobs/:id/sheets` (`674d286`) — грид ячеек по листам xlsx.
- Фронтенд `SheetViewer` (`8a62a3c`) — раньше на xlsx была битая
  картинка.

### 4.5 Office → PDF preview

- `94396a1` — headless LibreOffice рендерит .doc/.docx/.xlsx в PDF
  для превью в UI. Фототочное отображение (шрифты + таблицы).

### 4.6 VANGA-LLM-2: per-request backend switch

- `23d6c06` — новый header `X-LLM-Backend: cloud|local|gpu` даёт
  клиенту переключить бэкенд без рестарта сервиса. Для SLAI это
  комплементарно EXT-B (BYO LLM credentials): если у вас есть свой
  ключ — `X-LLM-*` заголовки, если нет — `X-LLM-Backend: gpu`
  переключает на наш локальный.

### 4.7 Журнал в UI (наш оператор)

Дропдаун типов с группировкой + мультивыбор + пресеты периода/формата
(`d973d22` + `f685d97`). Для SLAI это UX нашего оператора-в-петле,
контракт не трогает.

---

## 5. Открытые вопросы к SLAI

| # | Что | Приоритет |
|---|-----|-----------|
| **A** | **Пилот WW-23 итог:** тесты у нас прошли, часть дефектов закрыта. Остались ли открытые баги с вашей стороны? Что нужно чтобы перевести регулярный поток с Asha на корп-прод parsdocs? | 🔴 |
| **B** | **Q16 branch — переотдача 30 пустых инвойсов:** вы re-pull-нёте `GET /jobs/:id` сами, или нам переотдать webhook по списку `job_id`? | 🟡 |
| **C** | **`hs_code` как кросс-док match-key** (commercial_invoice ↔ packing_list ↔ ГТД по коду ТН ВЭД): нужно? Если да — bump 1.2 → 1.3 и работа на обеих сторонах. | 🟡 |
| **D** | **Q-PERMIT-1:** 1–2 боевых PDF Росавтодора (можно обезличенных) для доводки extraction-схемы `special_permit`. | 🟡 |
| **E** | **Q-CLASS-MATRIX:** 1–2 PDF `waybill` (разные форматы ГК-2013) + 1–2 ВЭД `commercial_invoice` с incoterms/hs_code/country_of_origin. Дотюним классификатор + prompt под ваш корпус. | 🟡 |
| **F** | **`slai-negabarit` webhook secret:** сейчас пусто, работает global env-fallback. Заводить отдельный per-tenant secret или оставить как есть? | 🟠 |
| **G** | **`document_stage` семантика:** ваш корпус даст «original» в 100% случаев (первичный документооборот), или встречаются «copy» (из архива) / «draft» (черновики) регулярно? Помогает нам понять, стоит ли расширять множество enum. | 🟠 |

---

## 6. Что мы держим на паузе для вашего cutover'а

Всё готово, деплой на проде — эндпоинты спят за фича-флагами
(`enabled=false → 503`). Активируем **поштучно с smoke-проверкой**
(выбор Александра 2026-07-07); порядок обсуждаемый:

| Флаг | Что | Ваши действия после активации |
|---|---|---|
| `HYBRID_ROUTING_ENABLED` | text/vision routing (главный latency-рычаг) | никаких (внутреннее) |
| `FILE_URL_INGEST_ENABLED` | `POST /jobs {file_url, file_sha256}` вместо multipart | опция для >50MB файлов, не блокирует старый путь |
| `BYO_LLM_ENABLED` | `X-LLM-Provider/Api-Key/Model/Base-Url` заголовки | пробросить ваш Anthropic-ключ, если хотите |
| `dadata` | `POST /v1/dadata/findById/party` через наш gateway | cutover с прямых DaData → наш gateway |
| `embeddings` | `POST /v1/embeddings` (OpenAI-compat, `bge-m3` на GPU) | cutover embeddings |
| `chat` | `POST /v1/chat/completions` alias `parsdocs-chat` / `parsdocs-vision` | cutover chat |

**Пинг перед активацией каждого:** дадим 24-48ч, чтобы вы синхронно
переключили клиентов.

---

## 7. Что дальше на нашей стороне

**Q19-деплой был выбран приоритетом на 2026-07-07 Александром**, но
проверка кода показала: **Q19 уже задеплоен** (commit `41a256a` +
`2264fbe`, ваш ack 2026-07-01). INTEGRATION_QUEUE-статус OPEN — не
обновили после закрытия.

**Реальный next на нашей стороне:**

1. Синхронизироваться со SLAI по пункту **A** (WW-23 остатки).
2. По подтверждению — **поштучная активация флагов** из §6 с пингом
   вашей стороны.
3. **Mini-golden-set** — 10–15 реальных RU-доков, честный замер
   точности на текущем проде (qwen3.6:27b + phi4-fallback). Не ждёт
   никого.
4. **MTI-3** (унификация хранения ключей) — разблокирует UX-1/2/3 +
   EXT-LLM-PROXY-B полный цикл.

---

## 8. Приложения / ссылки

- **Предыдущая сверка:** `doc-service/docs/PARSDOCS_SVERKA_SLAI_2026-06-30.md`
- **OpenAPI 3.1:** `doc-service/docs/openapi/v1.yaml` (обновлён 1.2)
- **Аддитивность:** `doc-service/docs/CONTRACT_TECH_APPENDIX.md` §4.5
- **INTEGRATION_QUEUE:** `doc-service/docs/INTEGRATION_QUEUE.md`
- **Классификация note:** `doc-service/docs/PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md`
- **Office v2 ТЗ:** `doc-service/docs/OFFICE_FILES_V2_TZ.md`

---

_Свод составлен на 07.07.2026 после ревизии git-лога с 30.06 и
INTEGRATION_QUEUE.md на проде. Если хочешь сокращённую версию для
отправки SLAI-PM (только раздел 5 + 6 + WW-23) — скажи, сделаю._
