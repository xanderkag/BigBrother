# Document Processing Platform — parsdocs (`docs-parse`)

Универсальный сервис обработки транспортных, бухгалтерских и юридических документов: счёт, УПД, счёт-фактура, ТТН, CMR, акт, платёжка, commercial invoice, packing list, B/L, ГТД, кассовый чек, **договор, спецификация, допсоглашение** — 15 builtin-типов, плюс возможность завести свой через админ-UI без программиста. На входе — PDF/JPG/PNG/BMP/TIFF, на выходе — структурированный JSON с реквизитами, суммами, контрагентами, готовый для загрузки в 1С / ERP / CRM.

> **Корпоративный репозиторий (canonical):** `https://git.taipit.ru/airesearch/docs-parse`
> **Owner:** Ляпустин А.Ю. (`klgaigpt3@gmail.com`). Заместитель — TBD.
> **GitHub-зеркало:** `xanderkag/BigBrother` — параллельная отгрузка для backup'а и публичной демонстрации, **canonical всё равно TAIPIT GitLab**.

> **Статус:** AI-инициатива ТАЙПИТ, готовится к развороту в корп. песочнице на `10.10.13.10`. Phase 1 (счёт, УПД) работает на regex с LLM-fallback, Phase 2 (ТТН, CMR, АКТ) — через LLM. Боевых клиентов нет, нужен реальный прогон документов и доделать список из [TECH_DEBT.md](TECH_DEBT.md).

## Безопасность и регламент

- **LLM-режим:** для документов с реальными корп.данными разрешён **только локальный backend** (`BACKEND=openai_compat` через Ollama / vLLM / llama.cpp / LM Studio). Cloud-backend'ы (`claude`, `openai`) **запас и dev-режим**: годятся для синтетических документов и отладки промптов, но **не для прод-данных** — корп. данные не уходят в публичные облака LLM. Это требование ТАЙПИТ; смотри [SKILL правило #5].
- **Секреты:** `.env` никогда не коммитим. В репо только `.env.example` без значений. См. `doc-service/.env.example` и `inference-service/.env.example`.
- **Bearer-токены:** каждый пользователь получает свой personal access token (`pdpat_…`). Cred'ы на хосте — только через `.env` или secrets-manager песочницы. Master-ключ шифрования секретов (`SECRETS_ENCRYPTION_KEY`) разный на dev / staging / prod.
- **Yandex Vision (`yandex` engine):** **выключен по умолчанию.** При активном engine изображение уходит в Yandex Cloud — для ТТН/CMR с ПДн это 152-ФЗ риск. Per-job opt-out пока не реализован (см. `TECH_DEBT.md` пункт I8). До его реализации в проде с ПДн — `YANDEX_VISION_API_KEY=` пустой.
- **Корп. БД 1С / Bitrix24:** прямых SQL-подключений нет. Интеграции только через штатные API + явное согласование с владельцем системы.

---

## Что внутри

Платформа состоит из **двух независимых микросервисов** на общей Docker-сети:

```
┌────────────────────────────────────────────────────────────────────┐
│                      Клиент (1С / ERP / Telegram-бот)              │
│                                                                    │
│   POST /api/v1/jobs (multipart) → { job_id }                       │
│   GET  /api/v1/jobs/:id        → { extracted, validation_issues } │
│   PATCH /api/v1/jobs/:id/extracted   ← правка человеком            │
│   webhook  ← подписан HMAC-SHA256                                  │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ HTTPS, Bearer-токен
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  doc-service           Node.js + Fastify + BullMQ + PostgreSQL     │
│  ─────────────────────────────────────────────────────────────     │
│  1. Принимает файл, кладёт в очередь                               │
│  2. Воркер тянет из очереди, гонит OCR-цепочку:                    │
│        pdf-parse → tesseract → vision-llm → yandex (по падению)    │
│  3. Классифицирует (keyword / LLM)                                 │
│  4. Парсит по типу документа: regex (Phase 1) или LLM (Phase 2)    │
│  5. Доменная валидация: ИНН/КПП checksum, госномер, vat-консистент │
│  6. Сохраняет в Postgres, доставляет webhook                       │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ HTTP, опционально Bearer
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  inference-service     Python + FastAPI + Qwen-VL (или stub)       │
│  ─────────────────────────────────────────────────────────────     │
│  POST /v1/classify     — определить тип документа по тексту        │
│  POST /v1/extract      — извлечь поля по JSON-схеме                │
│  POST /v1/vision-ocr   — OCR сложного скана через VLM              │
│  POST /v1/verify       — нормализация и проверка извлечённого      │
│                                                                    │
│  Backend выбирается env'ом: stub (по умолчанию) или qwen (с GPU).  │
└────────────────────────────────────────────────────────────────────┘
```

Сервисы спроектированы быть **независимыми**: doc-service работает и без inference-service (теряются Phase 2 парсеры и vision-llm OCR-ступень, но Phase 1 на чистом regex продолжает работать). inference-service может обслуживать любые другие сервисы — контракт ручек доменный, не привязан к doc-service.

## Структура репозитория

```
Сканы документов/
├── README.md                         ← этот файл
├── TECH_DEBT.md                      ← всё, что не сделано + что сделано в этой итерации
├── docker-compose.doc-platform.yml   ← master compose, поднимает оба стека сразу
├── doc-service/                      ← Node.js сервис
│   ├── README.md                     ← детальный гайд по doc-service
│   ├── Dockerfile, docker-compose.yml
│   ├── migrations/001_init.sql       ← схема jobs
│   ├── src/                          ← бэкенд, см. ниже
│   ├── web/                          ← Operator UI: HTML + Tailwind + Alpine
│   └── tests/                        ← unit + integration
└── inference-service/                ← Python сервис
    ├── README.md                     ← гайд по inference-service
    ├── Dockerfile, docker-compose.yml
    ├── pyproject.toml, requirements.txt
    ├── src/inference_service/        ← FastAPI app + backends + prompts
    └── tests/
```

### doc-service/src/

```
src/
├── server.ts            ← Fastify + Swagger + zod validators
├── worker.ts            ← BullMQ worker: тянет из очереди, вызывает orchestrator
├── config.ts            ← env через zod, единый источник конфига
├── auth.ts              ← Bearer-токен hook (constant-time compare)
├── db.ts, queue.ts      ← Postgres pool, Redis connection
├── routes/
│   ├── jobs.ts          ← POST/GET/PATCH/LIST jobs
│   └── health.ts        ← /health (live), /ready (Postgres+Redis+storage)
├── pipeline/
│   ├── orchestrator.ts  ← сквозной сценарий: OCR → классификация → парсер → валидация
│   ├── router.ts, quality.ts
│   ├── ocr/             ← 4 движка за общим интерфейсом OcrEngine
│   ├── classifier/      ← keyword + интерфейс под LLM
│   ├── llm/             ← HTTP-клиент к inference-service
│   ├── parsers/         ← invoice/UPD (regex+LLM), TTN/CMR/AKT (LLM-only)
│   └── validation/      ← ИНН/КПП checksum, vat-консистентность, и т.п.
├── storage/
│   ├── files.ts         ← LocalFs за интерфейсом FileStorage
│   └── jobs.ts          ← репо поверх pg
├── webhooks/deliver.ts  ← HMAC-подписанный POST с экспоненциальным backoff
├── workers/
│   ├── pending-job-sweeper.ts  ← re-enqueue зависших pending jobs (C1)
│   └── file-cleanup.ts         ← TTL чистка uploaded файлов (C4)
├── types/
│   ├── documents.ts     ← zod-схемы invoice/TTN/CMR/AKT
│   ├── api-schemas.ts   ← zod-схемы request/response API
│   └── document-json-schemas.ts  ← JSON Schema для LLM /extract
└── scripts/
    ├── migrate.ts       ← применение SQL-миграций
    └── smoke.ts         ← CLI: PDF/JPG → JSON отчёт без БД и очереди
```

### inference-service/src/inference_service/

```
inference_service/
├── main.py              ← FastAPI app + lifespan
├── config.py            ← pydantic-settings
├── auth.py              ← Bearer-token middleware
├── deps.py              ← DI: get_backend() singleton
├── schemas.py           ← Pydantic request/response
├── routes/              ← classify, extract, vision-ocr, verify
├── backends/
│   ├── base.py          ← ABC: ModelBackend
│   ├── stub.py          ← детерминированный (для CI и dev)
│   └── qwen_vl.py       ← Qwen2.5-VL через transformers (GPU)
└── prompts/             ← шаблоны промптов по задачам
```

---

## Quick Start

### Полный стек одной командой

```bash
docker network create ai-platform     # один раз
docker compose -f docker-compose.doc-platform.yml up -d --build
```

После старта:

| Сервис | URL | Что |
|---|---|---|
| **Operator UI** | **`http://localhost:3000/`** | загрузка документов, статусы, корректировка extracted |
| doc-service API | `http://localhost:3000/api/v1` | основной REST API |
| doc-service Swagger UI | `http://localhost:3000/docs` | интерактивная документация |
| doc-service OpenAPI JSON | `http://localhost:3000/docs/json` | для кодогенерации клиентов |
| doc-service health | `http://localhost:3000/ready` | пробник: Postgres + Redis + storage |
| doc-service metrics | `http://localhost:3000/metrics` | Prometheus scrape (Node runtime + кастомные счётчики) |
| inference-service API | `http://localhost:8000` | LLM-инференс |
| inference-service Swagger | `http://localhost:8000/docs` | авто из FastAPI |
| inference-service ReDoc | `http://localhost:8000/redoc` | альтернативный UI |
| inference-service metrics | `http://localhost:8000/metrics` | Prometheus scrape (Python runtime + HTTP histograms) |

В `doc-service/.env` прописать связь:

```
LLM_INFERENCE_URL=http://inference:8000
```

Без этой строки `vision-llm` ступень OCR-цепочки выпадает и Phase 2 парсеры (ТТН/CMR/АКТ) деградируют до `needs_review`.

### С локальной open-source моделью (Ollama)

Если нет облачного API-ключа или хочется экономии — поднимаем Ollama рядом со стеком:

```bash
docker network create ai-platform     # один раз
docker compose -f docker-compose.doc-platform.yml -f docker-compose.local-models.yml up -d
```

По умолчанию подтянется `qwen2.5vl:7b` (~6 GB). Поменять модель — переменная окружения `OLLAMA_PULL` (например `llama3.2-vision:11b`). Затем в `inference-service/.env`:

```
BACKEND=openai_compat
OPENAI_BASE_URL=http://ollama:11434/v1
OPENAI_MODEL=qwen2.5vl:7b
```

Полное сравнение моделей, требования к VRAM/CPU и рекомендации по сценариям (dev / prod GPU / air-gapped / самое дешёвое) — [inference-service/MODELS.md](inference-service/MODELS.md).

### Только doc-service (без LLM)

Если нет GPU и Phase 2 не нужен прямо сейчас:

```bash
cd doc-service
cp .env.example .env
docker compose up --build
```

Phase 1 (счёт, УПД) полностью работает на regex.

### Локальная разработка без Docker

```bash
# doc-service
cd doc-service
npm install
npm run dev:api      # API server with hot reload
npm run dev:worker   # BullMQ worker (в другом терминале)
npm run smoke -- ./test-invoice.pdf  # быстрый прогон документа без БД/очереди
npm test

# inference-service
cd inference-service
python -m venv .venv
.venv\Scripts\Activate.ps1     # PowerShell (Windows)
pip install -e ".[dev]"
uvicorn inference_service.main:app --host 0.0.0.0 --port 8000 --app-dir src
pytest
```

Требования: Node 22+, Python 3.11+, `tesseract-ocr` и `poppler-utils` в PATH (для smoke без Docker).

---

## Operator UI

`http://localhost:3000/` — встроенный веб-интерфейс для операторов. Логин по API-токену (тот же `API_KEY` что в env), хранится в localStorage браузера. После логина:

- Список задач с фильтрами по статусу и типу документа, auto-refresh для in-flight (pending/processing).
- Drag-and-drop загрузка документов с опциональными полями (`document_hint`, `webhook_url`, `metadata`).
- Детальная страница задачи: статус, confidence-bar, `validation_issues`, JSON-viewer для `extracted`, RAW OCR text (collapsed), ручная правка `extracted` с PATCH (валидация перезапускается автоматически).
- Dark mode (auto-detect + manual toggle + remember в localStorage).
- Responsive layout (нормально работает на ноутах и широких мониторах).

**Стек:** чистый HTML + Tailwind v3 (Play CDN) + Alpine.js, без build-шага. Файлы в `doc-service/web/`. Расширять под новые экраны — без vite/webpack возни.

---

## API в двух словах

### Загрузка документа

```http
POST /api/v1/jobs
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data

file=<binary>
webhook_url=https://example.com/hook   (опционально)
document_hint=invoice                   (опционально, пропускает классификатор)
metadata={"my_id":"X-123"}              (опционально, ≤ 64 KB)
```

→ `202 { job_id, status: "pending" }`. Обработка асинхронная.

### Получение результата

```http
GET /api/v1/jobs/:id
Authorization: Bearer <API_KEY>
```

→ полный объект:

```json
{
  "job_id": "...",
  "status": "done | needs_review | failed",
  "document_type": "invoice | factInvoice | UPD | TTN | CMR | AKT",
  "confidence": 0.87,
  "ocr_engine": "pdf-text | tesseract | vision-llm | yandex",
  "raw_text": "распознанный текст",
  "extracted": {
    "number": "123",
    "date": "2026-01-15",
    "seller": { "name": "...", "inn": "...", "kpp": "..." },
    "buyer":  { ... },
    "total": 27500,
    "vat": 4583.33,
    "vat_rate": 20,
    "positions": [ ... ]
  },
  "validation_issues": [
    "ИНН 7712345678: контрольная сумма не сходится",
    "НДС 5000 не сходится с total×rate/(100+rate) ≈ 4583.33"
  ],
  "metadata": { "my_id": "X-123" },
  "error": null,
  "created_at": "...",
  "finished_at": "..."
}
```

### Корректировка после оператора

```http
PATCH /api/v1/jobs/:id/extracted
Authorization: Bearer <API_KEY>
Content-Type: application/json

{ "поля": "новые значения" }
```

→ `extracted` перезаписывается, валидация перезапускается, статус → `done` (если issues пропали).

### Webhook доставки

Если при создании job'а указан `webhook_url`, после завершения обработки на этот URL придёт `POST` с body = тем же JSON, что и `GET /jobs/:id`. Заголовки:

- `X-DocService-Signature: sha256=<hex>` — HMAC-SHA256 от тела с секретом `WEBHOOK_HMAC_SECRET`
- `X-DocService-Job-Id: <uuid>`
- `X-DocService-Attempt: <n>` — номер попытки (с 1)

Доставка ретраится с экспоненциальным backoff'ом до `WEBHOOK_MAX_ATTEMPTS` раз. На 4xx (кроме 408/429) — выходит сразу.

Полное описание со схемами всех ручек — на `http://localhost:3000/docs` (Swagger UI).

---

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
```

Принципы:
- **Сначала бесплатное и приватное, потом платное и в облако.** pdf-parse не делает сетевых вызовов, tesseract работает локально, vision-llm идёт в собственный inference-service на ваших мощностях, и только Yandex кладёт картинку в чужое облако.
- **Движки за общим интерфейсом.** Можно добавить пятый, отключить любой через env, поменять порядок.
- **Per-job опт-аут от Yandex** для документов с ПДн — в долге (см. [TECH_DEBT.md](TECH_DEBT.md) пункт I8). До его реализации — держать `YANDEX_VISION_API_KEY` пустым в проде, обрабатывающем такие документы.

## Парсеры по фазам

| Фаза | Документ | Подход | Статус |
|---|---|---|---|
| 1 | Счёт на оплату | regex + LLM-fallback при низкой уверенности | ✅ |
| 1 | Счёт-фактура | regex + LLM-fallback | ✅ |
| 1 | УПД | regex + LLM-fallback | ✅ |
| 2 | ТТН | LLM /extract по JSON Schema | ✅ (требует inference-service) |
| 2 | CMR | LLM /extract | ✅ |
| 2 | АКТ | LLM /extract | ✅ |
| 3 | AWB, коносамент, СМГС | TBD | ⏳ |

Без `LLM_INFERENCE_URL` Phase 2 парсеры возвращают пустой `extracted` и `status: needs_review` — это honest fallback, не падение.

## Доменная валидация

После парсинга запускается проверка реалистичности данных. Не падает — пишет issues:

| Поле | Что проверяется |
|---|---|
| `seller.inn`, `buyer.inn`, `shipper.inn` и т.п. | **Контрольная сумма** по приказу ФНС, не просто 10/12 цифр |
| `seller.kpp` | Формат NNNNCCNNN (9 символов) |
| `vehicle.plate` | Только 12 разрешённых ГИБДД букв (АВЕКМНОРСТУХ), формат А123ВВ77 |
| `sender.country` (CMR) | ISO 3166 alpha-2 |
| `date` | Календарно валидна, после 2010, не более 30 дней в будущем |
| `total`, `vat` | ≥ 0, конечны, < 1 трлн |
| `vat` vs `total`×`vat_rate`/(100+rate) | Допуск 0.5% или 1 руб |
| `∑positions[].total` vs `total` | Допуск 1% или 1 руб |
| `seller.inn` vs `buyer.inn` | Не должны совпадать |
| ТТН: `cargo.weight_nett` vs `weight_gross` | Нетто не больше брутто |

Любой `validation_issue` → автоматически `status: needs_review`, чтобы человек подтвердил. Корректировка через `PATCH /extracted` перезапускает валидацию — поправил типо в ИНН, issue ушёл, статус снова `done`.

## Безопасность

- **API защищён Bearer-токеном** (`API_KEY`). Пустой = dev-режим, любой проходит.
- **Webhook подписывается HMAC-SHA256.** Получатель верифицирует тело + заголовок.
- **Constant-time compare** для токена — защита от timing-атаки.
- **Сравнение секретов на сервере**, не клиенте. На стороне клиента просто `Authorization: Bearer ...`.
- **Inference-service** имеет свой независимый `API_KEY`, обычно не открывается наружу.

Ограничения по умолчанию:
- `MAX_UPLOAD_MB=50` (размер файла)
- `MAX_METADATA_BYTES=65536` (64 KB на JSON-метаданные)
- `WORKER_CONCURRENCY=1` (параллельных задач на воркер; tesseract single-threaded)

В TECH_DEBT'е лежат: rate-limiting (I5), idempotency-key (I1), file-magic-bytes валидация (B5).

---

## Where to look next

| Хочу узнать о... | Куда смотреть |
|---|---|
| детали API-контракта | `http://localhost:3000/docs` (Swagger UI) |
| что не доделано | [TECH_DEBT.md](TECH_DEBT.md) |
| как устроен doc-service | [doc-service/README.md](doc-service/README.md) |
| как устроен inference-service | [inference-service/README.md](inference-service/README.md) |
| как поднять Qwen на GPU | [inference-service/README.md](inference-service/README.md) → раздел про GPU |
| как добавить новый тип документа | `doc-service/src/types/documents.ts` (схема) → `parsers/` (новый класс) → `validation/index.ts` (правила) |
| как поменять модель LLM | `inference-service/src/inference_service/backends/` — новый backend, дальше переключение через `BACKEND` env |
| как сменить хранилище на S3/MinIO | `doc-service/src/storage/files.ts` — реализовать `S3FileStorage` за интерфейсом `FileStorage`, переключить в orchestrator. Зацепка в TECH_DEBT A2. |

---

## Что было сделано в текущей итерации

Кратко по дням, для будущих контрибьюторов и для себя через месяц:

1. **Scaffold doc-service** — Fastify + BullMQ + Postgres + tesseract в Docker, OCR-конвейер с интерфейсом `OcrEngine`, заглушка под LLM-инференс, парсеры invoice/УПД на regex.
2. **Scaffold inference-service** — FastAPI + четыре доменных ручки. Stub-backend для dev, Qwen-VL backend для прода.
3. **End-to-end pipeline + smoke runner** — `runDocumentPipeline` как чистая функция, CLI `npm run smoke -- file.pdf`, интеграционный тест на полный путь.
4. **Phase 2 парсеры через LLM** — ТТН/CMR/АКТ делегируют в `inference-service /v1/extract` по JSON Schema.
5. **LLM-fallback для Phase 1** — invoice/UPD сначала regex, при низкой уверенности — LLM, берётся лучший результат.
6. **Bearer auth** на `/api/v1/*`, /health и /ready остаются публичными.
7. **Swagger / OpenAPI** через `@fastify/swagger` + `fastify-type-provider-zod`. Один источник правды (zod) для валидации, типов и доков.
8. **Master docker-compose** — оба сервиса одной командой через `include:` на общем external network.
9. **Архитектурное ревью + tech debt**, плюс шесть быстрых правок: WORKER_CONCURRENCY, metadata cap, sanitize Unicode, Yandex PII warning, reject 0-byte uploads, валидация webhook_url.
10. **Доменная валидация** — ИНН/КПП checksum, госномер ТС, согласованность НДС с total, диапазон дат, ISO-страна, разделение продавец/покупатель. Issues отдаются клиенту в `validation_issues[]`, автоматический `needs_review` при наличии проблем, перепроверка после ручной правки.
11. **Усиленный `/ready` пробник** — Postgres + Redis + storage writable.

## Что НЕ сделано (важное)

Полный список с оценками часов — в [TECH_DEBT.md](TECH_DEBT.md). Самое критичное перед боевым запуском:

- **C1**: outbox/poller для зависших pending jobs (Redis моргнул → job висит).
- **C3**: нормальная система миграций (сейчас только idempotent INIT-скрипт).
- **C4**: TTL на загруженные файлы (диск кончится).
- **I1**: idempotency-key для ретраев клиента.
- **I4**: метрики `/metrics` для observability.
- **I6**: реальный вызов Yandex Vision API для проверки контракта.
- **I8**: per-job opt-out от Yandex для документов с ПДн.

Для пилотного запуска на 1-2 интеграторов критично закрыть **C1, C4, I8**. Остальное — по мере роста нагрузки.

## License & ownership

Внутренний скаффолд. Лицензия — proprietary. Контакты для доработки и интеграции — у владельца репозитория.
