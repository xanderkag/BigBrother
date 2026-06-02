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
  предположений об ОДНОМ конкретном прод-инстансе: у parsdocs **3 разных
  инфра-окружения** одновременно (см. `DEPLOY_TOPOLOGY.md`).
- Стек: Node.js 22 (Fastify) + Python 3.11 (FastAPI) + Postgres 16 +
  Redis 7 + Qwen-VL (Ollama/vLLM) / OpenAI-compatible / Anthropic / stub
  по `provider_settings` + BullMQ.
- Phase 1 (счёт/УПД) — regex + LLM-fallback. Phase 2 (ТТН/CMR/акт/ВЭД) —
  только LLM (`parser_kind='llm_extract'`).
- SLAI — основной consumer-микросервис (см. `SLAI_INTEGRATION_BACKLOG.md`).
- Документы рядом: `DEPLOY.md`, `OWNERS.md`, `HANDOFF.md`, `TECH_DEBT.md`.

## 🔒 ПРАВИЛО — три инфра-окружения, **НЕ путать**

parsdocs — **один код**, **три разных окружения** одновременно:

| ID | Хост | Назначение | Hardware | Environment |
|----|------|-----------|----------|-------------|
| **asha** | `135.106.158.143` (Selectel, личный) | staging + SLAI пилот | CPU only, 15 GB RAM, 79 GB disk | BACKEND=stub, BYO LLM путь, ASR на CPU |
| **kb-docker** | `10.10.13.10:8085` (корп) | corp prod parsdocs | corp infra, разные правила доступа | local openai_compat, 152-ФЗ ограничения, Yandex Vision |
| **gpu-33-10** | `10.10.33.10` (корп) | GPU inference 96 ГБ VRAM | Mistral Small 3.1 24B, Qwen-VL 32B, vLLM | inference-only, не deploy parsdocs |

**Что НЕ разводим (общее):**
- Кодовая база (один репо, один main, один docker image)
- Контракт API (vanga.sls24.ru и kb-docker отвечают одинаково по /api/v1)
- Схема БД, миграции, бизнес-логика
- ТЗ и документация

**Что РАЗВОДИМ (специфично per-host):**
- `.env` файлы (свои секреты, свои ENV-флаги, свои `BACKEND`, своя БД)
- `SECRETS_ENCRYPTION_KEY`, `API_KEY`, ANTHROPIC ключи — у каждого СВОИ
- Сетевая топология (vanga.sls24.ru ≠ parsedocs.taipit.ru ≠ 10.10.33.10)
- Deploy mechanism (GitHub Actions для asha, отдельный canonical git для
  kb-docker, ручной для GPU-сервера)
- Доступ агенту (SSH к asha — да по разрешению; к kb-docker — нет)
- Что можно/нельзя пускать на хост:
  - asha: НЕ корп-данные (правило хоста). Только синтетика + BYO для SLAI пилота
  - kb-docker: только корп-данные локальным LLM. БЕЗ личных Anthropic-ключей
  - gpu-33-10: только inference, БЕЗ хранения данных (использует он, не хранит)

**Правила при работе:**

1. Перед любым SSH / deploy / .env правкой — **уточнить какое окружение**.
   Не предполагать «на сервере есть X» — проверить на КАКОМ сервере.
2. Найденная фича / баг / cleanup на одном хосте — **не автоматически** на
   другом. Размышлять отдельно для каждого.
3. Cleanup типа `DELETE FROM provider_settings WHERE id LIKE 'local-%'`
   на asha — **не повторять на kb-docker без отдельного решения**.
4. Когда в чате/доке упоминается «прод», «staging», «inference-сервер» —
   уточнять КАКОЙ из трёх. По возможности писать host name явно.
5. GPU-сервер `10.10.33.10` — **не deploy parsdocs'а**, а отдельный
   inference-only хост. Парсдоксу нужно только указать `OPENAI_BASE_URL`
   на него если хочется использовать его модели. Это не deploy, это
   подключение upstream.
