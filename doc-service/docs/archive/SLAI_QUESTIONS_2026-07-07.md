# Вопросы к SLAI — свод на 2026-07-07

**Источник:** `doc-service/docs/INTEGRATION_QUEUE.md` на проде.
**Формат:** только то, что реально ждёт SLAI-side (либо ack, либо файлы/решения).

---

## 🔴 На активный ответ SLAI

### Q19 — `document_type: null` + `unrecognized: true`

- **Что:** новый classifier иногда честно говорит «не знаю» и возвращает
  `document_type: null` + опциональный top-level флаг `unrecognized: true`.
  Bump `schema_version 1.0 → 1.1` (аддитивно, back-compat, MINOR по Q17).
- **Что просим у SLAI:**
  1. Приём `document_type: null` без падения (без force-роутинга по типу).
  2. Трактовка `unrecognized: true` как **hold-for-manual/review**, не как fail.
  3. Проверить: нет ли жёсткого допущения «`document_type` всегда непустой»?
- **Наш статус:** blocked-on-deploy — webhook-поле ещё НЕ в проде.
  Как только мы задеплоим → пингуем SLAI на ack.
- **Note-док:** `PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md`
  (2026-07-02 обновлён §4 — 4 новых значения `document_type`:
  `insurance_policy`, `safety_data_sheet`, `export_declaration`,
  `quality_certificate`, без bump'а schema).

### Q17 — начать читать `schema_version` (drift-маркер)

- **Что:** отдельный от envelope `version` top-level ключ, старт `"1.0"`,
  бампается когда меняется набор полей в `extracted`. MAJOR/MINOR/PATCH.
- **Что просим у SLAI:**
  1. Начать читать ключ (сейчас можно игнорировать без последствий).
  2. Подтвердить трактовку бампов:
     — MINOR/PATCH = логировать, не гейтить;
     — MAJOR = гейтить (может ронять при устаревшем ридере).
- **Sign-off Александра 2026-06-30 у нас уже есть**, реализация в backend'е;
  ждём подтверждение SLAI как читателя.

### Q16 (branch to SLAI) — переотдача пустых доков + hs_code как match-key

- **Что случилось:** ~24% корпуса (30/32 инвойса) раньше отдавали пустое
  извлечение из-за 8192-токен cap. Переобработаны с qwen3.6:27b, теперь
  сигналы полные. Наш фикс `commercial_invoice.containers → _match_signals`
  на нашей стороне.
- **Что просим у SLAI (2 развилки):**
  1. **Переотдача 30 доков:** SLAI сам re-pull-нёт `GET /jobs/:id`,
     или мы переотдадим webhook по списку `job_id`?
  2. **`hs_code` как кросс-док match-key** (commercial_invoice ↔ packing_list
     ↔ ГТД): нужно? Если да — это bump `1.0 → 1.1` и работа с обеих сторон.

### Q-PERMIT-1 — 1–2 реальных PDF Росавтодора

- **Что:** slug `special_permit` уже создан + базовая схема есть, но
  доводка полей (`valid_from` / `waypoints[]` / `axle_loads_kg[]` /
  `restrictions` / escort enum) ждёт реальных образцов.
- **Что просим у SLAI:** прислать 1–2 боевых PDF Росавтодора (может быть
  обезличенных). Пропишем extraction-схему за W24.

### Q-CLASS-MATRIX — реальные PDF для доводки classifier'а

- **Что:** `waybill` иногда мис-классифицируется в `unknown` / `ttn`;
  `commercial_invoice` не всегда ловит ВЭД-поля (incoterms / hs_code /
  country_of_origin / customs_value).
- **Что просим у SLAI:** прислать по 1–2 реальных PDF по обеим типам
  (waybill в разных форматах ГК-2013, ВЭД-варианты commercial_invoice
  с incoterms). Дообучим regex + тонко подкрутим promt.

---

## 🟢 Не блокирует — ждёт только нашего активирования

### Q-DADATA-1 — DaData passthrough в LLM-gateway

- **Статус:** ANSWERED, задеплоено на прод (`6532be5`), эндпоинт спит за
  флагом `dadata` (`enabled=false → 503`).
- **Действие после WW-23 демо:** включить флаг в пакете с активацией
  `/v1/chat/completions` + `/v1/embeddings` (единый cutover SLAI на наш
  gateway).

### LLM-gateway `/v1/chat/completions` + `/v1/embeddings` — cutover после демо

- **Наш статус:** задеплоено на прод, эндпоинты спят за флагами.
- **Действие:** включить одним пакетом с DaData после WW-23 демо.

---

## 📝 Служебное

- **WW-23 пилот** (старт `2026-06-02` подтверждён SLAI) — тестовые прогоны
  прошли, часть найденных дефектов уже поправили. Отдельно
  зафиксировать со SLAI: (а) есть ли ещё открытые баги/замечания
  с их стороны, (б) когда переходим на регулярный поток и cutover
  на прод-инстанс parsdocs (пилот шёл на Asha).

- **Sandbox tenants**: оба provision-ены (Asha).
  - `slai-sandbox` — webhook secret S1 applied 2026-06-01.
  - `slai-negabarit` — webhook_hmac_secret пуст (global env-fallback);
    SLAI не решила, нужен ли отдельный secret на negabarit endpoint.

---

## 📎 Приложения (у SLAI уже есть, ссылки на всякий)

- `doc-service/docs/openapi/v1.yaml` — OpenAPI 3.1 (13 схем, 4 примера)
- `doc-service/docs/CONTRACT_TECH_APPENDIX.md` §4.5 — правила аддитивности
- `doc-service/docs/PARSDOCS_TO_SLAI_2026-07-01_CLASSIFICATION.md`
- `doc-service/docs/PARSDOCS_SVERKA_SLAI_2026-06-30.md`
- `doc-service/docs/PARSDOCS_TO_SLAI_2026-06-30_SVERKA_MSG.md`

---

_Свод составлен автоматически из `INTEGRATION_QUEUE.md` (07.07.2026).
Все статусы «RESOLVED/ANSWERED» опущены — оставлены только activation-open._
