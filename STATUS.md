---
project: parsedocs (BigBrother / doc-service)
status: production
updated: 2026-06-01
next_step: Сеть 13.10(прод)→33.10:11434 ПРОВЕРЕНА И ОТКРЫТА — probe через сам parsdocs (POST /provider-settings/:id/test → ok 200, 21 мс). Заявка в DB Support НЕ нужна. Остался один шаг до «гонять победителя через прод-UI»: переключить inference-service OPENAI_BASE_URL→http://10.10.33.10:11434/v1 + OPENAI_MODEL=mistral-small3.1 и перезапустить контейнер (нужен SSH на прод = Александр; provider_settings.base_url=http://inference:8000 — это сам inference-контейнер, поэтому одной UI-строкой к 33.10 не переключить, doc-service ходит в кастомные /v1/extract). ⚠️ Безопасность: прод (10.10.13.10:8085) поднят с ALLOW_NO_AUTH=true + пустым API_KEY → любой в корп-сети = super_admin (provider-settings CRUD открыт). Рекомендация в прод: mistral-small3.1. Результаты — docs/MODEL_REPORT.md #29-34
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
- [x] ✅ **Bench v3 на 96 ГБ-сервере** — свип завершён (6 моделей, #29-34).
      Поля / `total`-арифметика на 9-doc golden: Phi-4 14B 88.3%/71.4%,
      Llama 3.3 70B **98.3%/100%**, Qwen2.5 72B **98.3%/100%**, DeepSeek-R1 70B
      96.7%/85.7%, Gemma 3 27B 96.7%/85.7%, **Mistral Small 3.1 24B 98.3%/100%
      🏆 — догоняет 70B при ~14 ГБ и 3-5 с/файл**. Цель ≥85% взяли 5 из 6.
      Рекомендация в прод — mistral-small3.1 (точность 70B, цена 24B).
      Результаты — `MODEL_REPORT.md` #29-34, план — `docs/BENCH_V3_PLAN.md`.
- [ ] **Прогон победителя через полный пайплайн** на корп-проде (UI):
      сеть 13.10→33.10 уже открыта (проверено). Остаётся: переключить
      inference-service на 33.10 (env, см. «Ждёт внешних факторов» → нужен
      Александр), затем загрузить golden-доки → результаты в прод-UI.
      Опц.: A/B Q4 vs Q8 + второй проход на OCR-тексте (`--text-dir`) —
      проверить устойчивость к OCR-шуму.

### Tier 2 — 1–2 недели

- [ ] Lazy-load `pdf-vendor` chunks только на JobDetail (React.lazy +
      Suspense). Initial load UI в 2× быстрее.
- [ ] Дотянуть `/healthz` до UI: backend-эндпоинт `health.ts` уже есть
      (приехал со SLAI/Asha-веткой), осталось подвязать TopBar-индикатор —
      сейчас плашка `SystemStatusBadge` статична.
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

- [x] ✅ **Сеть 13.10 (прод) → 33.10:11434 ОТКРЫТА** (проверено 2026-06-01
      через сам parsdocs: создал временный provider_settings row base_url=
      http://10.10.33.10:11434, POST /:id/test → `ok:true, status:200,
      latency_ms:21`, row удалён). Заявка в DB Support НЕ нужна. doc-service и
      inference-service на одном хосте 13.10 → раз doc-service дотянулся, дотянется
      и inference. Прод сейчас: backend=openai_compat, OPENAI_MODEL=qwen2.5vl:32b.
- [ ] 🔧 **Переключить прод-inference на 33.10** (нужен SSH на прод = Александр):
      в inference-service .env выставить `OPENAI_BASE_URL=http://10.10.33.10:11434/v1`,
      `OPENAI_MODEL=mistral-small3.1`, перезапустить контейнер inference.
      ВАЖНО: provider_settings.base_url у всех local-* = `http://inference:8000`
      (сам inference-контейнер); doc-service ходит в кастомные `/v1/classify`,
      `/v1/extract`, которых у raw-ollama нет → одной UI-строкой к 33.10 НЕ
      переключить, маршрут к GPU задаётся только env'ом inference-service.
- [ ] 🔴 **Безопасность прода:** 10.10.13.10:8085 поднят с `ALLOW_NO_AUTH=true`
      и пустым `API_KEY` → каждый запрос = system super_admin. С корп-сети
      (проверено с 13.9) открыт весь provider-settings CRUD без токена. Перед
      боевой эксплуатацией — задать `API_KEY`/personal-токены и снять
      ALLOW_NO_AUTH. Эскалация — Александр / DB Support.
- [ ] Корп-шлюз `llm.taipit.ru` (DB Support) → без него Claude Sonnet 4.6
      нельзя на реальных данных
- [ ] Доступ к узлу `.28.10` для пулла новых моделей (не наш `.13.10`)
- [ ] Регламент приёмки L1→L2 (Памятка автору, v0.2+)

## Сделано

- [x] ✅ 2026-06-01 Актуализирован `doc-service/docs/SLAI_INTEGRATION_BACKLOG.md`
      (был от 26.05): TL;DR + Слой 1-3 приведены к текущей реальности — Asha pilot
      live (31.05) + sandbox provisioned, ответы SLAI по Q4/Q5/Q9/AC9 (FOLLOWUP 29.05),
      состояние S1 (webhook-secret PENDING) / S2 (ждём age-pubkey SLAI), победитель
      text-path Mistral Small 3.1 (bench v3 #29-35) и latency в SLA, пилот WW-23 (02.06).
      Sequencing переписан: блокеры пилота = пнуть SLAI по S1 + age-ключу.
- [x] ✅ 2026-06-01 Реальные коммерческие доки поставщика (ANJI MINGPAI / контракт
      EWL-AMF180723) прогнаны через ПРОД-пайплайн parsdocs (POST /api/v1/jobs на
      13.10:8085) «вслепую» — байты ушли в локальный сервис, содержимое агент НЕ читал
      (корп-конфиденциальность). 5 PDF, классификация верна на НОВЫХ типах вне ядра:
      `weighing_act` (conf .975, pdf-text), `eac_conformity_certificate` (.553 →
      needs_review, скан/tesseract), `bill_of_lading` (.885), `wire_transfer_application`
      (.975, пл. поручение), `contract` (.715 → needs_review, 7.8 МБ скан/tesseract).
      Все 5 PDF классифицированы верно. Формат-гэп: xls/xlsx/
      docx/zip парсдок ПРИНИМАЕТ на upload (202), но валятся/висят в пайплайне (magic-bytes
      и парс — downstream, не на гейте) → pre-processing не готов (Tier-3). Прогон на
      ТЕКУЩЕМ прод-дефолте (qwen2.5vl:32b), НЕ на победителе mistral-small3.1 — для
      победителя нужен env-свич inference (Александр). Гоча для рига: native curl.exe не
      читает git-bash `/tmp`, а `,`/`%` в имени ломают `-F` → клали ASCII-копию рядом.
- [x] ✅ 2026-06-01 Кросс-валидация победителя (mistral-small3.1) на НЕЗАВИСИМОМ
      10-док корпусе `corpus-gt` (AKT/TTN/UPD/invoice/payment_order ×2) через
      туннель → новый риг `run-corpus-gt.py` + штатный `compare.py`. Тип/номер/
      дата 10/10, ИНН 8/8 (где GT есть), items точно на всех 8 док с позициями,
      total 5/6 (единств. реальный промах — итоги UPD-01 при верных 20 позициях).
      Оверфита под 9 фикстур НЕТ. Заметка: llama3.3:70b на том же боксе сейчас
      285 с/док (VRAM-контеншн) → проду нужен keep-alive/роутер. См. MODEL_REPORT #35.
- [x] ✅ 2026-06-01 Проверена досягаемость GPU-бокса через сам parsdocs
      (запрос пользователя «проверяй через парсдокс»). Прод-API на 13.10:8085
      отвечает с 13.9 и открыт без токена (ALLOW_NO_AUTH). Создал временный
      provider row base_url=http://10.10.33.10:11434 → POST /:id/test →
      `ok:true status:200 latency_ms:21` (ollama /v1/models), row удалён.
      Вывод: **13.10→33.10:11434 ОТКРЫТА**, firewall-заявка не нужна. Заодно
      зафиксирован security-флаг (прод без auth) — см. Открытые.
- [x] ✅ 2026-06-01 Bench v3 свип завершён (прогоны #29-34, 9-doc golden,
      текст-слой): Phi-4 14B 88.3%/71.4% (baseline), Llama 3.3 70B 98.3%/100%,
      Qwen2.5 72B 98.3%/100%, DeepSeek-R1 70B 96.7%/85.7%, Gemma 3 27B
      96.7%/85.7%, **Mistral Small 3.1 24B 98.3%/100% 🏆 — точность 70B при
      ~14 ГБ VRAM и 3-5 с/файл**. Цель ≥85% взяли 5 из 6. Гипотеза «размер
      решает» подтвердилась, но 24B-класс уже догоняет. Доступ к боксу
      10.10.33.10 — SSH-туннель с 13.9. Результаты — `docs/MODEL_REPORT.md`.
- [x] ✅ 2026-06-01 Bench v3 tooling: `scripts/text-bench-real.py` —
      текстовый риг (зеркало vision-рига) под большие модели на 96 ГБ:
      текстовый слой PDF/DOCX → ollama/openai → скоринг compare.ts против golden,
      все 9 фикстур. Plan-doc `docs/BENCH_V3_PLAN.md` (кандидаты, VRAM-бюджет,
      runbook, критерии победителя).
- [x] ✅ 2026-05-31 (ветка SLAI/Asha, +9 коммитов в github) — SLAI-интеграция
      (EXT-LINE 10 полей, 4 канала Q4/Q5/Q9/AC9, openapi-расширения),
      Asha pilot deploy + sandbox-провижининг, `/healthz` (`health.ts`),
      секреты через `age`. ⚠️ Эти коммиты пока ТОЛЬКО в github;
      `origin` и `kb-docker` на 9 коммитов позади — нужен sync-push.
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

- 🌐 **2026-06-01** Сеть прод→GPU подтверждена: **10.10.13.10 → 10.10.33.10:11434
      открыта** (ollama ответил 200 за 21 мс на /v1/models через probe из самого
      parsdocs). Снят блокер «закрытый порт» — DB Support-заявка отменяется.
      Остаётся только перенаправить inference-service на 33.10 (env, нужен
      prod-SSH = Александр). Побочно вскрыт security-флаг: прод поднят без auth
      (ALLOW_NO_AUTH=true, пустой API_KEY) — super_admin для всей корп-сети.
- 🖥️ **2026-06-01** Появился сервер **96 ГБ VRAM** (наш, пуллим модели сами).
      Снимает потолок 20 ГБ, на котором Phi-4 14B стала дефолтом «потому что
      влезала». Открывает 70–72B-класс (Llama 3.3 70B, Qwen2.5 72B), Q8/fp16
      вместо Q4, co-residence моделей (router), vLLM-batching. Запущен
      bench v3 — переоценка модельного дефолта. См. `docs/BENCH_V3_PLAN.md`.
- 🏆 **2026-06-01** Bench v3 — цель ≥85% взяли 5 из 6 моделей. На вершине
      три по 98.3%/100%: Llama 3.3 70B, Qwen2.5 72B и **Mistral Small 3.1 24B**.
      Главный вывод: **Mistral 3.1 24B догоняет 70B по точности при ~14 ГБ VRAM
      и 3-5 с/файл (в 5× быстрее)** → рекомендация в прод, лучший баланс
      точность/скорость/цена. Gemma 3 27B тоже берёт цель (96.7%/85.7%, быстрая)
      — кандидат для роутера. Против 88.3%/71.4% у Phi-4. См. `MODEL_REPORT.md`
      #29-34.
- 🥇 **2026-05-17** Phi-4 14B выбран локальным production-дефолтом
      (bench v2 прогон #17): лучшая арифметика `total` 60%, 34 сек/файл,
      влезает в 20 GB VRAM узла `.28.10`. См. `docs/MODEL_REPORT.md`.
      ⚠️ Контекст: дефолт «по VRAM», bench v3 ищет замену без потолка 20 ГБ.
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
