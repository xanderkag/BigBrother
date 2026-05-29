---
project: parsedocs (BigBrother / doc-service)
status: production
updated: 2026-05-25
next_step: Tier 1 оптимизации (drop raw_text из list, partial-index needs_review, /jobs/summary, smart refetch, sourcemaps off) + прогон qwen3:14b на bench v2
---

# parsedocs — STATUS

Универсальная платформа OCR + structured extraction для деловых
документов (УПД, ТТН, счета, акты, договоры, ВЭД-доки и т.п.).
Production: <https://parsedocs.taipit.ru/ui/>.

Главный индекс тестов: [`docs/TESTS_INDEX.md`](./docs/TESTS_INDEX.md).
Карта инфры / гра́блей деплоя — см. `~/parsdocs/DEPLOY.md` на проде +
сессия чата 2026-05-25 (pocket-guide).

## Цель

Принимать любые входящие документы (PDF / scan / DOCX / xlsx / EML →
автоматический OCR → классификация типа → LLM extract → валидация по
доменным правилам → webhook в учётные системы. Заменить ручной ввод
в бухгалтерии/логистике ТАЙПИТ.

## Открытые

### Tier 1 — эта неделя (~3 ч суммарно, низкий риск)

- [ ] Drop `raw_text` из list-responses (`/jobs?limit=50`) — выкинуть в
      отдельный `toApiList()`; UI читает только в JobDetail. Эффект:
      −90% трафика на render JobsList.
- [ ] Partial-index `CREATE INDEX idx_jobs_needs_review ON jobs
      (created_at DESC) WHERE status='needs_review'`. Review откроется
      в 5-10× быстрее при росте очереди.
- [ ] Endpoint `GET /api/v1/jobs/summary` → `{total, by_status, by_type}`.
      Sidebar + JobsList tabs + Review header дёргают один cached
      запрос вместо 12 (сейчас 6+6 параллельных `?limit=1&status=X`).
- [ ] Smart refetch — `refetchInterval` только когда на странице есть
      pending/processing. Idle вкладка = 0 polling.
- [ ] Vite prod: `sourcemap: 'hidden'` или `false`. Бандл с 2.5 MB до ~0.8 MB.
- [ ] Прогон `qwen3:14b` (уже на узле `.28.10`) на bench v2 + 6-pdf real
      golden — может оказаться новым бесплатным дефолтом вместо Phi-4.

### Tier 2 — 1–2 недели

- [ ] Lazy-load `pdf-vendor` chunks только на JobDetail (React.lazy +
      Suspense). Initial load UI в 2× быстрее.
- [ ] Реальный `/healthz` → индикатор «all systems normal» в TopBar.
      Сейчас плашка статичная.
- [ ] Migration 0032 — финальный Cyrillic `\b` fix для счёт-оферта.
      В 0031 правка есть, но миграция уже отмечена `done`, поэтому не
      применилась.
- [ ] Bulk-reject endpoint + кнопка в ReviewQueue BulkBar (мирно massово
      `failed` без webhook).
- [ ] Per-type model router: простые типы (счёт, накладная) → лёгкая
      модель (`yandex-lite` / `qwen3:8b`), сложные (УПД с длинными
      таблицами) → Phi-4 / Gemma 27B. Срежет среднее время.
- [ ] **InternVL3 8B** на узле `.28.10` (требует пулла владельцем узла)
      → закрытие слабого места vision-трека.

### Tier 3 — долгосрок / стратегия

- [ ] Production-замер на 30–50 реальных док от бухгалтерии. Цель ≥85%
      точности по полям; ниже — prompt-tuning / vision fallback.
- [ ] LLM response cache (hash prompt+model → cached, TTL 24h). Срежет
      30-50% LLM cost на пере-классификациях/dev-сценариях.
- [ ] Dashboard fillout — throughput, by_type/by_model, средняя
      confidence, alerts.
- [ ] CI deploy — post-receive hook на `~/parsdocs.git`. Push = автосборка.
- [ ] ERP/WMS интеграция — справочники контрагентов/номенклатуры
      автоматом, не вручную через `RefLists`.
- [ ] Расширение типов под ТАЙПИТ: доверенности М-2, путевые листы,
      авансовые отчёты.
- [ ] Pre-processing: HEIC (iPhone), DOCX, EML с вложениями, ZIP-архивы.
- [ ] Webhook-уведомления другим системам ТАЙПИТ при approve.

### Известные баги / тех. долг

- [ ] Single-shot LLM падает на длинных текстах (>20k chars от tesseract).
      Нужен chunking/multipass — частично сделан в `pipeline/parse/multipass`,
      но порог нужно тюнить (см. `docs/CLASSIFIER_MULTIPASS_FIX_2026-05-18.md`).
- [ ] Classifier priority: generic patterns бьют specific (УПД vs простая
      накладная). Веса добавлены, дальше — наблюдать на реальных доках.
- [ ] Vision-модели плохо считают `total` (лучший Mistral-3.1 vision =
      20%). Использовать **только** для сканов без OCR-слоя, не как
      замену text-пайплайна.

### Ждёт внешних факторов

- [ ] Корп-шлюз `llm.taipit.ru` (DB Support) → без него Claude Sonnet 4.6
      нельзя на реальных данных
- [ ] Доступ к узлу `.28.10` для пулла новых моделей (не наш `.13.10`)
- [ ] Регламент приёмки L1→L2 (Памятка автору, v0.2+)

## Сделано

- [x] ✅ 2026-05-25 `TESTS_INDEX.md` — единый индекс всех испытаний моделей
      (#2-28), реальных прогонов и eval-скриптов. Запушено на 3 remote.
- [x] ✅ 2026-05-25 LLM model column в JobsList (`Model / OCR` стэк).
- [x] ✅ 2026-05-25 Прогон #28 — Qwen2.5-VL 7B vs 32B head-to-head на 6 PDF.
- [x] ✅ 2026-05-25 fix(ui) job_id → job.id mapping в queries —
      latent bug со времён релиза UI v2: ссылки `/jobs/${job.id}`
      уходили в `/jobs/undefined`. Один transform-layer в normalizeJob().
- [x] ✅ 2026-05-25 ReviewQueue refactor v2: stats grid (всего / реал-синт /
      conf / топ-проблема), 3 filter strips (origin/type/issue-category),
      group-by-doc-type, extracted preview с подсветкой flagged fields,
      Reprocess/Approve actions, sticky bulk-bar.
- [x] ✅ 2026-05-25 Synth/real origin filter (lib/synthetic.ts) +
      `synth` бейдж в FILE-колонке + индикатор «на странице: N real/M synth».
- [x] ✅ 2026-05-25 fix(audit-log) BIGSERIAL `id` → `Number()` cast
      (pg возвращает bigint строкой, zod-schema падал).
- [x] ✅ 2026-05-25 fix(server) redirect `/ui` (без слеша) → `/ui/`.
- [x] ✅ 2026-05-19 Brutalist UI redesign — 4 раунда:
      1. JobsList: tab-стрипы со счётчиками, 10 колонок (File/ID-split/
         Type/Status/Confidence-bar/Total/VAT/Issues/Engine/Age),
         ConfidenceBar компонент.
      2. Layout sidebar 240px + breadcrumb TopBar + live-counters.
      3. SearchBox в TopBar — ⌘K, 250ms debounce, ESC очистка,
         q-filter с ILIKE/INN-prefix в backend.
      4. Bulk-select + bulk-approve/reprocess через Promise.allSettled.
- [x] ✅ 2026-05-19 Backend: `jobsRepo.count()` + `total` в
      `ListJobsResponse` (для tab-счётчиков и «X of Y rows»).
- [x] ✅ 2026-05-19 SHA-256 cache (migration 0027 + `computeFileSha256`
      stream-hash). Re-upload того же файла за 24h → cached job_id
      без новой обработки.
- [x] ✅ 2026-05-18 workerConcurrency 1 → 2 (LLM bottleneck сетевой,
      2 worker'а параллелят OCR одного и LLM-ожидание другого).
- [x] ✅ 2026-05-18 Bulk-fix Cyrillic `\b` → `(?:^|\W)/(?:\W|$)` для
      30+ classification keywords (migration 0026 global).
- [x] ✅ 2026-05-18 fix(ui) ApiResponse error message extraction —
      Fastify zod выдавал «Bad Request», UI читает `message > error`.
- [x] ✅ 2026-05-18 OCR refusal detector (`pipeline/ocr/refusal.ts`).

## Решения / вехи

- 🥇 **2026-05-17** Phi-4 14B выбран локальным production-дефолтом
      (bench v2 прогон #17): лучшая арифметика `total` 60%, 34 сек/файл,
      влезает в 20 GB VRAM узла `.28.10`. См. `docs/MODEL_REPORT.md`.
- ☁️ **2026-05-17** Claude Sonnet 4.6 — облачный target для SLAI-пилота
      (прогоны #21-22): 5× быстрее локальных, $0.02/doc. Использовать
      только через корп-шлюз когда он будет.
- 👁 **2026-05-17** Vision-модели — **только** для сканов без OCR-слоя.
      Text-пайплайн (OCR → Phi-4) стабильно бьёт vision по арифметике
      сумм. См. `docs/MODEL_REPORT.md` прогоны #18 (Mistral-3.1 vision)
      и #13 (MiniCPM-V провал).
- 🎨 **2026-05-19** UI v2 переехал на брутальный/технический дизайн
      (JetBrains Mono UI, deep indigo, 2px радиусы, плотная таблица,
      sidebar навигация). Источник — Anthropic design bundle
      `lXcDUJ8N97tC2i7BPHizEg`.
- 🚀 **2026-05-19** Production-стек на `10.10.13.10` (parsdocs project):
      api+worker+postgres+redis+inference+ollama. Деплой через
      `git push kb-docker main` + `docker compose -f docker-compose.doc-platform.yml
      -f docker-compose.local-models.yml -p parsdocs ...`. Обязательно
      `-p parsdocs` — иначе collision за порт + потеря volumes.

## Контакты / зависимости

- **Александр Ляпустин** (`a.liapustin@mod-soft.ru`) — Maintainer roles,
  GitLab namespace вопросы.
- **DB Support** — поддомен/TLS/nginx, доступ к узлам, корп-шлюз LLM.
- **Владелец узла `10.10.28.10`** — пулл новых LLM-моделей (не наш узел).
