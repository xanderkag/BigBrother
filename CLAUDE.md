# Claude Code — project instructions

**Project:** Big Brother / Doc Parser (parsdocs)
**Obsidian card:** `U:\Users\lyapustin.a\Desktop\Projects AI\10 Projects\parsdocs\parsdocs.md`
**Vault root:** `U:\Users\lyapustin.a\Desktop\Projects AI\`
**Vault standard:** `U:\Users\lyapustin.a\Desktop\Projects AI\STANDARD.md`

## 🔔 ОБЯЗАТЕЛЬНО в начале каждой сессии о parsedocs

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
- **Веха / смена статуса** (prototype → prod-ready, успешный деплой) → строка в `## Лог` и обнови `status:` во frontmatter.
- **Запрос наружу** (Павел, Mod-soft) → строка в `## Лог` + reciprocal `#q/external` в `### Открытые`.

Не переписывай `## Цель` и `## Команда` без явного подтверждения.

## Project-specific context

- Прод-target: `parsedocs.taipit.ru` → `10.10.13.10:8085`.
- Внешние: Павел Шевелёв (порт 8085, `client_max_body_size 50m`) + Mod-soft (AI-инициатива).
- Главный блокер: LLM-канал — корп-шлюз или личный ключ. Решение в `HANDOFF.md` вариант a.
- Yandex Vision отключена из-за риска 152-ФЗ.
- Стек: Node.js 22 (Fastify) + Python 3.11 (FastAPI) + Postgres 16 + Redis 7 + Qwen-VL (Ollama/vLLM) + BullMQ.
- Phase 1 (счёт/УПД) — классика + LLM. Phase 2 (ТТН/CMR/акт) — только LLM.
- Документы рядом: `DEPLOY.md`, `DEPLOY-REQUEST.md`, `OWNERS.md`, `HANDOFF.md`, `TECH_DEBT.md`.
