# Claude Code — project instructions

**Project:** Big Brother / Doc Parser (parsdocs)
**Obsidian card:** `U:\Users\lyapustin.a\Desktop\Projects AI\10 Projects\parsdocs\parsdocs.md`
**Vault root:** `U:\Users\lyapustin.a\Desktop\Projects AI\`
**Vault standard:** `U:\Users\lyapustin.a\Desktop\Projects AI\STANDARD.md`

## 🔔 ОБЯЗАТЕЛЬНО в начале каждой сессии о parsedocs

**Единая доска задач (в git):** `ROADMAP.md` — что делаем сейчас/дальше/перспектива.
Это THE источник по задачам; `TECH_DEBT.md` — детальная история закрытого.

**Открой и прочитай очередь интеграции (в git):**
`doc-service/docs/INTEGRATION_QUEUE.md`

Это очередь нерешённых вопросов между нами / пользователем / разработчиком
SLAI. Файл живёт в git → синхронизация между машинами автоматическая
через `git pull`. SLAI зеркалит копию в `xanderkag/SLAI/docs/PARSDOCS_QUEUE.md`.

Правила работы с очередью описаны в шапке файла:

- Если есть вопрос со статусом `ANSWERED` — **выполни action plan**,
  закоммить + push, переведи в `RESOLVED` с ссылкой на commit.
- Если есть `OPEN` (To: USER) — упомяни в первом ответе пользователю что
  этот вопрос ждёт ответа.
- Если есть `OPEN` (To: SLAI_DEV) и прошло > 7 дней — предложи пользователю
  напомнить разработчику.
- Если есть `OPEN` (To: CLAUDE) и сейчас есть время — выполнить как
  фоновую задачу когда основная работа закончена.

После каждой сессии в которой что-то обработано — записать в секцию
«История изменений этого файла» одну строку с датой и кратким описанием.

**Связанные документы интеграции (в git):**
- `doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md` — наш ответ SLAI по continuous sync
- Файлы на рабочем столе (history-only, не использовать как source of truth):
  `Desktop\parsdocs-validation-bench\SLAI_*.md`

## Auto-update the Obsidian card

Когда работаешь в этом репозитории, дописывай в карточку соответствующие секции:

- **Новое решение** (архитектура / вендор / LLM-канал / pipeline) → `## Решения` строкой `- YYYY-MM-DD: <решение> + <почему>`.
- **Новая задача / TODO** → `## Задачи > ### Открытые` чекбоксом. Внешние — `#q/external @Имя 📅 YYYY-MM-DD`. Внутренние без `#q/*`.
- **Задача закрыта** → перенеси из `### Открытые` в `### Сделано` как `- [x] ✅ YYYY-MM-DD <текст>`.
- **Сменился ближайший план** → обнови поле `next_step:` во frontmatter (одна строка — что делать прямо сейчас).
- **Веха / смена статуса** (prototype → prod-ready, успешный деплой) → строка в `## Лог` и обнови `status:` во frontmatter.
- **Запрос наружу** (Павел, Mod-soft) → строка в `## Лог` + reciprocal `#q/external` в `### Открытые`.

Не переписывай `## Цель` и `## Команда` без явного подтверждения.

## Project context

- Источник правды по коду — **GitHub** (`xanderkag/BigBrother`). Не делать
  предположений об ОДНОМ конкретном прод-инстансе: у parsdocs может быть
  несколько deploy-таргетов одновременно (staging/demo + corp prod), они
  независимы. Топология деплоев — `DEPLOY_TOPOLOGY.md`.
- Стек: Node.js 22 (Fastify) + Python 3.11 (FastAPI) + Postgres 16 +
  Redis 7 + Qwen-VL (Ollama/vLLM) / OpenAI-compatible / Anthropic / stub
  по `provider_settings` + BullMQ.
- Phase 1 (счёт/УПД) — regex + LLM-fallback. Phase 2 (ТТН/CMR/акт/ВЭД) —
  только LLM (`parser_kind='llm_extract'`).
- SLAI — основной consumer-микросервис (см. `SLAI_INTEGRATION_BACKLOG.md`).
- Документы рядом: `DEPLOY.md`, `OWNERS.md`, `HANDOFF.md`, `TECH_DEBT.md`.
