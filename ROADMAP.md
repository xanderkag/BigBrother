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

---

## 🟢 Находка качества (2026-05-25) — vision решает точность, упёрлись в latency

Первый бенч на **реальных** документах (9 шт, не синтетика):
- **phi4-text** (текущий прод-дефолт): exact-match 68.3%, критичные 69% — планки SLAI НЕ проходит. Сканы счёт-фактуры сыпались.
- **Qwen2.5-VL 32B vision** (на GPU-боксе `10.10.28.10`, извлечение из картинки): exact-match **90%**, критичные **96%**, сканы СФ **100%** — **впервые проходит обе планки SLAI** (exact ≥0.85, critical ≥0.95).
- **Новый блокер — latency:** vision P50 186с / P95 820с против MVP-SLA 90с (~2-9× мимо).

**План:** (1) **hybrid-routing** — быстрый text/phi4 для чистых text-PDF (в SLA), vision-fallback для сканов/СФ/низкой OCR-уверенности; (2) **достроить extraction-from-image путь** (`image_base64` в `/v1/extract` + мультимодальное сообщение в backend + роутинг в orchestrator — ~1-2 дня, model-agnostic; сейчас vision используется ТОЛЬКО как OCR-фолбэк, не для структурного extract); (3) **latency-оптимизация** (qwen2.5vl:7b, ниже DPI/num_predict, vLLM на сервере 96 ГБ ускорит кратно). Детали — `docs/MODEL_REPORT.md` #26.
**Оговорка:** тест-доки имели text-layer (digital PDF→картинка), не настоящие растровые сканы — перепроверить на golden-set SLAI (Q9, заблокирован).

## 🔵 Перспектива (под сервер 96 ГБ VRAM — в пути)
- **Phi-4-multimodal** — пользователь хочет прогнать через неё; в Ollama не заводится (архитектура vision/audio-LoRA), нужен **vLLM на сервере 96 ГБ**. После прихода сервера: поднять на vLLM + прогнать те же 9 доков, сравнить с Qwen2.5-VL #26.

### ASR / речь-в-текст (новая модальность)
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

- **Per-tenant `provider_settings`** (свой LLM-ключ на клиента) — нет второго платящего клиента.
- **Активное подключение новых потребителей** — CP7 готов в коде, эксплуатацию морозим до валидации ВЭД-пилота.

_Закрыто 2026-05-24: удалён легаси `doc-service/web/` (+ Dockerfile/package.json чистка); UI-6-хвост выровнен под ConfidenceBar; устаревшая запись CP1 в TECH_DEBT исправлена (CP1 давно DB-driven)._

---

## Легенда
🔴 блокер · 🟡 в работе/ближайшее · 🔵 перспектива · 🧊 заморожено · ⏳ ждёт · ⬜ вопрос наружу
