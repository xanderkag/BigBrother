# Claude Code — doc-service (parsdocs) project rules

**Проект:** parsdocs — OCR + LLM-extraction + нормализация ВЭД/бухгалтерских/
таможенных документов (Node 22/Fastify + BullMQ worker · Python inference-service ·
React UI · Postgres + Redis). Прод-хост `10.10.13.10` (SSH alias `kb-docker`),
GPU-бокс `10.10.33.10`.

---

## ПРАВИЛО #1 (читать первым делом) — где что крутится: НЕ ГАДАТЬ

> Перед тем как ответить на **любой** вопрос вида «на каком бэкенде работает
> vision / extraction / classify / verify / embeddings», «через vLLM или Ollama»,
> «где tool-calling ассистента», «что за embeddings / RAG / bge», «почему медленно»,
> «сколько занимает обработка / токенов в секунду», «сколько стоит документ» —
> **сначала открой источник истины, не отвечай по памяти и не выводи из имени
> модели / env / длительности джоб.** (Частый капкан: `bge-m3` висит тегом в Ollama,
> но embeddings ВЫКЛЮЧЕНЫ — `/v1/embeddings` → 503. Наличие тега ≠ работающий сервис.)

**Источник истины (в порядке обращения):**
1. [`docs/RUNTIME_TOPOLOGY.md`](docs/RUNTIME_TOPOLOGY.md) — авторитетная топология,
   маршрутизация, ловушки, **рецепты проверки** (§3).
2. [`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md) — очередь, застревания,
   инциденты, диагностика.
3. Скилл **`/parsdocs-infra`** — прогоняет live-проверку (curl `/v1/models`,
   `provider_settings`, timed-замер) и отвечает по факту, а не по догадке.
4. Граф знаний: `graphify query "..."` — узлы `docs_runtime_topology_*`,
   `docs_operations_runbook_*` (запрос локальный, без внешних LLM).

**Проверенная топология (сверено live-probe 2026-07-21):**

| Порт на 10.10.33.10 | Бэкенд | Что делает |
|---|---|---|
| **8100** | vLLM `qwen36-vllm` | extraction · classify · verify · assistant tool-calling |
| **8101** | vLLM `qwen3-vl-32b` | vision-OCR (сканы/фото) |
| **11434** | Ollama | только gateway-chat; **НЕ** extraction/vision |

**Три ловушки, из-за которых легко ошибиться (все три уже приводили к неверным выводам):**
- **Имя модели ≠ бэкенд.** Маршрут задаёт `provider_settings.extra.upstream_base_url`
  (порт), а не строка `model`. `qwen3-vl-32b` (дефис, 8101) ≠ `qwen3-vl:32b` (двоеточие, Ollama).
- **`OPENAI_BASE_URL=…:11434` в inference-service — мёртвый fallback.** Никогда не
  срабатывает: doc-service инжектит `base_url`/`model` в тело каждого запроса. Не
  делай вывод «работает на Ollama» из этого env.
- **`jobs.(finished_at − started_at)` — НЕ латентность.** `started_at` пишется один
  раз (`src/storage/jobs.ts`), не сбрасывается при retry/reclaim → средние = «часы/сутки»
  мусор. Латентность мерить только прямым timed-`curl` на эндпоинт.

Если ответил про инфраструктуру, не сверившись с источником, — это регресс, а не экономия.

---

## Прочие правила

- **Секреты** — только в `.env` (в `.gitignore`); в репо `.env.example` без значений.
- **Корпоративные данные (реальные документы) — только локальные модели** (vLLM 8100/8101,
  inference-service). Внешние Claude/OpenAI/YandexGPT — резерв для синтетики/dev, на
  прод-данные не слать (правило ТАЙПИТ #5). Внешний OCR (Yandex) / DaData — только за PII-гардом.
- **Перед `git push`** — показать `git diff --cached` и объяснить изменения (участник
  не читает diff сам). Пуш/деплой — по явному запросу.
- **Деплой** (справочно): `git pull` на `kb-docker` → `docker compose -p parsdocs up -d --build worker api`
  (миграции применяет one-shot `migrate`). Подробности эксплуатации — в OPERATIONS_RUNBOOK.
- **Каталог типов документов управляется БД** (52 активных типа, seed-миграции),
  а не хардкодом — см. [`docs/DOCUMENT_TYPES.md`](docs/DOCUMENT_TYPES.md).
