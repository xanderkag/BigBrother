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
| **1. Контракт** (extractor adapter API) | ✅ Задеплоен 2026-05-31 (Asha `a920e80`, `vanga.sls24.ru`) | — |
| **2. Содержание** — типы документов | ✅ 100% (26 типов) | — |
| **2. Содержание** — точность vision | ✅ Vision проходит (96%/90%) | golden dataset для верификации |
| **2. Содержание** — latency vision | 🔴 2-9× мимо SLA (186-820с vs 90с) | vLLM + GPU-сервер (в пути) |
| **3. Пилот** — WW-23 старт 2026-06-02 | ✅ Подтверждено SLAI 2026-05-29 | — |
| **3. Sandbox-тенанты** | ✅ slai-sandbox (api.demo) + slai-negabarit (negabarit.) | — |
| **3. Webhook secret** | ✅ S1 APPLIED 2026-06-01 (для slai-sandbox) | для negabarit — open question SLAI |
| **3. Golden dataset Q9** | 🟡 ETA SLAI 2026-06-02..04 | SLAI side |
| **4. UX/Архитектура** — UI ключи живые | 🟡 MTI-3 (1-2 дня) — критично; вставленный ключ не доходит до Anthropic | техдолг, в работе после пилота |
| **5. Multi-instance management** | 🟡 MTI-1 разморожен 2026-05-31 | техдолг |
| **6. LLM-gateway** для SLAI ecosystem | 🟡 EXT-LLM-PROXY-B принят 2026-06-01 (после MTI-3, ~5 дней) | после пилота |
| **7. UI упрощение** | 🟡 UX-1/2/3 + UX-4 audit запланированы | после MTI-3 |
| **8. Voice + Local Agent Models** | ⏸ Epic-5 ждёт GPU, Epic-8 готов на CPU | железо |

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

**Deploy-target пилота WW-23 = `asha` (staging/demo, личный хост),
не kb-docker.** Топология — `DEPLOY_TOPOLOGY.md`. SLAI (`api.sls24.ru`,
`app.sls24.ru`) живёт на том же хосте → docker-сеть `ai-platform`, быстрый
итерационный цикл без корп-деплоя.

Состояние на Asha (на 2026-05-29):
- parsdocs commit `cdbd8d6` — **отстаёт** от master (`a5cbd04`). Не доехали:
  EXT-LINE (`42adffc`), `/capabilities` `{name,since}`, secrets-inbox,
  golden fixtures, followup reply, hybrid-routing полный код.
- `BACKEND=stub` — LLM выключен (правило хоста: реальные корп-данные не
  пускаем; для пилота на синтетике + Anthropic через Red Shield VPN-прокси
  будет настройка отдельно).
- ASR работает (`voice-asr` + faster-whisper small).

Действия для пилота WW-23:
1. `git pull` на Asha → `docker compose up -d --build` → обновится до
   `a5cbd04`.
2. Включить `BYO_LLM_ENABLED=true` + `FILE_URL_INGEST_ENABLED=true` в
   inference `.env`.
3. Когда SLAI пришлёт webhook secret (S1) → положить в БД parsdocs Asha.
4. Создать sandbox-org + token (AC9/Q13) → S2.

kb-docker (corp prod) — отдельный track, **не блокер** для SLAI пилота.

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

---

## Полный roadmap эпиков (на 2026-06-01)

### ✅ Сделано / в гите (ждёт деплоя или вже задеплоено)

| ID | Что | Commit | Status |
|----|-----|--------|--------|
| EXT-A | `/capabilities` + `X-Extractor-Signature` alias | `d798917`+`808e5cb` | ✅ deployed Asha |
| EXT-B | BYO LLM credentials `X-LLM-*` | `808e5cb` | ✅ deployed Asha |
| EXT-D | Pre-upload signed URL (SSRF-safe) | `808e5cb`+`4a2ad6e` | ✅ deployed Asha |
| EXT-LINE | 10 транспортных полей в `items[]` + 4 doc-level | `42adffc` | ✅ deployed Asha |
| Hybrid routing | text/vision dispatcher | `ef24a8d` | ✅ in code, off by default |
| ASR ingest | `/v1/transcribe` + audio magic-bytes | `164f83e` | ✅ in code (voice-asr container running) |
| Yandex OCR | scan-routing prep | `164f83e` | ✅ in code, ждёт ключа Yandex |
| Sandbox tenants | slai-sandbox + slai-negabarit | provision-sandbox.ts | ✅ created in БД Asha |
| S1 webhook secret | applied для slai-sandbox | direct SQL | ✅ |

### 🟡 В работе / запланировано (приоритет high → low)

| ID | Что | Размер | Зависит от |
|----|-----|--------|------------|
| **MTI-3** | Unify key storage — UI Providers ключ реально доходит до Anthropic | 1-2 дня | — |
| **EXT-LLM-PROXY-B** | OpenAI-compat `/v1/chat/completions` + SSE + tools passthrough + `GET /v1/usage` | 3 дня | MTI-3 |
| **UX-1** | Simple/Advanced toggle в Providers | 1-2 дня | MTI-3 |
| **UX-3** | System Health лента на Dashboard | ½ дня | — |
| **MTI-2** | Model preset bundles — pack моделей в одном provider | 2-3 дня | MTI-3 |
| **UX-2** | One-click «Сделать основным» wizard | 2 дня | UX-1+MTI-3 |
| **UX-4** | Full UI audit по всем 13 экранам | 3-4 дня audit + 1-2 нед impl | UX-1 (как pilot) |
| **MTI-1** | Multi-instance management UI + per-org rate-limit/retention | 2-3 недели | MTI-3 |

### 🔵 По триггеру / отложено

| ID | Что | Триггер |
|----|-----|---------|
| **EXT-LLM-PROXY-C** | Full LLM-gateway (rate-limit + квоты + cost-calc + admin endpoints) | 5+ SLAI-инстансов ИЛИ incident runaway LLM |
| **Latency #3 vLLM Qwen-VL** | Миграция на vLLM | GPU-сервер 96 ГБ VRAM |
| **Latency #4** | qwen2.5vl:7b tuning | — |
| **Epic-5** Local Agent Models bench (Mistral/Llama) | SLAI-side; parsdocs только inference endpoint | GPU-сервер |
| **Epic-8** Voice Command Flow | parsdocs готов; SLAI делает frontend + tool-agent | ASR_BASE_URL в .env + SLAI готов |
| **EXT-C** Multi-tenant LLM-ключи (per-tenant ключ Anthropic) | По требованию SLAI или другого клиента |

### Sequencing после WW-23 пилот-стартa (2026-06-02)

```
W24 (после пилота):  MTI-3 (2д) → EXT-LLM-PROXY-B (3д)
                     В параллель: UX-3 (½ дня), goldens runner на готовых PDF от SLAI
W25:                 UX-1 (Simple toggle) → MTI-2 (pack моделей)
W26:                 UX-2 wizard + UX-4 audit фаза 1
W27+:                MTI-1 multi-instance UI + UX-4 audit фаза 2
По триггеру (Q3-Q4): EXT-LLM-PROXY-C, vLLM, Epic-5, Epic-8
```

---

## История

- 2026-05-17: получено SLAI TZ v1 (Q9), наш ответ создан. F16-F22 закрыты.
- 2026-05-19: F5, F23, F26 закрыты, OpenAPI v1.yaml. Real-doc bench начался.
- 2026-05-20: 4 P0 фрахт-счетов SLAI закрыты (`92745ce`).
- 2026-05-25: Qwen-VL 32B vision впервые проходит SLAI gates (96%/90%), но latency 186-820с.
- 2026-05-26: получен `slai-response-to-parsdocs-2026-05-26.md` (EXT ТЗ согласован), Q10-Q12 закрыты в коде (`d798917`+`808e5cb`), bonus docker prune (`7bbba5a`). Этот документ создан как единый бэклог.
- 2026-05-29: SLAI прислал FOLLOWUP с 4 ответами (Q4/Q5/Q9 + AC9 sandbox). Реализован EXT-LINE (`42adffc`), SECRETS_INBOX, golden fixtures, capabilities `{name, since}`.
- 2026-05-31: deploy Asha `cdbd8d6 → a920e80` (12 коммитов), cleanup 7 фантомных `local-*` провайдеров, sandbox-тенант создан. Написаны MTI-1/2/3 ТЗ + UX-1/2/3 анализ + UI Audit (UX-4) + Epic-5/Epic-8 discussion.
- 2026-06-01: SLAI прислал S1 webhook secret (plain) — applied; provisioned второй sandbox `slai-negabarit` (Q-NEG-1). Получен запрос SLAI на LLM-gateway → решение: **EXT-LLM-PROXY-B** (light proxy + metering) принят в работу, **C по триггеру**. Mistral 7B CPU smoke-bench на Asha (7 tok/s, JSON discipline weak, диск чуть не убит). Полное implementation ТЗ — `EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01.md`.
