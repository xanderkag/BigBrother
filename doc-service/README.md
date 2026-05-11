# doc-service

Универсальный сервис обработки документов: OCR + извлечение структурированных данных из транспортных и бухгалтерских документов (счета, УПД, ТТН, CMR, акты).

Самостоятельный микросервис: подключается по HTTP к любой системе, не зависит от конкретной инфраструктуры.

## Стек

- **Runtime:** Node.js 22 + Fastify
- **Очередь:** BullMQ + Redis
- **БД:** PostgreSQL (хранение jobs)
- **OCR pipeline (по приоритету):**
  1. `pdf-parse` — текстовые PDF (мгновенно)
  2. системный `tesseract` (русский+английский) — сканы и изображения
  3. внешний LLM inference-service (Qwen-VL и т.п.) — сложные сканы и проверка
  4. Yandex Cloud Vision — последний резерв
- **Хранилище файлов:** локальная ФС (`STORAGE_DIR`), интерфейс `FileStorage` готов под S3/MinIO

## Быстрый старт

### Только doc-service (без LLM)

```bash
cp .env.example .env
docker compose up --build
```

API на `http://localhost:3000`, документация на `http://localhost:3000/docs`. Миграция БД выполняется автоматически при первом запуске Postgres-контейнера.

В этом режиме `vision-llm` ступень OCR-пайплайна выпадает (нет inference-service), а Phase 2 парсеры (ТТН/CMR/АКТ) деградируют до `needs_review`. Phase 1 (счёт/УПД) работает полноценно на regex.

### Весь стек (doc-service + inference-service)

Из корня workspace `ai-platform/`:

```bash
docker network create ai-platform
docker compose -f docker-compose.doc-platform.yml up -d --build
```

После этого:
- doc-service → `http://localhost:3000` (API), `http://localhost:3000/docs` (Swagger UI)
- inference-service → `http://localhost:8000` (API), `http://localhost:8000/docs` (FastAPI auto-docs)

В `doc-service/.env` поставить `LLM_INFERENCE_URL=http://inference:8000` — после этого Phase 2 парсеры начинают реально извлекать поля, а сложные сканы попадают в LLM-OCR (vision-llm ступень).

## Аутентификация

Все ручки `/api/v1/*` защищены Bearer-токеном, если в `.env` задан `API_KEY`. `/health` и `/ready` всегда публичные — нужны для load balancer / orchestrator пробников.

```bash
# .env
API_KEY=$(openssl rand -hex 32)
```

Запросы:

```http
POST /api/v1/jobs HTTP/1.1
Authorization: Bearer <ключ из API_KEY>
Content-Type: multipart/form-data
```

Если `API_KEY` пустой (по умолчанию в `.env.example`) — auth отключён, любой запрос проходит. Это удобно для локальной разработки, но на проде ключ обязателен.

Сравнение токенов — constant-time, чтобы не утекать валидный префикс через тайминги. На неверный/отсутствующий токен возвращается `401` с JSON-телом, без `WWW-Authenticate` (это server-to-server API, не браузерный).

Один ключ — один deployment. Когда понадобится разные клиенты с разными правами, расширим до многоключевой схемы (`API_KEYS_JSON='{"<key>":"<client_name>"}'`) или DB-backed токенов.

## Документация API

Полное описание ручек, схем тел и ошибок — в Swagger UI: `http://localhost:3000/docs`.

OpenAPI 3.1 spec в JSON: `http://localhost:3000/docs/json` — пригоден для автогенерации клиентов (например, через `openapi-typescript-codegen`, `oapi-codegen` для Go, или `openapi-python-client`).

Auth-токен из `API_KEY` указывается в Swagger UI через кнопку **Authorize** в правом верхнем углу — после этого все запросы из UI идут с заголовком `Authorization: Bearer ...`.

## API

### Отправка документа

```http
POST /api/v1/jobs
Content-Type: multipart/form-data

file            (binary)        PDF, JPG, PNG, BMP, TIFF
webhook_url     (string, opt)   куда POST результат после обработки
document_hint   (string, opt)   invoice | TTN | CMR | UPD | AKT
metadata        (string, opt)   произвольный JSON, возвращается как есть
```

Ответ: `{ "job_id": "...", "status": "pending" }`.

### Статус и результат

```http
GET /api/v1/jobs/:id
```

Ответ:

```json
{
  "job_id": "...",
  "status": "done",
  "document_type": "invoice",
  "confidence": 0.92,
  "ocr_engine": "tesseract",
  "raw_text": "...",
  "extracted": { ... },
  "metadata": { ... },
  "error": null
}
```

`status`: `pending` → `processing` → `done` | `failed` | `needs_review`.

### Корректировка извлечённых данных

```http
PATCH /api/v1/jobs/:id/extracted
Content-Type: application/json

{ "поля": "для перезаписи" }
```

Полностью перезаписывает поле `extracted` и переводит статус в `done`. Время правки фиксируется в `extracted_corrected_at` (для последующего дообучения парсеров).

### Список

```http
GET /api/v1/jobs?status=&document_type=&from=&to=&limit=50&offset=0
```

## OCR pipeline

```
                ┌───────────────┐
PDF ──────────► │   pdf-parse   │ confidence ≥ 0.90 → done
                └──────┬────────┘
                       ↓ иначе
                ┌───────────────┐
скан/картинка ► │   tesseract   │ confidence ≥ 0.75 → done
                └──────┬────────┘
                       ↓ иначе (если LLM_INFERENCE_URL задан)
                ┌────────────────────┐
                │  vision-llm (Qwen) │ confidence ≥ 0.75 → done
                └──────┬─────────────┘
                       ↓ иначе (если YANDEX_VISION_API_KEY задан)
                ┌───────────────────┐
                │  yandex.vision    │ всегда принимаем результат
                └───────────────────┘

После OCR: классификация (по ключевым словам или LLM /classify)
       ↓
       парсер по типу документа → extracted
       ↓
       confidence < 0.60 → status = needs_review
       иначе                → status = done
```

Каждый движок реализует интерфейс `OcrEngine` (`src/pipeline/ocr/types.ts`). Порядок и пороги настраиваются через env. Движки без credentials (LLM, Yandex) автоматически исключаются из цепочки.

## LLM inference-service

doc-service ходит за LLM по HTTP с доменными ручками — не сырой chat-API, чтобы можно было сменить модель без правок здесь:

```
POST /v1/classify     { text }                 → { type, confidence }
POST /v1/extract      { text, schema, hint? }  → { extracted, confidence, issues[] }
POST /v1/vision-ocr   { image, prompt? }       → { text, confidence }
POST /v1/verify       { extracted, raw_text }  → { extracted, issues[] }
```

Сам inference-service — отдельный проект (Python + FastAPI + Qwen-VL), здесь только тонкий клиент. Если `LLM_INFERENCE_URL` пуст — используется `NullLlmClient` (всё no-op), пайплайн работает без LLM.

## Безопасность webhook

Тело каждой webhook-доставки подписывается HMAC-SHA256 с `WEBHOOK_HMAC_SECRET`. Получатель проверяет:

```
X-DocService-Signature: sha256=<hex>
X-DocService-Job-Id:    <uuid>
X-DocService-Attempt:   <n>
```

Доставка ретраится с экспоненциальной задержкой до `WEBHOOK_MAX_ATTEMPTS` раз.

## Локальный smoke-прогон без Docker

Полный пайплайн (OCR → классификация → парсинг) на одном файле, без БД, без очереди, без сервера. Удобно для проверки качества OCR на конкретном документе или отладки парсера.

```bash
npm install
npm run smoke -- ./path/to/document.pdf
# или с подсказкой типа:
npm run smoke -- ./scan.jpg --hint TTN
```

Скрипт читает `.env`, поэтому работает с теми же настройками (LLM URL, Yandex ключ, пороги), что и сервер. Результат — JSON в stdout с разбивкой по этапам: какой OCR-движок отработал, что распозналось, что классификатор определил, что извлечено, какие поля не нашлись.

Tesseract и `pdftoppm` должны быть доступны в PATH (или гонять внутри Docker-образа: `docker compose run --rm api npm run smoke -- /app/data/uploads/<storage_id>/file.pdf`).

## Миграции БД

Управляются через `node-pg-migrate`. Файлы в `migrations/<timestamp>_<slug>.sql` с явными секциями `-- Up Migration` и `-- Down Migration`. Применённые миграции трекаются в таблице `pgmigrations` — повторный прогон применяет только новые.

В Docker всё происходит автоматически: отдельный one-shot сервис `migrate` стартует после Postgres, прогоняет все pending миграции, и только после его успеха запускаются `api` и `worker`.

Локальные команды:

```bash
npm run migrate                       # применить все pending миграции
npm run migrate:down                  # откатить последнюю (destructive)
npm run migrate:create add_column_x   # создать новый файл-шаблон в migrations/
```

После `migrate:create` редактируешь созданный файл — добавляешь SQL в `-- Up Migration` (и желательно зеркальный `DROP/ALTER` в `-- Down Migration` для возможности отката).

## Структура проекта

```
doc-service/
├── docker-compose.yml         api + worker + postgres + redis
├── Dockerfile                 node:22-slim + tesseract + poppler-utils
├── migrations/                node-pg-migrate (Up/Down секции, трекинг в pgmigrations)
├── data/                      локальное хранилище (volume)
└── src/
    ├── server.ts              Fastify entry
    ├── worker.ts              BullMQ Worker entry
    ├── config.ts              env через zod
    ├── db.ts / queue.ts       пулы pg / Redis
    ├── routes/                jobs, health
    ├── pipeline/
    │   ├── orchestrator.ts    главный сценарий
    │   ├── router.ts          выбор цепочки OCR
    │   ├── quality.ts         эвристики confidence
    │   ├── ocr/               pdf-text, tesseract, vision-llm, yandex
    │   ├── classifier/        keywords (+ интерфейс под ML)
    │   ├── llm/               клиент к inference-service
    │   └── parsers/           invoice, upd (Phase 1) + ttn/cmr/akt stubs
    ├── storage/               files (local fs), jobs (pg repo)
    └── webhooks/              доставка с HMAC и ретраями
```

## Фазы

- **Фаза 1 (текущая):** scaffold, OCR pipeline, классификатор по ключевым словам, парсеры invoice + УПД, webhook.
- **Фаза 2:** парсеры ТТН, CMR, АКТ.
- **Фаза 3:** AWB, коносамент, СМГС.
- **Параллельно:** отдельный inference-service (Qwen-VL) — поднимается рядом.

## Открытые вопросы

- Шаринг файлового стора с другими сервисами — пока локальная ФС, MinIO/S3 за интерфейсом `FileStorage`.
- Аутентификация между системами — пока не реализована, добавим API-ключ в `Authorization: Bearer ...` при необходимости.
