# Заявка в DB Support — разворот parsdocs в песочнице

Готовое письмо для Павла. Скопировать целиком, отправить в корп. мессенджер / e-mail. Когда DB Support вернётся с host-port и подтверждением — допишем в `DEPLOY.md` финальные значения.

---

**Тема:** Заявка на развёртывание AI-инициативы parsdocs (`docs-parse`) в песочнице на 10.10.13.10

---

Павел, привет!

Прошу развернуть прототип AI-инициативы **parsdocs** (внутреннее имя проекта `docs-parse`) на корпоративной песочнице `10.10.13.10`.

### Проект

- **Owner:** Ляпустин А.Ю. (`klgaigpt3@gmail.com`)
- **Репозиторий (canonical):** `git@git.taipit.ru:airesearch/docs-parse.git`
- **Назначение:** универсальный OCR + структурированное извлечение реквизитов из транспортных, бухгалтерских и юридических документов — счёт / УПД / счёт-фактура / ТТН / CMR / акт / платёжка / commercial invoice / packing list / B/L / ГТД / кассовый чек / договор / спецификация / допсоглашение (15 builtin-типов), плюс возможность завести свой через админ-UI. На выходе — структурированный JSON, готовый к загрузке в 1С / ERP / CRM.
- **Статус:** боевых клиентов нет. Разворот — под пилот и интеграционное тестирование.

### Стек

- Node.js 22 (Fastify) + Python 3.11 (FastAPI)
- PostgreSQL 16 + Redis 7 — внутри `docker compose`, не наружу
- Опционально: Ollama / vLLM для локальной LLM (под GPU)
- Запуск через `docker compose` (мастер-compose в корне: `docker-compose.doc-platform.yml`), rootless-совместимо
- **WebSocket / SSE / Upgrade-headers: НЕ нужны.** Чистый REST + polling в UI

### Сетевая обвязка (что нужно от DB Support)

| Параметр | Значение |
|---|---|
| Желаемый поддомен | `parsdocs.taipit.ru` (или другой свободный) |
| TLS | через корп. nginx, HTTPS-only |
| Внешний порт | **один** — `doc-service:3000` (UI + API). Host-port — свободный из вашего пула |
| Внутренние сервисы | `inference:8000`, `postgres:5432`, `redis:6379` — наружу не публикуем |

### Корп. БД

Не используется. У сервиса своя Postgres в `docker compose`. `pg_hba.conf` корпоративных Postgres'ов не релевантен.

### Ресурсы (пилот)

- 32 GB RAM
- 100 GB disk
- GPU желателен ≥16 GB VRAM (под Qwen2.5-VL 7B через Ollama). Если GPU нет — поднимем без него, на CPU будет медленнее, но рабоче

### Что уже готово в репо

- `Dockerfile` + `docker-compose.yml` в каждом сервисе, мастер-compose в корне
- `.env.example` без значений в каждом сервисе
- `README.md` + `DEPLOY.md` (раздел 11 — TAIPIT-specific) + `OWNERS.md`
- Health-чек endpoints: `/health` (liveness) и `/ready` (проверяет Postgres + Redis + storage volume)
- Smoke-команды и golden-set harness (`npm run eval`) — для проверки качества после развёртывания

### Что прошу

1. Свободный host-port из вашего пула под `doc-service:3000`
2. Запись в реверс-прокси: `parsdocs.taipit.ru` → `10.10.13.10:<host-port>`
3. TLS-сертификат на поддомен
4. Рабочую папку на хосте + права на `git clone` (Deploy Token из GitLab приложу отдельно)
5. После старта compose — пинг, проверим smoke: `curl https://parsdocs.taipit.ru/ready` должен вернуть 200

### Безопасность данных

- **Cloud LLM (Claude / OpenAI) — только в резерве** для синтетики и dev. Для прод-данных используется локальный inference (Ollama / vLLM). Соответствует правилу #5 SKILL.md (корп. данные не уходят в публичные облака LLM).
- **Yandex Vision выключен** (`YANDEX_VISION_API_KEY=` пустой). Включим, когда реализуем per-job PII opt-out — иначе ТТН с паспортными данными водителя ушли бы в Yandex Cloud (152-ФЗ).
- **Секреты** (`API_KEY`, `SECRETS_ENCRYPTION_KEY`, `WEBHOOK_HMAC_SECRET`) подготовлю и передам отдельно защищённым каналом. В git их нет, в репо только `.env.example`.

### Текущее состояние main-ветки

На канонической main сейчас стартовый scaffold. Вся история Phase 3 (multi-tenant, secrets-at-rest, расширение каталога до 15 типов, observability, dashboard, eval-harness и т.д.) лежит в ветке `feat/bring-phase-3-history`, ждёт merge. Открытый MR:

`https://git.taipit.ru/airesearch/docs-parse/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fbring-phase-3-history`

После merge'а в main можно начинать deploy.

---

Спасибо!
А. Ляпустин
