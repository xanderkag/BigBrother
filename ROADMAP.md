# parsdocs — Roadmap (единое место)

> **Это THE доска задач.** Здесь — что делаем сейчас, дальше и в перспективе.
> Детали и история закрытого — в [`TECH_DEBT.md`](TECH_DEBT.md) и
> [`TECH_DEBT_ARCHIVE.md`](TECH_DEBT_ARCHIVE.md). Открытые вопросы к SLAI —
> в [`doc-service/docs/INTEGRATION_QUEUE.md`](doc-service/docs/INTEGRATION_QUEUE.md).
> Obsidian-карточка — обзор для человека, не источник истины по задачам.
>
> Обновлено: 2026-06-23.

---

## 🔴 Сейчас / блокеры

Горящих блокеров нет. Прежние P0 закрыты:
- ✅ **Прод-auth закрыт** — `API_KEY` задан (64 симв.), `ALLOW_NO_AUTH` выключен, запрос без ключа → `401`. (Был 🔴 «любой в корп-сети = super_admin».)
- ✅ **Деплой fail-closed auth** — выкачен, сервис не стартует с пустым ключом.

| # | Задача | Статус | Примечание |
|---|---|---|---|
| P0-3 | Уточнить у Павла: **публичен ли `:8085` наружу** | ⬜ вопрос | Уже не критично (auth закрыт), но знать стоит — определяет, нужен ли firewall-ограничитель. |

---

## 🟡 Приоритеты сейчас

0. **Классификатор v2 — пакеты БКТ (ТЗ `TZ_CLASSIFIER_PACKET_V2.md`, golden `BCTT_GROUNDTRUTH.md`, github/main `3448e74`).** Ручной разбор 51 дока показал: ~35/51 — композиты (стопка 3–15 доков в одном скане), пайплайн вешает один тип на всю стопку — главный провал. Реализующий агент ведёт по фазам:
   - **Фаза 1 (§8 ПДн + §5 каталог) — делать ПЕРВЫМ, гейтит прод.** §8: маскировать паспорт в `raw_text` (orchestrator.ts:732 + routes/jobs.ts:745 `reply.send(job.raw_text)`), redact `documents[]` в webhook-delivery.ts (обходит `redact_pii`, сверено), не слать паспортные страницы в облачный classify/extract, дописать MRZ + иностранные коды в pii-redact.ts (сейчас только `passport_rf`/`driver_license`). Плюс каталог 6 типов (`excise_ead`, `vehicle_registration`, `driver_passport`, `transport_permit`, `certificate_register`, `delivery_note`, tier=beta) + мультиязычные якоря.
   - **Фаза 2 (§4 сегментация P0)** — per-page + границы, правило «тот же MRN/№ инвойса → тот же сегмент». Порядок жёсткий: §8 → §4 (иначе сегментация умножает утечку ПДн).
   - **Фаза 3 (§P2)** — доводка.
   - **Ждёт SLAI:** 3 Q-блока (`Q-CLSF-PII-1` блокер / `Q-CLSF-ONTO-1` / `Q-CLSF-CONTRACT-1` в INTEGRATION_QUEUE) — реализация Фазы 1 идёт независимо от ответов. Сообщение отправлено (`SLAI_QUESTIONS_2026-07-12.md`).
1. **Качество — честный замер на прод-конфиге.** Собрать свой mini-golden-set (10–15 реальных RU доков — счёт/УПД/ТТН) + честный замер точности на текущем проде (дефолт уже `phi4`). Даёт первую честную цифру «до/после». Самый большой рычаг по точности.
2. **SLAI — нуднуть продакта** (на их стороне): Q4 (service-token), Q5 (ETA пилота), Q9 (golden dataset). См. INTEGRATION_QUEUE.
3. **MTI-беклог** (хранение ключей / модели / multi-instance): MTI-3 (унификация хранения ключей — **делать ПЕРВЫМ**) → MTI-2 (пресеты моделей) → MTI-1 (multi-instance SLAI UI).
4. **UX-беклог** (экраны провайдеров/здоровья): UX-1 (Simple/Advanced в Провайдерах) → UX-2 (мастер «сделать основным») → UX-3 (System Health лента) → UX-4 (полный аудит 13 экранов).
5. **EXT-LLM-PROXY-B** — расширение шлюза: chat + streaming + tools + embeddings + метеринг. **После MTI-3.**

---

## ✅ Сделано

- **Ключи каналов шлюза — owner вносит сам через UI (2026-07-11, `5a34d40`)** — экран «Подключения → Ключи каналов шлюза · SLAI»: Anthropic (chat) / OpenAI (embeddings) / DaData вносятся в модалке, шифруются at-rest (AES-256-GCM), наружу только маска; `GET/PUT /api/v1/gateway/keys`. Chat-ключ развязан с default-моделью разбора (выделенная строка `gateway-anthropic`). Закрывает «§4 ключи» из SLAI reply 2026-07-11 без секрет-каналов и правки .env. Остался ops-хвост: PAT `slai-sandbox` + rate-limit 600/мин (INTEGRATION_QUEUE Q-SANDBOX-PAT-1).
- **Каталог типов: создание новых типов закрыто (38 активных в проде).** Сначала 4 складских (`power_of_attorney`/М-2, `warehouse_receipt`/МХ-1, `warehouse_return`/МХ-3, `material_requisition`/М-11), миграция `20260621000001`. Затем все 8 EXT-CLASS-типов созданы + задеплоены на прод (миграции `20260621000002/3/4`): `special_permit`, `booking_request`, `awb`, `manifest`, `phytosanitary_certificate`, `veterinary_certificate`, `cim`, `smgs`. Все распознаются без hint + извлекаются. **Эпики EXT-CLASS-1/2/3 в части СОЗДАНИЯ типов выполнены.**
- **Merge github→main + деплой на прод (2026-06-23, `6532be5`)** — сборка LLM-gateway влита в `main` и выкачена на прод (api/worker пересобраны, BL-миграция применена). Код gateway-фич (Anthropic-бэкенд шлюза, `/v1/embeddings` через OpenAI, DaData-passthrough, providers-fallback) на проде, но эндпоинты спят за фича-флагами (см. блок ниже).
- **Дефолт извлечения переключён mistral → `phi4`** — бенч точности 2026-06-18: phi4 91% против mistral 48% на 4 типах (mistral мис-ярлычил стороны ТТН/CMR). УПД переведён с регекса на полный ИИ — **все типы теперь на `parser_kind=llm_extract`**.
- **Акт-lockstep с SLAI ЗАКРЫТ с обеих сторон** — projector `services_act` в `_match_signals` (party_a→`executor`, party_b→`customer`); SLAI читает `executor`+`customer` по ИНН.
- **Контракт `_match_signals` для SLAI** — канонические сигналы (containers / bl / ttn / cmr / `order_refs` / vehicle / parties / dates / totals + `_confidence` + `schema_version`); задеплоен. Стороны ТТН/CMR больше не пустые (фикс mistral-мис-ярлыков).
- **Каналы петли улучшения** — `job_feedback` (внешние оценки: verdict + comment, источник из ключа) + `extraction_corrections` (правки операторов: before→after, по типу/источнику/кто правил).
- **LLM-шлюз (Vanga) живой** — `/v1/chat/completions` + `/v1/models`, только локальные модели, tool-use подтверждён; SLAI ходит именованным ключом.
- **Концепт «Системы / интеграции»** — сервисные аккаунты (`kind=service`) + выдача ключей через UI; SLAI заведён как система; лог внешних обращений поимённо.
- **UI** — IA-рефактор навигации (4 блока; split Организации / Доступ; хаб «Настройки» с вкладками); дашборд «за сутки» + здоровье вебхуков; копируемый модал токена (работает на http); «approve & next» в ревью.
- **Каталог провайдеров вычищен** — убраны битые слоты, добавлены `qwen2.5:72b` / `qwen3:32b` / RuadaptQwen.
- **Безопасность прода** — закрыт прежний блокер «прод открыт без ключа».

---

## 🧰 Готово, но выключено (за фича-флагом — включение на владельце)

| Возможность | Флаг | Зачем |
|---|---|---|
| Hybrid routing (текст/картинка) | `HYBRID_ROUTING_ENABLED` | главный рычаг по latency |
| Извлечение из картинки | `provider.vision` / `metadata._extract_from_image` | сканы без текст-слоя |
| Приём документа по ссылке | `FILE_URL_INGEST_ENABLED` | большие файлы без 50MB-лимита |
| Клиентский ключ модели (BYO LLM) | `BYO_LLM_ENABLED` | consumer на своём LLM |

> **LLM-шлюз: задеплоен на прод 2026-06-23** (merge github→main `6532be5`, api/worker пересобраны): Anthropic-бэкенд шлюза (OpenAI↔Anthropic translator), `/v1/embeddings` через OpenAI, DaData-passthrough (`/v1/dadata/findById/party`), providers-fallback, фикс-миграция BL. **Эндпоинты спят за фича-флагами** (`embeddings`/`dadata` `enabled=false`, `backend=openai_compat`) — `/v1/embeddings` и `/v1/dadata` отдают `503` fail-closed. Ждёт включения флагов + cutover SLAI после WW-23 демо. См. INTEGRATION_QUEUE Q-DADATA-1 и § Перспектива.

---

## 🔵 Перспектива

- **⬜ FILE-STORAGE-1 — источник истины по файлам (важное архитектурное решение перед массовым SLAI-load'ом).** Сегодня: клиент шлёт multipart → мы сохраняем в `<STORAGE_DIR>/uploads/…`, ретеншен подчищает через N дней. Наш UI показывает файл через `GET /jobs/:id/file` (side-by-side preview). При массовом SLAI-ингесте всплывает вопрос: файл нужен обоим UI (нашему + предположительно их). Три модели:
  - **(1) Наша копия — источник** (as-is). SLAI-UI ходит к нам за байтами. Плюс: независимость от их шары. Минус: дубль хранения.
  - **(2) Общий стор (MinIO/S3) — источник**. SLAI кладёт объект → шлёт нам `file_url` + `file_sha256`. Обе стороны видят один объект. Плюс: no-dup, чистая развязка. Минус: нужен MinIO в проде + договорённости о bucket/access.
  - **(3) SLAI-шара (SMB/NFS) — источник**. Мы монтируем read-only, читаем в pipeline без копирования. Плюс: privacy + no-dup. Минус: сильная связка, их SMB упадёт — мы стоим.
  Триггер к решению: до подключения SLAI-массового потока. Обсудить с их DevOps: кто хочет быть source-of-truth и есть ли уже MinIO/S3 у них.
- **EXT-CLASS — доводка типов под ВЭД/логистику (создание типов сделано, см. ✅ Сделано; осталась настройка существующих, ждёт реальных PDF от SLAI):**
  - **Тюнинг классификатора `waybill`** — чтобы не падал в unknown/ttn на реальных хитах (ждёт 1-2 PDF, Q-CLASS-MATRIX §6).
  - **Тюнинг `commercial_invoice` под ВЭД** — incoterms / hs_code / country_of_origin / customs_value (ждёт PDF с ВЭД-полями).
  - **Расширенная extraction-схема `special_permit` (Q-PERMIT-1)** — slug создан, расширяем поля: `valid_from` / `waypoints[]` / `axle_loads_kg[]` / `restrictions` + escort enum. Ждёт 1-2 реальных PDF Росавтодора (W24).
- **Под сервер 96 ГБ VRAM (в пути):** vLLM-миграция Qwen-VL, Phi-4-multimodal; Epic-5 (агент-модели); латентность vision (#3).
- **Голос → текст (ASR)** — приёмный путь готов (за `ASR_ENABLED`), ждёт модель + `ASR_BASE_URL`. «OCR для звука»: транскрипт → тот же pipeline.
- **DaData live + фаза 2** — обогащение/нормализация адресов; код готов, ввести ключ в UI.
- **Петля улучшения v2** — авто-отчёт гипотез по накопленным правкам и оценкам (сейчас разбор руками).
- **EXT-LLM-PROXY-C** — расширение шлюза до full gateway (per-org rate-limit, квоты, cost-calc) — по триггеру (5+ инстансов SLAI или incident).
- **EXT-LLM-GATEWAY-DADATA** — passthrough `POST /v1/dadata/findById/party` (+опц. `/suggest/party`) к suggestions.dadata.ru с нашим `DADATA_API_KEY` (env или `provider_settings kind='dadata'`). Тонкий passthrough, native DaData-shape в обе стороны, usage-log per-PAT, auth `Authorization: Token <key>` (не Bearer). **Задеплоен на прод 2026-06-23, эндпоинт спит за флагом `dadata` (`enabled=false` → `503`)**; ждёт включения флага в пакете с cutover SLAI на наш gateway после WW-23 демо. См. INTEGRATION_QUEUE Q-DADATA-1.

---

## 🧊 Заморожено (YAGNI до триггера)

- Алёрты на пороги (needs_review > 40% → notify) — нужен механизм нотификаций.
- Стоимость в ₽/$ (токены × прайс) — вынести прайсы в config.
- ~~Time-series графики на дашборде~~ — сделано 2026-07-08 (endpoint + SVG-график, см. ✅ Сделано).

---

## Легенда
🔴 блокер · 🟡 приоритет/ближайшее · 🔵 перспектива · 🧰 готово-выключено · ✅ сделано · 🧊 заморожено · ⬜ вопрос наружу
