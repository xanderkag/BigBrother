# Ответственные и регламентные сведения

Документ обновляется при смене ответственного, изменении контактов или регламентных параметров проекта.

## Проект

- **Внутреннее имя:** `parsdocs`
- **Slug в GitLab:** `airesearch/docs-parse`
- **Описание:** платформа обработки транспортных, бухгалтерских и юридических документов (15+ типов) с OCR-цепочкой и LLM-извлечением. См. [README.md](README.md).
- **Статус:** AI-инициатива ТАЙПИТ. На стадии подготовки к развороту в корп. песочнице на `10.10.13.10`. Боевых клиентов нет.

## Ответственные

| Роль | ФИО | Контакт |
|---|---|---|
| **Owner** | Ляпустин А.Ю. | `klgaigpt3@gmail.com` |

> Заместитель появится отдельно при подаче на приёмку по Памятке v0.2+. На стадии пилота / интеграционного тестирования — все вопросы через owner'а.

## Репозитории

| Назначение | URL | Канонический? |
|---|---|---|
| **TAIPIT GitLab** | `git@git.taipit.ru:airesearch/docs-parse.git` | ✅ да |
| GitHub mirror | `git@github.com:xanderkag/BigBrother.git` | нет, параллельный backup |

Все правки идут в обе ветки одновременно. Канонический источник для развёртывания и приёмки — **TAIPIT GitLab**.

## Регламентный набор секретов

В `.env` (никогда не в git):

| Переменная | Назначение | Как генерировать |
|---|---|---|
| `API_KEY` | Bearer-токен админ-доступа (legacy fallback) | `openssl rand -hex 32` |
| `SECRETS_ENCRYPTION_KEY` | AES-256-GCM master-ключ для `provider_settings.api_key` в БД | `openssl rand -hex 32` |
| `WEBHOOK_HMAC_SECRET` | подпись webhook-доставок | `openssl rand -hex 32` |
| `DATABASE_URL` | подключение к Postgres (внутри compose) | в `.env.example` дефолт ок |
| `REDIS_URL` | подключение к Redis (внутри compose) | в `.env.example` дефолт ок |
| `LLM_INFERENCE_URL` | путь к нашему inference-service внутри docker-сети | `http://inference:8000` |
| `ANTHROPIC_API_KEY` (опц., резерв) | Claude — **только для синтетики/dev**, не для прод-данных | — |
| `OPENAI_API_KEY` (опц., резерв) | OpenAI Cloud — то же ограничение | — |

Personal access tokens (`pdpat_…`) выпускаются через UI после развёртывания, в `.env` не хранятся.

## Ресурсы и инфраструктура

| Параметр | Значение |
|---|---|
| **Стек** | Node.js 22 (Fastify) + Python 3.11 (FastAPI) + PostgreSQL 16 + Redis 7 + опц. Ollama / vLLM |
| **Контейнеризация** | Docker + docker compose, rootless-совместимо |
| **WebSocket / SSE / Upgrade-headers** | НЕ требуются (REST + polling в UI) |
| **Внешний порт** | один — `doc-service:3000` (UI + API) |
| **Внутренние сервисы** | `inference:8000`, `postgres:5432`, `redis:6379` — наружу не светим |
| **Volumes** | `doc-data` (uploaded files), `pgdata`, `redisdata` — переживают `compose down` |
| **Ресурсы пилота** | 32 GB RAM, 100 GB disk, GPU желателен ≥16 GB VRAM (для Qwen2.5-VL 7B) |
| **Ресурсы прода** | 64 GB RAM, 500 GB SSD, GPU ≥24 GB VRAM (Qwen2.5-VL 7B + vLLM continuous batching) |
| **Корп. БД 1С / Bitrix24** | не используется. Интеграция только через штатные API. |
| **`pg_hba.conf`** | не релевантен (свой Postgres в compose) |

## Запрос на развёртывание в DB Support (шаблон)

```
Тема: Заявка на развёртывание AI-инициативы parsdocs (docs-parse) в песочнице

Команда!

Прошу развернуть прототип AI-инициативы parsdocs на 10.10.13.10.

Имя проекта: docs-parse (внутренний name: parsdocs)
Owner: Ляпустин А.Ю. (klgaigpt3@gmail.com)

Репозиторий (canonical):
  git@git.taipit.ru:airesearch/docs-parse.git
Параллельный mirror:
  git@github.com:xanderkag/BigBrother.git

Стек:
  Node.js 22 + Python 3.11 + PostgreSQL 16 + Redis 7
  Опционально — Ollama / vLLM для локальной LLM.
  Запуск через docker compose (master compose в корне: docker-compose.doc-platform.yml).

WebSocket / SSE / Upgrade-headers: НЕ нужны (чистый REST + polling в UI).

Сетевая обвязка:
  - Желаемый поддомен: parsdocs.taipit.ru (или иной свободный)
  - TLS через корп. nginx, HTTPS-only
  - Внешний порт: один — внутри контейнера 3000
    (свободный host-port готов получить из вашего пула)
  - inference:8000, postgres, redis — только внутри docker-сети, наружу не публикуются

Ресурсы (пилот):
  32 GB RAM, 100 GB disk
  GPU желателен ≥16 GB VRAM (под Qwen2.5-VL 7B через Ollama)

Корп. БД (1С / Bitrix24 / etc): не используется. У сервиса своя Postgres в compose.
pg_hba.conf не релевантен.

Cloud-LLM (Claude / OpenAI): только в резерве для синтетики и dev.
Для прод-данных — локальный inference-сервер (правило #5 SKILL.md).

Что готово:
  - актуальная main в git.taipit.ru/airesearch/docs-parse запушена
  - Dockerfile + docker-compose в каждом сервисе, мастер-compose в корне
  - .env.example без значений в каждом сервисе
  - README.md + DEPLOY.md (раздел 11 — TAIPIT-specific)
  - OWNERS.md (этот файл)
  - secret-keys (.env реальные) подготовлены и переданы DB Support
    в защищённом канале отдельным сообщением

Чего прошу:
  1. Создать запись в реверс-прокси: parsdocs.taipit.ru → 10.10.13.10:<host-port>
  2. Выдать TLS-сертификат
  3. Открыть hosted порт <host-port> в firewall'е сервера
  4. Создать рабочую папку на хосте, склонировать репо (Deploy Token приложу)
  5. После старта compose — прислать ссылку, проверим smoke (https://parsdocs.taipit.ru/ready)

Спасибо!
А. Ляпустин
```

## История изменений

| Дата | Что | Кто |
|---|---|---|
| 2026-05-12 | Создан, owner Ляпустин А.Ю. | A.Л. |
