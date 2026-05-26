# SLAI Integration — единый бэклог

**Дата:** 2026-05-26
**Источник:** `SLAI_TZ_v1_2026-05-17.md`, `slai-response-to-parsdocs-2026-05-26.md`,
`INTEGRATION_QUEUE.md`, `MODEL_REPORT.md` #26, `ROADMAP.md`

> **Назначение:** одно место, где видно всё что нужно для полной интеграции
> parsdocs ↔ SLAI Суперлогист. Три слоя: контракт (как говорим), содержание
> (что распознаём), операционка (пилот + multi-instance). Каждый пункт со
> статусом и owner'ом.

---

## TL;DR

| Слой | Готовность | Блокер |
|------|-----------|--------|
| **1. Контракт** (extractor adapter API) | ✅ 100% в коде | Ждёт деплоя |
| **2. Содержание** — типы документов | ✅ 100% (26 типов, оба фазы SLAI TZ покрыты) | — |
| **2. Содержание** — точность | ✅ Vision проходит (96%/90%) | — |
| **2. Содержание** — latency | 🔴 2-9× мимо SLA (186-820с vs 90с) | vLLM + hybrid-routing |
| **3. Операционка** — golden dataset | 🔴 ждём 15 PDF от SLAI | SLAI side |
| **3. Операционка** — пилот | 🔴 ждём ETA от SLAI | SLAI side |
| **3. Операционка** — multi-instance | ⏸ заморожено до триггера | продуктовое решение |

---

## Слой 1: КОНТРАКТ — extractor adapter API

Это технический интерфейс между SLAI `ExtractorGateway` (их новый модуль
по `document-pipeline-separation-tz.md`) и parsdocs.

### Готово ✅

| ID | Что | Коммит | Тесты |
|----|-----|--------|-------|
| **EXT-A** | `GET /capabilities` — discovery (adapter, contractVersion, supportedDocumentTypes, maxFileMB, webhookSupported) | `d798917`+`808e5cb` | `capabilities-route.spec.ts` |
| **EXT-A** | `X-Extractor-Signature` webhook header alias (рядом с X-Parsdocs/X-DocService) | `d798917` | в тех же |
| **EXT-B** | BYO LLM credentials через `X-LLM-Provider/Api-Key/Model/Base-Url` headers + secrets envelope encryption + redaction + `BYO_LLM_ENABLED` flag + метрики `extractor_llm_credentials_supplied_total{provider}` + `extractor_llm_provider_errors_total{provider, code}` | `808e5cb` | `byo-llm-credentials.spec.ts` (18) |
| **EXT-D** | Pre-upload signed URL (`POST /jobs {file_url, file_sha256}`) — снимает 50MB multipart-bottleneck. SSRF-safe (private IP блок до DNS, schemes whitelist, no-redirect, mid-stream byte cap), за флагом `FILE_URL_INGEST_ENABLED` (default off, fail-closed) | `808e5cb` | `file-url-ingest.spec.ts` (27) |
| **INT-1** | Inbound HMAC `X-SLAI-Signature` (verify SLAI→parsdocs) | прежний | есть |
| **EPIC-7** | `GET /version` + manual deploy workflow + `/health`+`/ready` | прежний | есть |
| **Webhook v1** | Стабильный JSON envelope, HMAC, idempotency, retry-after, версионирование | прежний | есть |
| **OpenAPI 3.1** | Полная спецификация → `doc-service/docs/openapi/v1.yaml` (13 схем, 4 примера) | прежний | — |
| **Bonus** | docker prune в deploy.yml (housekeeping, как у SLAI) | `7bbba5a` | — |

### Не делаем (заморожено)

| ID | Что | Почему |
|----|-----|--------|
| **EXT-C** | Multi-tenant LLM-ключи (`provider_settings.tenant_id`) | `blocked-on-trigger` — нет второго платящего клиента/инстанса. CP7 multi-tenant CRUD в коде уже есть; разморозим когда появится |

### Ждёт от SLAI

| ID | Что | Owner |
|----|-----|-------|
| **AC 9 / sandbox** | Sandbox-тенант для SLAI — мы готовы выдать dedicated organization + token, ждём подтверждения формата | parsdocs (после деплоя) |
| **Contract-test** | SLAI пишет contract-test против `ParsdocsAdapter` в их `ExtractorGateway` (после EXT-A в проде) | SLAI |

### Ждёт деплоя

Все EXT-A/B/D в гите но не на проде. Релиз блокирован **P0-1/P0-2 из ROADMAP**:
- `API_KEY` пустой на проде → auth fail-closed не пускает старт (новый код)
- Команда: `ssh kb-docker 'cd parsdocs/doc-service; sed -i "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env'` → ручной запуск `deploy-parsdocs.yml`
- После деплоя включить `BYO_LLM_ENABLED=true` и `FILE_URL_INGEST_ENABLED=true` когда SLAI готов

---

## Слой 2: СОДЕРЖАНИЕ — что распознаём

### Типы документов — ✅ оба фазы SLAI TZ покрыты (26 в БД)

**Фаза 1 (10 типов из SLAI TZ §1):**

| # | Тип | Slug | Статус | Реализация |
|---|-----|------|--------|-----------|
| 1 | Счёт на оплату | `invoice` | ✅ | builtin + LLM fallback. Фрахт-атрибуты `items[]` (vehicle_plate, order_ref, route_*) — `92745ce` |
| 2 | УПД | `UPD` | ✅ | builtin |
| 3 | ТТН | `TTN` | ✅ | llm_extract |
| 4 | Заявка на перевозку | `transport_request` | ✅ | F16 |
| 5 | Путевой лист | `waybill` | ✅ | F18 |
| 6 | ТН-2013 | `transport_invoice` | ✅ | F17 |
| 7 | Платёжное поручение | `payment_order` | ✅ | llm_extract |
| 8 | Акт оказанных услуг | `AKT` | ✅ | llm_extract |
| 9 | Счёт-фактура | `factInvoice` | ✅ | llm_extract (fixed `531538b`) |
| 10 | Договор | `contract` | ✅ | llm_extract |

**Фаза 2 (8 ВЭД из SLAI TZ §1):**

| # | Тип | Slug | Статус | Реализация |
|---|-----|------|--------|-----------|
| 11 | CMR | `CMR` | ✅ | llm_extract |
| 12 | Commercial Invoice | `commercial_invoice` | ✅ | VED schemas (`aa419d3`) |
| 13 | Packing List | `packing_list` | ✅ | |
| 14 | Bill of Lading | `bill_of_lading` | ✅ | |
| 15 | Customs Declaration | `customs_declaration` | ✅ | |
| 16 | Cert of Origin | `cert_of_origin` | ✅ | |
| 17 | EAC Conformity Cert | `eac_conformity_certificate` | ✅ | |
| 18 | Weighing Act | `weighing_act` | ✅ | Phase F |

**Дополнительно (не в SLAI TZ, добавили под кейсы):**
UKD, transfer_note, contract_addendum, contract_specification, cash_receipt, wire_transfer_application, price_list, proforma_invoice. Итого **26 типов** в БД (`GET /capabilities → supportedDocumentTypes`).

### Точность — ✅ vision проходит, ⏳ нужен golden dataset

| Метрика | SLA SLAI | Phi-4 text (прод сейчас) | Qwen-VL 32B vision (на GPU) | Готовность |
|---------|----------|--------------------------|------------------------------|-----------|
| Critical exact | ≥95% | 69% | **96%** | ✅ planka впервые пройдена |
| Overall exact | ≥85% | 68.3% | **90%** | ✅ |
| Сканы СФ | ≥80% (целевой) | сыпались | **100%** | ✅ |

Бенч: 9 реальных доков, `docs/MODEL_REPORT.md` #26. **Оговорка:** тест-доки
имели text-layer (digital PDF→картинка), не настоящие растровые сканы.
Перепроверить на golden-set SLAI (Q9, заблокирован).

### Latency — 🔴 главный блокер MVP-пилота

| Метрика | SLA SLAI MVP | Qwen-VL 32B vision | Gap |
|---------|--------------|---------------------|-----|
| P50 | ≤90с | 186с | 2× мимо |
| P95 | ≤90с | 820с | 9× мимо |

**План закрытия latency (`docs/ROADMAP.md` Находка качества):**

| # | Шаг | Эффект | Сложность |
|---|-----|--------|-----------|
| 1 | ✅ **Hybrid-routing** — text/phi4 для чистых text-PDF (в SLA), vision для сканов/низкой OCR-уверенности. Код `ef24a8d`, за флагом `HYBRID_ROUTING_ENABLED`, ждёт деплоя | Снимает ~80% docs в SLA | сделано |
| 2 | ✅ **Extraction-from-image** путь (image_base64 + multimodal message) | `2aff356` | сделано |
| 3 | **vLLM миграция Qwen-VL** на сервере 96 ГБ VRAM (в пути) | Кратное ускорение через continuous batching | После прихода сервера |
| 4 | **Меньшая модель (qwen2.5vl:7b) + DPI/num_predict tuning** | Срезает latency, теряем точность ~5% | 1 день |
| 5 | **Phi-4-multimodal** через vLLM (когда сервер придёт) | Бенчмаркить параллельно | 1 день после сервера |

---

## Слой 3: ОПЕРАЦИОНКА — пилот + multi-instance

### Открытые вопросы → SLAI (блокеры пилота)

| Q | Что | Spec/Asked | Owner | Заметка |
|---|-----|------------|-------|---------|
| **Q4** | Service-token для parsdocs→SLAI webhook auth | 2026-05-17 | SLAI | Нужен чтобы наш webhook receiver мог писать в SLAI |
| **Q5** | ETA пилота с реальными документами | 2026-05-17 | SLAI | Когда подключаемся к их dev-окружению |
| **Q9** | Golden dataset (15 PDF + 15 .gt.json) | 2026-05-17 ANSWERED, ждём файлы | SLAI | Без него нет baseline accuracy — критичный блокер |

**Действие parsdocs:** напомнить SLAI про Q4/Q5/Q9 (все три >7 дней OPEN).

### Multi-instance Суперлогист — продуктовый вопрос

**В SLAI TZ v1 этого нет.** Возникло отдельно: «несколько инстансов SLAI
Суперлогист, parsdocs принимает задачи от всех». В EXT-A/B/D частично
снимается (BYO LLM credentials per-request → каждый инстанс шлёт свои),
но архитектурно осталось:

| Что | Готовность | Что нужно |
|-----|-----------|-----------|
| **Изоляция jobs по инстансам** | ✅ Multi-tenant модель (organizations, projects, tokens) уже есть | — |
| **Outbound webhook callback per-org** | ⚠ В `webhook_url` на job — работает, но нет per-org default-URL | Поле в `organization_settings` (½ дня) |
| **HMAC секрет per-instance** | 🔴 Один глобальный `SLAI_TO_PARSDOCS_HMAC_SECRET` | Перейти на per-org secret (CP7 phase 5, разморозить из YAGNI) |
| **Onboarding нового инстанса** | 🔴 Только ручной (через Tenants UI) | Self-serve или скрипт |

**Решение:** **заморожено до триггера** (когда появится второй SLAI-инстанс).
CP7 multi-tenant CRUD в коде готов; эксплуатацию открываем по требованию.

### F-долги по SLAI TZ — статус

| F | Описание | Статус |
|---|----------|--------|
| F2 | Per-field confidence end-to-end | ✅ закрыт 2026-05-17 |
| F3.1+3 | Webhook-receiver + service-token на стороне SLAI | 🔴 Blocked Q4/Q5 |
| F3.4 | OpenAPI v1.yaml | ✅ закрыт 2026-05-19 |
| F5 | Multi-document PDF splitter | ✅ закрыт 2026-05-19 |
| F14/F15 | Force-JSON prompt + cache boost | ✅ закрыт 2026-05-17 |
| F16 | transport_request | ✅ закрыт |
| F17 | transport_invoice | ✅ закрыт |
| F18 | waybill | ✅ закрыт |
| F19 | bank/bik/account в invoice | ✅ закрыт |
| F20 | One-shot prompt override | ✅ закрыт |
| F21 | GET /:id/raw-text | ✅ закрыт |
| F22 | Slug aliases case-insensitive | ✅ закрыт |
| F23 | Китайский язык (rus+eng+chi_sim) | ✅ закрыт |
| F26 | Per-job tesseract_langs override | ✅ закрыт |
| F27 | Delete-after-success | Открыт, низкий приоритет |
| EXT-1 | Money-object → scalar, seller/buyer roles, tax_invoice→LLM | ✅ `531538b` |

---

## Sequencing — что брать следующим

### Сейчас блокирующее

1. **Деплой стека на прод** (P0-1+P0-2 из ROADMAP) — одной командой довезёт всё:
   auth fail-closed, DaData, EXT-A/B/D, UI-7, docker prune.
   Команда: `ssh kb-docker 'cd parsdocs/doc-service; sed -i "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env'` → запуск `deploy-parsdocs.yml`.

2. **Напомнить SLAI** про Q4/Q5/Q9 (все >7 дней).

### Параллельно (не блокирующее, разблокирует пилот когда придут ответы)

3. **Hybrid-routing text/vision** — самый большой эффект на SLA. 2-3 дня.
4. **Свой mini-golden-set** (10-15 реальных RU доков) — пока ждём от SLAI, прогнать на прод-конфиге, первая честная цифра точности. Не ждёт никого.

### Заморожено до триггера

5. **Multi-instance Суперлогист**: per-org HMAC + outbound webhook per-org + onboarding-скрипт. Размораживаем когда появится второй инстанс/клиент.
6. **EXT-C**: multi-tenant LLM-ключи. Тот же триггер что и #5.

---

## История

- 2026-05-17: получено SLAI TZ v1 (Q9), наш ответ создан. F16-F22 закрыты.
- 2026-05-19: F5, F23, F26 закрыты, OpenAPI v1.yaml. Real-doc bench начался.
- 2026-05-20: 4 P0 фрахт-счетов SLAI закрыты (`92745ce`).
- 2026-05-25: Qwen-VL 32B vision впервые проходит SLAI gates (96%/90%), но latency 186-820с.
- 2026-05-26: получен `slai-response-to-parsdocs-2026-05-26.md` (EXT ТЗ согласован), Q10-Q12 закрыты в коде (`d798917`+`808e5cb`), bonus docker prune (`7bbba5a`). Этот документ создан как единый бэклог.
