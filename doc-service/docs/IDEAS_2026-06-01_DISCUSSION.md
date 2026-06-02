# Идеи 2026-06-01 — Local Agent Models + Voice + Full UI Audit

**Дата:** 2026-06-01
**Статус:** discussion paper, не финальное ТЗ
**Источник:** user-чат 2026-06-01 после WW-23 пилот-подтверждения
**Цель:** разложить три идеи по границам (что parsdocs / что SLAI), по
sequencing'у и по открытым вопросам — чтобы решить какие брать в roadmap.

---

## TL;DR

| # | Идея | Чьё | Размер | Когда |
|---|------|-----|--------|-------|
| **Epic 5** | Local Agent Models Test — Mistral/Llama для tool-calling vs OpenAI | **SLAI-side** (агент-чат там); parsdocs — только inference endpoint | M (1 неделя bench) | После прихода GPU-сервера 96 ГБ VRAM |
| **Epic 8** | Voice Command Flow — голос → текст → агент → tool | **Split**: parsdocs ASR готов (164f83e); SLAI агент должен принимать text input | S (2-3 дня обе стороны) | После Epic 5 (если local LLM пройдёт) ИЛИ сразу с OpenAI |
| **UX-4** | Full UI Audit — пройтись по всем 13 экранам React UI, найти дубли + technical leak | **parsdocs-side** | M (3-4 дня анализ + 1-2 недели редизайн) | После MTI-3 (UI-1 как pilot единичной страницы); UX-4 = systematic пройтись по остальным |

---

## Epic 5 — Local Agent Models Test (Mistral / Llama)

### Что предлагается

Прогнать **Mistral 7B/22B/Small-3.1** и **Llama 3.2/3.3** в режиме function-calling: дать им JSON-schema тулз (например, наши document_types tool-calls) + пользовательский промпт, проверить:
- понимают ли команду
- выбирают ли правильную тулзу
- заполняют ли параметры по schema
- возвращают ли валидный JSON
- скорость / память / стабильность под нагрузкой

Сравнить с OpenAI gpt-4o-mini / gpt-4o / Claude Sonnet 4-5/4-7 как baseline.

Вывод: можно ли в MVP положиться на local model или временно держать external (OpenAI/Anthropic).

### Где это живёт

Tool-calling агент сейчас **на стороне SLAI** (`api.sls24.ru`). Они зовут LLM с function-schema, агент возвращает tool_call. parsdocs тут вообще не участник — мы document-extractor, не агент-runtime.

Что от parsdocs может понадобиться:
- **Inference endpoint** через который SLAI зовёт Mistral/Llama. У нас `inference-service` готов под `BACKEND=openai_compat` к Ollama/vLLM — это решение из коробки.
- Если SLAI решит «давайте через parsdocs inference» — это просто их `OPENAI_BASE_URL=https://vanga.sls24.ru/v1` (когда inference exposed). Иначе они зовут vLLM на GPU-сервере напрямую.

### Что нужно для эксперимента

| Что | Кто | Готовность |
|-----|-----|------------|
| GPU-сервер 96 ГБ VRAM | внешнее | в пути, ETA неизвестен |
| vLLM на сервере, развёрнутые модели | parsdocs или SLAI | будет когда железо приедет |
| Tool-schema fixture (5-10 тулз SLAI) | SLAI | есть, в их коде |
| Bench-runner (промпты × модели × метрики) | SLAI | нужно написать (~1 день) |
| Метрики: success rate, latency P50/P95, RAM, tokens/sec | SLAI | стандарт |

### Открытые вопросы

1. **Какие именно тулзы тестировать?** SLAI должна выбрать 5-10 наиболее частых сценариев логиста (создать заявку, найти контрагента, привязать счёт к рейсу, итд).
2. **Что считать «успешным» tool-calling?** Сценарий завершился без human-correction? Параметры правильные? Schema-validated?
3. **Baseline budget** — на сколько $/запрос OpenAI sonnet-4-5? Если local 7B даёт 80% качества при 0 стоимости (только электричество) — это win. Если 60% — не годится.
4. **Где гонять bench** — у нас (vanga.sls24.ru) или у SLAI? Кому собирать метрики?

### Решение нужно?

Пока **отложить до прихода GPU-сервера**. Без железа Mistral 22B / Llama 70B не покрутишь. Когда железо будет — отдельный эпик SLAI с поддержкой parsdocs (мы предоставим inference endpoint если попросят).

**parsdocs ничего не делает прямо сейчас по Epic 5.** Просто фиксируем что готовы помочь когда время придёт.

---

## Epic 8 — Voice Command Flow

### Что предлагается

Менеджер / логист / диспетчер на ходу:
1. Записывает голос («создай заявку Москва-Сочи 24 тонны от ИП Иванова, машину дай»)
2. Whisper → текст
3. Агент SLAI парсит команду → tool calls (`create_transport_request`, `find_vehicle`, ...)
4. UI показывает результат либо просит подтверждения

### Где это живёт

Split:

**parsdocs side — готово ✅** (`164f83e` 2026-05-27):
- POST `/v1/transcribe` → Whisper-совместимый эндпоинт в inference-service
- Audio magic-bytes routing в doc-service (wav/mp3/m4a/ogg → ASR engine вместо OCR)
- `ASR_BASE_URL`/`ASR_MODEL` ENV-конфиг
- `voice-asr` контейнер с faster-whisper уже крутится на Asha (вижу в `docker ps`)
- Транскрипт идёт в тот же downstream pipeline (classify → extract → webhook)

**SLAI side — нужно сделать:**
- Frontend: запись аудио, отправка на parsdocs `/api/v1/jobs` (multipart audio)
- Polling `/jobs/:id` или webhook receiver — забрать транскрипт
- Передача транскрипта в их LLM-агент с tool-schema
- Tool-execution + результат пользователю

### Контракт parsdocs ↔ SLAI для voice

```http
POST https://vanga.sls24.ru/api/v1/jobs
Authorization: Bearer <token>
X-LLM-Provider: anthropic
X-LLM-Api-Key: <ваш key>
Content-Type: multipart/form-data

file=<audio.wav>
metadata={"hint": "raw_text"}    ← если только транскрипт нужен, без extract
```

Webhook payload — содержит `extracted.raw_text` с транскриптом. Дальше SLAI агент-чат делает tool-call.

**Альтернатива:** `metadata.hint="voice_command"` (новый тип документа) → parsdocs может попробовать classify команду как «создать заявку» / «найти машину» / etc через keyword classifier, но это менее гибко чем LLM-агент. **Лучше**: SLAI делает tool-call сам, мы просто транскрибируем.

### Что нужно

| Что | Кто | Готовность |
|-----|-----|------------|
| ASR endpoint | parsdocs | ✅ готово |
| Whisper модель на хосте | parsdocs (Asha) | ✅ `voice-asr` faster-whisper small |
| Audio routing в doc-service | parsdocs | ✅ готово |
| Frontend recording (Web Audio API) | SLAI | нужно |
| Audio upload в parsdocs | SLAI | нужно (~½ дня) |
| Webhook receiver / polling | SLAI | сейчас в работе (S1 webhook закрыт) |
| Tool-calling агент над транскриптом | SLAI | у них есть AI-чат, нужен voice-input |
| UX: «слушает / распознал / выполняю / готово» | SLAI | нужно дизайн |

### Открытые вопросы

1. **Качество распознавания на коротких командах** — faster-whisper-small может плохо распознавать жаргон («ТТН», «КПП», «фрахт», номера контейнеров). Нужно тестить.
2. **Latency** — Whisper-small CPU = 1-3 секунды на 5-секундную фразу. Достаточно для UX? Если нет → нужен Whisper-large на GPU (увы, GPU-сервер ещё не приехал).
3. **Push-to-talk vs always-on** — короткая запись по кнопке или wake-word? Push-to-talk проще.
4. **Confirmation step** — после tool-call показывать «я создаю заявку Москва-Сочи 24т, ОК?» или сразу выполнять? Для деструктивных tool'ов — confirmation; для read-only — сразу.
5. **Какие тулзы доступны voice-агенту?** Подмножество tool-schema из SLAI — что часто нужно «на ходу»: create_request / find_vehicle / status_query.

### Что parsdocs может сделать сейчас (без GPU)

- Включить `ASR_ENABLED=true` в inference (уже)
- Прописать `ASR_BASE_URL=http://voice-asr:8000/v1` в `inference-service/.env` (сейчас пустой)
- Прогнать smoke-тест на сэмпле audio
- Подтвердить SLAI'у что endpoint доступен

После этого Epic 8 = SLAI-side задача (frontend + агент).

### Sequencing

- **Можно начать сразу** (не ждёт Epic 5)
- **OpenAI-fallback для агента** пока local LLM не готов — Whisper + OpenAI function-calling это рабочее MVP
- После Epic 5: если local Mistral/Llama работают — переключить агента на local, оставив OpenAI как fallback

---

## UX-4 — Full UI Audit

### Что предлагается

UX_ANALYSIS_2026-05-31.md (UX-1/2/3) — это **точечная** аналитика по `Providers`. Now user предлагает **systematic** audit по **всем 13 экранам** React UI:

```
/login, /dashboard, /jobs, /jobs/:id, /upload, /review,
/document-types, /providers, /audit-log, /settings, /tenants,
/reference-lists, /test-lab
```

### Цели аудита

1. **Дубликаты** — где одна и та же информация показывается в двух местах с риском рассинхрона (например, `Providers.status=active` vs `Dashboard.currentLlmProvider`)
2. **Technical leak** — где видны термины которые пользователь не должен понимать (`parser_kind`, `confidence_threshold`, `llm_schema`, `is_default vs is_active`, slug-имена)
3. **Дефолты которые путают** — поля с дефолтным значением, которое user'у НЕ нужно видеть (`Base URL` для Anthropic — всегда `api.anthropic.com`)
4. **Лишние клики** — где простая задача требует 3+ перехода между страницами
5. **Отсутствие state visibility** — где не понятно «работает» vs «настроено но не активно» vs «ошибка»
6. **Concept mismatch** — два UI-термина для одного концепта (например, "tenant" и "organization", "user" и "operator")

### Метод аудита

Для каждого экрана:
1. Описать **главный сценарий** (что user пришёл сделать?)
2. Посчитать **сколько кликов** требует
3. Перечислить **поля/блоки** + сделать категорию: ✅ essential / 🟡 nice-to-have / ❌ technical-leak
4. Найти **дубликаты** с другими экранами
5. Предложить **simplify** (как UX-1 для Providers)

### Ожидаемые находки (предсказание из анализа Providers)

Я бы поставил что найдём:

- **5-7 экранов** где >50% полей — technical leak (особенно `/document-types`, `/audit-log`, `/test-lab`)
- **3-4 пары** дубликатов между экранами (`/dashboard` метрики vs `/jobs` фильтры; `/providers.status` vs `/settings`)
- **2-3 экрана** которые вообще не нужны 95% пользователей (`/audit-log` — только для админа на инцидентах; `/reference-lists` — только когда меняется ERP схема)
- **1 экран** который **критически не хватает** — onboarding wizard «настроить parsdocs за 5 минут»

### Что в результате

- `UX_AUDIT_REPORT_2026-XX.md` — финдинги по каждому экрану
- `UX_REDESIGN_TZ.md` — план редизайна (расширение UX-1/2/3 + новые эпики UX-4/5/...)
- **Опционально:** Figma-моки самых тяжёлых экранов

### Размер

- **Audit** — 3-4 дня (систематичное прохождение + интервью с user)
- **Implementation** — 1-2 недели зависит от findings (часть может быть «hide field» = 5 минут, часть «новый wizard» = неделя)

### Открытые вопросы

1. **Кто пользователь?** Owner / operator SLAI / SLAI dev / parsdocs admin — у них разные нужды. Audit per-role или для всех сразу?
2. **Что важнее — owner-flow или SLAI-dev-flow?** Сейчас оба в одном UI, может стоит разделить?
3. **Mobile?** Пока нет, но если voice-command flow заработает — мобильная версия может потребоваться.
4. **Onboarding wizard** — нужен ли отдельный поток для нового пользователя «привет, давай настроим Anthropic за 5 минут»? Или сразу dashboard?

---

## Sequencing — мой пред (открыто для обсуждения)

```
СЕЙЧАС (WW-23 пилот):
  → ждём первые webhook'и от SLAI (S1 secret applied, готово)
  → ждём golden dataset (Q9, ETA 02-04.06)

ПОСЛЕ WW-23 (W24-25):
  → MTI-3 unify key storage (1-2 дня) — критично для UI
  → UX-4 audit фаза 1 — пройти топ-5 страниц (Providers, Jobs, Upload, Dashboard, Test Lab)
  → MTI-2 model bundles (3-4 дня)

W26-27:
  → UX-4 audit фаза 2 — остальные 8 страниц
  → UX-1/2/3 implementation
  → MTI-1 multi-instance UI

W28+:
  → Epic 8 voice (parsdocs готов, ждём SLAI frontend)
  → Epic 5 local agents (ждёт GPU-сервер)
```

Это **ориентировочно** — реальная очерёдность зависит от того что важнее в моменте.

---

## Что брать в работу сегодня

Ничего из этих 3 эпиков не блокирующий **WW-23 пилот SLAI** (старт 02.06). Можно:

(A) Зафиксировать всё в гите как этот документ + ROADMAP (то что я делаю)
(B) Ждать понедельника, смотреть как пилот пойдёт
(C) Параллельно: подключить ASR endpoint на Asha (`ASR_BASE_URL` в .env), чтобы Epic 8 был готов сразу когда SLAI попросит — 5 минут SSH

Я бы рекомендовал **A + C**. (B) сам по себе случится — пилот это пилот.

---

## Открытые вопросы → User

1. **Epic 5** — отложить до GPU-сервера или начать с Mistral 7B на CPU прямо сейчас (медленно, но bench-able)?
2. **Epic 8** — нужен сразу для WW-23 или MVP без голоса?
3. **UX-4** — фаза 1 (топ-5 страниц) первой или начинать с MTI-3 unify key (он тоже UX-фикс по сути)?
4. **Onboarding wizard** — нужен в скоупе UX-4?
5. **Что-то ещё накидаешь** — оставлено место под добавки

---

## История

- 2026-06-01: discussion paper после user-чата с тремя идеями
  (Mistral/Llama для агентов, голосовые команды, full UI audit).
  Все три — roadmap-level, не блокируют WW-23 пилот.
