# SLAI Integration — единый бэклог

**Дата:** 2026-06-01 (обновлён; создан 2026-05-26)
**Источник:** `SLAI_TZ_v1_2026-05-17.md`, `slai-response-to-parsdocs-2026-05-26.md`,
SLAI FOLLOWUP 2026-05-29 (`PARSDOCS_REPLY_TO_SLAI_FOLLOWUP_2026-05-29.md`),
`INTEGRATION_QUEUE.md`, `SLAI_SECRETS_INBOX.md`, `MODEL_REPORT.md` #29–35,
`DEPLOY_TOPOLOGY.md`, `ROADMAP.md`

> **Назначение:** одно место, где видно всё что нужно для полной интеграции
> parsdocs ↔ SLAI Суперлогист. Три слоя: контракт (как говорим), содержание
> (что распознаём), операционка (пилот + multi-instance). Каждый пункт со
> статусом и owner'ом.

---

## TL;DR

| Слой | Готовность | Блокер |
|------|-----------|--------|
| **1. Контракт** (extractor adapter API) | ✅ 100% в коде, **задеплоен на Asha (pilot live 31.05)** | флаги BYO/file_url включить; kb-docker — отдельный track |
| **2. Содержание** — типы документов | ✅ 100% (30 типов в Registry, оба фазы SLAI TZ покрыты) | — |
| **2. Содержание** — точность (text-path) | ✅ **mistral-small3.1: поля 98.3%, арифметика 100%** (bench v3, #34/#35) | — |
| **2. Содержание** — точность (vision/сканы) | ✅ Qwen-VL 32B проходит (96%/90%) | перепроверить на реальных сканах (golden Q9) |
| **2. Содержание** — latency | ✅ **text-path в SLA: ~3–26 с ≪ 90 с** (сервер 96 ГБ `10.10.33.10` пришёл) | vision-path (сканы) ещё медленный → hybrid-routing |
| **3. Операционка** — golden dataset | 🟡 ANSWERED 29.05, ждём 15 PDF (ETA 02–04.06) | SLAI side |
| **3. Операционка** — пилот | 🟡 ANSWERED: **WW-23, старт 02.06**, shadow-mode | старт завтра |
| **3. Операционка** — secrets-обмен | 🔴 **S1 webhook-secret не пришёл; ждём age-pubkey SLAI для S2** | SLAI side |
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

| ID | Что | Owner | Статус |
|----|-----|-------|--------|
| **AC 9 / sandbox** | Sandbox-тенант для SLAI (dedicated organization + token) | parsdocs | ✅ **provisioned на Asha 31.05** (org `9a3cb9d3…`, token `slai-sandbox-bot`, expires ~29.08). Plaintext передан владельцу; ждём **age-pubkey SLAI** чтобы зашифровать в S2 |
| **S1 webhook-secret** | SLAI генерит `PARSDOCS_WEBHOOK_SECRET` (`openssl rand -hex 32`), отдаёт через `SLAI_SECRETS_INBOX.md` envelope | SLAI | 🔴 **PENDING** (ETA был 30.05, на 01.06 не пришёл) — без него наш webhook→SLAI не подписать |
| **Contract-test** | SLAI пишет contract-test против `ParsdocsAdapter` в их `ExtractorGateway` (после EXT-A в проде) | SLAI | ждёт |

### Ждёт деплоя

**Deploy-target пилота WW-23 = `asha` (staging/demo, личный хост),
не kb-docker.** Топология — `DEPLOY_TOPOLOGY.md`. SLAI (`api.sls24.ru`,
`app.sls24.ru`) живёт на том же хосте → docker-сеть `ai-platform`, быстрый
итерационный цикл без корп-деплоя.

Состояние на Asha (на 2026-05-31, **pilot live** — commit `d379010`):
- parsdocs обновлён до актуального master (доехали EXT-LINE, `/capabilities`,
  secrets-inbox, golden fixtures, followup reply, hybrid-routing).
- **Sandbox-тенант заведён** (AC9/Q13): org `9a3cb9d3…`, token `slai-sandbox-bot`,
  expires ~29.08, host `https://parsdocs.135.106.158.143.nip.io`.
- `BACKEND=stub` пока — реальный LLM на синтетике/Anthropic через VPN-прокси
  настраивается отдельно (правило хоста: корп-данные не пускаем).
- ASR работает (`voice-asr` + faster-whisper small).

Осталось до старта пилота 02.06:
1. ✅ ~~`git pull` + rebuild на Asha~~ — сделано (live `d379010`).
2. Включить `BYO_LLM_ENABLED=true` + `FILE_URL_INGEST_ENABLED=true` в
   inference `.env` (когда переключим с `stub` на реальную модель).
3. 🔴 Когда SLAI пришлёт webhook secret (**S1, ещё PENDING**) → положить в
   БД parsdocs Asha → включить webhook-receiver (F3).
4. ✅ ~~Создать sandbox-org + token (AC9/Q13)~~ — provisioned; ждём age-pubkey
   SLAI чтобы зашифрованно передать токен (S2).

kb-docker (corp prod) — отдельный track, **не блокер** для SLAI пилота.

---

## Слой 2: СОДЕРЖАНИЕ — что распознаём

### Типы документов — ✅ оба фазы SLAI TZ покрыты (30 в БД)

**Фаза 1 — 10 типов SLAI TZ §1** (состав и порядок строго по ТЗ): `invoice`,
`transport_request`, `TTN`, `transport_invoice`, `CMR`, `waybill`, `UPD`, `AKT`,
`factInvoice`, `payment_order`. Все ✅ (builtin + LLM fallback). Заметные коммиты:
фрахт-атрибуты `invoice.items[]` — `92745ce`; `factInvoice`→LLM fix — `531538b`.

**Фаза 2 — ВЭД (8/8, наш набор сверх §1):** `commercial_invoice`, `proforma_invoice`,
`packing_list`, `bill_of_lading`, `customs_declaration`, `cert_of_origin`,
`eac_conformity_certificate`, `wire_transfer_application` (SWIFT/IBAN). Все ✅, VED schemas — `aa419d3`.

**Дополнительно (12, под кейсы вне §1):** contract, weighing_act, price_list, UKD,
transfer_note, contract_addendum, contract_specification, cash_receipt, power_of_attorney,
warehouse_receipt, warehouse_return, material_requisition.

Итого **30 типов** в БД (`GET /capabilities → supportedDocumentTypes`). Полный реестр —
поля, валидаторы, tier, slug-алиасы, фаза-маппинг SLAI — в **`DOCUMENT_TYPES.md`**
(источник правды) и `SLAI_TZ_v1_2026-05-17.md` (исходный контракт фазы 1).

### Точность — ✅ text-path победитель найден, ⏳ нужен golden dataset SLAI

**Bench v3 (сервер 96 ГБ `10.10.33.10`, текст-слой, 9 реальных фикстур, `MODEL_REPORT.md` #29–35):**

| Модель | Поля (exact) | `total`-арифметика | Время/файл | VRAM | Вердикт |
|--------|--------------|--------------------|-----------|------|---------|
| Phi-4 14B (инкумбент) | 88.3% | 71.4% | 4–32 с | ~9 ГБ | мимо цели |
| Llama 3.3 70B | 98.3% | 100% | 11–89 с | ~43 ГБ | топ-точность, но дорого/медленно |
| Qwen2.5 72B | 98.3% | 100% | 11–119 с | ~43 ГБ | ничья по точности |
| **🏆 Mistral Small 3.1 24B** | **98.3%** | **100%** | **3–26 с (мед. ~5 с)** | **~14–15 ГБ** | **дефолт-кандидат: точность 70B при 5× скорости** |
| Gemma 3 27B | 96.7% | 85.7% | 4–40 с | ~17 ГБ | дешёвый fallback для роутера |

**Победитель — Mistral Small 3.1 24B (text):** догоняет 70B по точности
(поля 98.3%, арифметика 100% — главная бизнес-цель ≥85% взята с запасом), но
влезает в ~15 ГБ и держит медиану ~5 с/док. Кросс-валидирован на независимом
синтетическом корпусе (#35, 10 док) — **оверфита нет**.

**Vision-path (для сканов):** Qwen-VL 32B проходит SLAI-gates (crit 96% /
overall 90% / сканы СФ 100%, `MODEL_REPORT.md` #26/#28), но дорог по latency
(см. ниже). Mistral Small 3.1 vision — первая vision-модель с реальным ИНН (80%).

**Оговорка:** фикстуры имеют text-layer (digital PDF→картинка), не растровые
сканы. Финально перепроверить на golden-set SLAI (**Q9, ждём 15 PDF, ETA 02–04.06**).

### Latency — ✅ text-path в SLA, 🟡 vision-path (сканы) ещё медленный

**Text-path (чистые PDF/DOCX) — в SLA с запасом:**

| Метрика | SLA SLAI MVP | Mistral Small 3.1 24B (text, #34/#35) | Gap |
|---------|--------------|----------------------------------------|-----|
| Медиана | ≤90 с | **~5 с** | ✅ 18× запас |
| Худший | ≤90 с | **~26 с** | ✅ в SLA |

**Vision-path (растровые сканы) — пока мимо:**

| Метрика | SLA SLAI MVP | Qwen-VL 32B vision (#26/#28) | Gap |
|---------|--------------|------------------------------|-----|
| P50 | ≤90 с | 186–202 с | 2× мимо |
| P95 | ≤90 с | 733–820 с | 8–9× мимо |

**План закрытия latency сканов (`docs/ROADMAP.md` Находка качества):**

| # | Шаг | Эффект | Статус |
|---|-----|--------|--------|
| 1 | **Hybrid-routing** — text/Mistral для чистых PDF (в SLA), vision для сканов/низкой OCR-уверенности. Код `ef24a8d`, флаг `HYBRID_ROUTING_ENABLED` | ~80% docs в SLA через text-path | ✅ код есть, ждёт включения на Asha |
| 2 | **Extraction-from-image** путь (image_base64 + multimodal message) | `2aff356` | ✅ сделано |
| 3 | **Сервер 96 ГБ `10.10.33.10`** под Ollama | разблокировал большие модели; bench v3 проведён | ✅ **пришёл** |
| 4 | **qwen2.5vl:7b vs 32b** для сканов: 7b в SLA (18–47 с) но crit/class мимо; 32b проходит, но вне SLA (#28) | компромисс точность/скорость | ⏳ выбрать через golden-сканы |
| 5 | **vLLM continuous batching** для vision на 96 ГБ | кратное ускорение под нагрузкой | ⏳ когда упрёмся в throughput |

---

## Слой 3: ОПЕРАЦИОНКА — пилот + multi-instance

### Открытые вопросы → SLAI (блокеры пилота)

Все три закрыты словесно в **SLAI FOLLOWUP 29.05**; осталась физическая доставка.

| Q | Что | Статус | Что осталось |
|---|-----|--------|--------------|
| **Q4** | Service-token / webhook-secret parsdocs↔SLAI | ANSWERED 29.05 | 🔴 **S1 envelope не пришёл** — SLAI генерит `openssl rand -hex 32`, кладёт в `SLAI_SECRETS_INBOX.md` под наш age-ключ |
| **Q5** | ETA пилота с реальными документами | ANSWERED 29.05 | ✅ **WW-23, старт 02.06**, shadow → замер W3 → prod W4 |
| **Q9** | Golden dataset (15 PDF + 15 .gt.json) | ANSWERED 29.05 | 🟡 ждём файлы, **ETA 02–04.06** — без них нет baseline accuracy |
| **AC9** | Sandbox-тенант (формат изоляции) | ANSWERED 29.05 | ✅ provisioned; ждём **age-pubkey SLAI** для шифрования токена (S2) |

**Действие parsdocs:** пнуть SLAI по двум физическим блокерам — (1) **S1
webhook-secret** (ETA был 30.05, просрочен), (2) **их age-публичный ключ** для
закрытия S2. Оба нужны до запуска webhook-связки 02.06.

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
| F3.1+3 | Webhook-receiver + service-token на стороне SLAI | 🔴 Blocked S1 (webhook-secret не пришёл) |
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

### Сейчас блокирующее (до старта пилота 02.06)

1. **Пнуть SLAI по двум физическим блокерам:** (a) **S1 webhook-secret**
   (`openssl rand -hex 32` в `SLAI_SECRETS_INBOX.md`, ETA был 30.05 — просрочен);
   (b) **их age-публичный ключ**, чтобы зашифровать sandbox-токен в S2.
   Без (a) webhook-связка parsdocs→SLAI не подписывается.

2. **Переключить Asha с `BACKEND=stub` на реальную модель** для пилота
   (mistral-small3.1 через туннель к `10.10.33.10`, либо Anthropic через
   VPN-прокси на синтетике) + включить флаги `BYO_LLM_ENABLED=true`,
   `FILE_URL_INGEST_ENABLED=true`, `HYBRID_ROUTING_ENABLED`.

### Параллельно (не блокирующее)

3. **Свой mini-golden-set** (синтетика / обезличенные RU доки) — прогнать на
   Asha-конфиге, первая честная цифра точности end-to-end. Не ждёт никого.
   ⚠ реальные коммерческие доки из `Доки/` не размечаем (NDA) — только синтетика.
4. **Финальная перепроверка точности на golden-set SLAI** (Q9) — когда придут
   15 PDF (ETA 02–04.06). Bench v3 уже выбрал text-победителя (Mistral Small 3.1).

### kb-docker (corp prod) — отдельный track, НЕ блокер пилота

5. **Деплой на kb-docker** (P0-1+P0-2 из ROADMAP): auth fail-closed, DaData,
   EXT-A/B/D, UI-7, docker prune. Команда:
   `ssh kb-docker 'cd parsdocs/doc-service; sed -i "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env'` → `deploy-parsdocs.yml`.
   (Операция на корп-хосте — через DB Support / Александра.)

### Заморожено до триггера

6. **Multi-instance Суперлогист**: per-org HMAC + outbound webhook per-org + onboarding-скрипт. Размораживаем когда появится второй инстанс/клиент.
7. **EXT-C**: multi-tenant LLM-ключи. Тот же триггер что и #6.

---

## История

- 2026-05-17: получено SLAI TZ v1 (Q9), наш ответ создан. F16-F22 закрыты.
- 2026-05-19: F5, F23, F26 закрыты, OpenAPI v1.yaml. Real-doc bench начался.
- 2026-05-20: 4 P0 фрахт-счетов SLAI закрыты (`92745ce`).
- 2026-05-25: Qwen-VL 32B vision впервые проходит SLAI gates (96%/90%), но latency 186-820с.
- 2026-05-26: получен `slai-response-to-parsdocs-2026-05-26.md` (EXT ТЗ согласован), Q10-Q12 закрыты в коде (`d798917`+`808e5cb`), bonus docker prune (`7bbba5a`). Этот документ создан как единый бэклог.
- 2026-05-29: **SLAI FOLLOWUP** — закрыты Q4/Q5/Q9/AC9. Пилот = WW-23 (старт 02.06), sandbox = separate org + 7d retention + 60 req/min, golden ETA 02–04.06. Заведены S1 (их→наш webhook secret) и S2 (наш→их sandbox token) в `SLAI_SECRETS_INBOX.md`.
- 2026-05-31: **Asha pilot live** (`d379010`) — стек обновлён до master, sandbox-тенант provisioned (`slai-sandbox-bot`, org `9a3cb9d3…`). Ready-to-send сообщения SLAI/DevOps (`bfa9353`). Опубликован наш age-pubkey.
- 2026-06-01: **Bench v3 на сервере 96 ГБ `10.10.33.10`** (`MODEL_REPORT.md` #29–35). Победитель text-path — **Mistral Small 3.1 24B** (поля 98.3%, арифметика 100%, ~5 с/док, ~15 ГБ VRAM), кросс-валидирован (#35, оверфита нет). Latency text-path в SLA с 18× запасом.
