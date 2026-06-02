# parsdocs — Roadmap (единое место)

> **Это THE доска задач.** Здесь — что делаем сейчас, дальше и в перспективе.
> Детали и история закрытого — в [`TECH_DEBT.md`](TECH_DEBT.md) и
> [`TECH_DEBT_ARCHIVE.md`](TECH_DEBT_ARCHIVE.md). Открытые вопросы к SLAI —
> в [`doc-service/docs/INTEGRATION_QUEUE.md`](doc-service/docs/INTEGRATION_QUEUE.md).
> Obsidian-карточка — обзор для человека, не источник истины по задачам.
>
> Обновлено: 2026-05-23.

---

## 🔴 Сейчас / блокеры

| # | Задача | Статус | Примечание |
|---|---|---|---|
| **P0-1** | **Деплой `243fe04`** (auth fail-closed + DaData) на прод | ⏳ ждёт прод-`API_KEY` | Код в гите и в bare-репо сервера, **не выкачен**. Новый код намеренно не стартует с пустым ключом. |
| **P0-2** | **Прод-auth открыт** | 🔴 живёт | `API_KEY` на проде пустой → `bearerAuthHook` пускает любого как super_admin. Закрывается тем же шагом P0-1: поставить ключ в `~/parsdocs/doc-service/.env` (1 SSH-строка) → деплой → проверить 401. |
| **P0-3** | Уточнить у Павла: **публичен ли `:8085` наружу** | ⬜ вопрос | Определяет реальную срочность P0-2 (если торчит в интернет — критично). |

**Команда для P0 (выполняет владелец, harness блокирует запись прод-секретов из агента):**
```bash
ssh kb-docker 'cd parsdocs/doc-service; sed -i "s/^API_KEY=.*/API_KEY=$(openssl rand -hex 32)/" .env; echo DONE'
```
После `DONE` → выкатить `243fe04` (pull + build + up; миграции прогонит сервис `migrate`).

---

## 🟡 Дальше (ближайшие недели)

| Задача | Зависит от | Примечание |
|---|---|---|
| **DaData live** — ввести ключ в UI (Провайдеры → DaData) + включить тумблер `enrich_enabled` у потребителя | P0-1 | Код готов. Secret-key (очистка адресов) — позже. |
| **Качество на реальных данных** — собрать свой mini-golden-set (10-15 реальных RU счетов/УПД/ТТН) + прогнать eval на **прод-конфиге (Qwen-VL)** | — | Первая честная цифра точности. Не ждёт SLAI. Разблокирует решение по моделям. |
| **SLAI разблокировка** — нуднуть Q4 (service-token) + Q5 (ETA пилота) + Q9 (golden dataset) | SLAI | Все три на их стороне. См. INTEGRATION_QUEUE. |
| **F3 items 1+3** — webhook-receiver + service-token `slai` | Q4/Q5 | 0.5 дня после разблокировки. |
| ~~**EXT-A** — `/capabilities` + `X-Extractor-Signature`~~ | — | ✅ код+тесты (`808e5cb`), ждёт деплоя. Q10. |
| ~~**EXT-B** — BYO LLM credentials (`X-LLM-*` headers)~~ | — | ✅ код+тесты (`808e5cb`), ждёт деплоя + `BYO_LLM_ENABLED`. Q11. |
| ~~**EXT-D** — Pre-upload signed URL (приём файла по URL)~~ | — | ✅ код+тесты (SSRF-safe, fail-closed за `FILE_URL_INGEST_ENABLED`), ждёт деплоя. Q12. |
| **Bonus** — `docker prune` шаг в deploy.yml | — | 5 мин. Защита от забивания диска build-cache'ем (у SLAI забило 60ГБ, превентивно ставим у себя). |
| ~~**UI-7** — срезы Dashboard~~ | — | ✅ 2026-05-23 (engine + tier; consumer отложен). В `0807285`, ждёт деплоя с P0-1. |
| **MTI-3** — unify key storage (UI Providers ключ реально доходит до Anthropic, а не лежит в БД мёртвым) | — | 1-2 дня. **Делать первым** перед MTI-1/2, иначе они бессмысленны. ТЗ — `doc-service/docs/MTI_TZ_2026-05-31.md`. Чинит обнаруженную 2026-05-31 архитектурную путаницу (3 места для одного ключа). |
| **MTI-2** — model preset bundles (один Anthropic-провайдер = pack моделей sonnet/opus/haiku) | MTI-3 | 2-3 дня (backend+UI). Per-job выбор через `metadata._llm_model` + Test Lab dropdown + опц. auto-routing по типу документа. |
| **MTI-1** — multi-instance SLAI management UI (страница Consumers + mass-actions + presets + Push to SLAI inbox) | MTI-3 (желательно) | 2-3 недели вместе с миграцией per-org rate-limit/retention. Размораживает CP7 multi-tenant CRUD (триггер: 3+ SLAI-инстансов на горизонте). |
| **UX-1** — Simple/Advanced toggle в Providers (скрыть 5 из 8 полей под Advanced, дать happy-path) | MTI-3 | 1-2 дня UI. ТЗ — `doc-service/docs/UX_ANALYSIS_2026-05-31.md`. Источник: user-фидбэк 2026-05-31 «зачем 8 полей, легко ошибиться». |
| **UX-2** — One-click «Сделать основным» wizard (вместо 5 шагов через 3 системы) | UX-1 + MTI-3 | 2 дня UI + ½ дня backend (runtime BACKEND switch без рестарта). |
| **UX-3** — System Health лента (Dashboard top-bar показывает что работает, что сломано, куда идти чинить) | — | ½ дня UI. Источник: capabilities + health-checks, уже доступны. |
| **UX-4** — Full UI audit по всем 13 экранам React UI (дубликаты + technical leak + лишние клики + missing states) | UX-1 | 3-4 дня анализ + 1-2 недели implementation. Источник: `doc-service/docs/IDEAS_2026-06-01_DISCUSSION.md`. |
| **Epic-5** — Local Agent Models bench (Mistral/Llama vs OpenAI для tool-calling) | GPU-сервер 96 ГБ VRAM | SLAI-side эпик. parsdocs может предоставить inference endpoint. После прихода железа. |
| **Epic-8** — Voice Command Flow (Whisper → агент → tool) | ASR endpoint в .env | parsdocs ASR pipeline готов (`164f83e`); ждёт `ASR_BASE_URL` в `inference-service/.env` + SLAI frontend recording. ~2-3 дня обе стороны. |
| **EXT-LLM-PROXY-B** — light LLM-gateway (chat completions + streaming + tools passthrough + usage metering, БЕЗ per-org quotas/RL) | MTI-3 (must) | **Owner-decision 2026-06-01: B сейчас, C по триггеру (5+ инстансов SLAI или incident).** Implementation ТЗ — `doc-service/docs/EXT_LLM_PROXY_B_IMPL_TZ_2026-06-01.md`. Размер MTI-3 (2д) + EXT-LLM-PROXY-B (3д) = ~неделя. После: SLAI инстансы переключают `api.anthropic.com` на `vanga.sls24.ru/v1/chat/completions`. |
| **EXT-LLM-PROXY-C** (отложено по триггеру) | EXT-LLM-PROXY-B + MTI-1 | Расширение B до full gateway (per-org rate-limit + квоты + cost-calc + admin endpoints + webhook'и). Делать при 5+ SLAI-инстансов ИЛИ первом incident'е runaway LLM-расхода. ТЗ — `doc-service/docs/EXT_LLM_PROXY_TZ_2026-06-01.md` §Вариант C. |

---

## 🟢 Находка качества (2026-05-25) — vision решает точность, упёрлись в latency

Первый бенч на **реальных** документах (9 шт, не синтетика):
- **phi4-text** (тогдашний дефолт, до bench v3 — позже смещён на mistral-small3.1): exact-match 68.3%, критичные 69% — планки SLAI НЕ проходит. Сканы счёт-фактуры сыпались.
- **Qwen2.5-VL 32B vision** (на GPU-боксе `10.10.28.10`, извлечение из картинки): exact-match **90%**, критичные **96%**, сканы СФ **100%** — **впервые проходит обе планки SLAI** (exact ≥0.85, critical ≥0.95).
- **Новый блокер — latency:** vision P50 186с / P95 820с против MVP-SLA 90с (~2-9× мимо).

**План:** (1) **hybrid-routing** — быстрый text/phi4 для чистых text-PDF (в SLA), vision-fallback для сканов/СФ/низкой OCR-уверенности; (2) **достроить extraction-from-image путь** (`image_base64` в `/v1/extract` + мультимодальное сообщение в backend + роутинг в orchestrator — ~1-2 дня, model-agnostic; сейчас vision используется ТОЛЬКО как OCR-фолбэк, не для структурного extract); (3) **latency-оптимизация** (qwen2.5vl:7b, ниже DPI/num_predict, vLLM на сервере 96 ГБ ускорит кратно). Детали — `docs/MODEL_REPORT.md` #26.
**Оговорка:** тест-доки имели text-layer (digital PDF→картинка), не настоящие растровые сканы — перепроверить на golden-set SLAI (Q9, заблокирован).

## 🔵 Перспектива (под сервер 96 ГБ VRAM — в пути)
- **Phi-4-multimodal** — пользователь хочет прогнать через неё; в Ollama не заводится (архитектура vision/audio-LoRA), нужен **vLLM на сервере 96 ГБ**. После прихода сервера: поднять на vLLM + прогнать те же 9 доков, сравнить с Qwen2.5-VL #26.

### ASR / речь-в-текст (новая модальность)
**✅ Приёмный путь построен технически (`164f83e`)** — model-agnostic, config-driven, без ключа: audio (wav/mp3/m4a/ogg, magic-bytes) → inference `POST /v1/transcribe` → конфигурируемый OpenAI-совместимый `/v1/audio/transcriptions` бэкенд (`ASR_BASE_URL`/`ASR_MODEL`) → транскрипт → тот же pipeline. За флагом `ASR_ENABLED` (default off). Серверная модель («простая на сервере») подключается через env, деплой — в другом месте. Тесты: 35 doc + 10 inference. Остаётся: поднять модель + включить флаг + (опц.) doc-типы `voice_message`/`call_transcript`.

**Идея интеграции:** ASR = «OCR для звука». Транскрипт → тот же downstream-пайплайн
(classify → extract → validate → webhook), без изменений после получения текста.

- **Модели в inference-service** (Python/GPU), новый эндпоинт `/v1/transcribe`, тот же admission-gate что в A1.
- **doc-service**: ASR как «text-extraction engine» рядом с OCR; роутер выбирает по mime-type; audio magic-bytes (wav/mp3/m4a/ogg).
- **Стек:** GigaAM v2 (RNNT) + Silero VAD — **MVP**. faster-whisper large-v3 — fallback/сравнение. WhisperX / pyannote.audio — диаризация (несколько спикеров), фаза 2.
- **152-ФЗ:** все модели **локальные** — ничего в облако, безопаснее облачного SpeechKit.
- **Открытый скоуп:** какой звук и зачем (звонки логистов / голосовые заявки / встречи) — определяет extract-схему и нужность диаризации.

### Прочее под тот же сервер
- **vLLM-миграция Qwen-VL** — throughput через continuous batching. Сейчас in-process (GIL-bound). Берём, когда упрёмся в нагрузку.
- **DaData фаза 2** — очистка/нормализация адресов (ФИАС) через cleaner-API (secret-key уже хранится в `provider_settings.extra`).

---

## 🧊 Заморожено (YAGNI до триггера)

- ~~**Per-tenant `provider_settings`**~~ — **РАЗМОРОЖЕНО 2026-05-31** в виде MTI-1 (per-org overrides + multi-instance UI). Триггер: 3+ SLAI-инстансов на горизонте.
- ~~**Активное подключение новых потребителей**~~ — **РАЗМОРОЖЕНО 2026-05-31** в виде MTI-1. CP7 multi-tenant CRUD идёт в работу.

_Закрыто 2026-05-24: удалён легаси `doc-service/web/` (+ Dockerfile/package.json чистка); UI-6-хвост выровнен под ConfidenceBar; устаревшая запись CP1 в TECH_DEBT исправлена (CP1 давно DB-driven)._

---

## Легенда
🔴 блокер · 🟡 в работе/ближайшее · 🔵 перспектива · 🧊 заморожено · ⏳ ждёт · ⬜ вопрос наружу
