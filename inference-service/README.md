# inference-service

Доменно-ориентированный inference-сервис: четыре HTTP-ручки, за которыми может стоять Qwen2.5-VL (по умолчанию), любая другая VLM или stub для разработки без GPU.

Подключается к [doc-service](../doc-service) и любым другим клиентам — контракт не привязан к конкретной модели или провайдеру.

## Стек

- Python 3.11 + FastAPI + uvicorn
- Pydantic v2 для схем запросов/ответов
- Backend (model adapter) выбирается через `BACKEND` env:
  - `stub` (по умолчанию) — детерминированные ответы по эвристикам, без ML-зависимостей; для dev/CI.
  - `claude` — Anthropic Claude через SDK; нужен `ANTHROPIC_API_KEY`.
  - `openai` — облачный OpenAI через `openai` SDK; нужен `OPENAI_API_KEY`.
  - **`openai_compat`** — универсальный клиент к любому OpenAI-API-совместимому серверу (Ollama / vLLM / llama.cpp / LM Studio). Рекомендуемый путь для локальных моделей. См. [MODELS.md](MODELS.md).
  - `qwen` — Qwen2.5-VL напрямую через transformers; нужен GPU (≥8GB VRAM для 3B, ≥16GB для 7B). Для большинства задач лучше `openai_compat` + Ollama/vLLM (быстрее, меньше зависимостей).

## Локальные модели за 3 минуты

```bash
# 1. поднимаем Ollama + parsdocs стек
docker network create ai-platform 2>/dev/null || true
docker compose -f ../docker-compose.doc-platform.yml -f ../docker-compose.local-models.yml up -d

# 2. модель скачается автоматически (qwen2.5vl:7b по умолчанию)
# чтобы поменять — установите OLLAMA_PULL=llama3.2-vision:11b в .env

# 3. переключаем inference-service на openai_compat
cat >> .env <<'EOF'
BACKEND=openai_compat
OPENAI_BASE_URL=http://ollama:11434/v1
OPENAI_MODEL=qwen2.5vl:7b
EOF
docker compose restart inference

# 4. проверяем
curl http://localhost:8000/v1/providers/status
```

Подробнее о выборе модели, требованиях к железу и трейдоффах — [MODELS.md](MODELS.md).

## Документация API

FastAPI генерирует OpenAPI-спеку автоматически:

- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`
- OpenAPI JSON: `http://localhost:8000/openapi.json`

Бесплатно из коробки — отдельных плагинов не требуется.

## API

Все ручки принимают и возвращают JSON. Если задан `API_KEY`, требуется заголовок `Authorization: Bearer <key>`.

### `POST /v1/classify`

```json
{ "text": "..." }
```

```json
{ "type": "invoice", "confidence": 0.92 }
```

`type` — один из `invoice | factInvoice | UPD | TTN | CMR | AKT | null`.

### `POST /v1/extract`

```json
{
  "text": "...",
  "schema": { "type": "object", "properties": { "...": "..." } },
  "hint": "TTN"
}
```

```json
{
  "extracted": { "...": "..." },
  "confidence": 0.85,
  "issues": ["seller.inn could not be reliably extracted"]
}
```

### `POST /v1/vision-ocr`

```json
{
  "image_base64": "<base64 PNG/JPEG>",
  "prompt": "опционально: подсказка модели"
}
```

```json
{ "text": "распознанный текст", "confidence": 0.78 }
```

Принимает одну страницу. Doc-service сам растрирует PDF постранично и шлёт по одной странице за вызов.

### `POST /v1/verify`

```json
{
  "extracted": { "...": "..." },
  "raw_text": "..."
}
```

```json
{
  "extracted": { "...": "нормализованные значения" },
  "issues": ["date format normalized from 15.01.26 to 2026-01-15"]
}
```

### `GET /health` · `GET /ready`

Стандартные пробы. `/ready` возвращает 503, если backend не загружен.

## Запуск

### Stub-режим (без GPU, без ML)

```bash
cp .env.example .env   # BACKEND=stub по умолчанию
docker compose up --build
```

Сервис стартует за секунды, `/v1/classify` и прочие отдают эвристические ответы. Для интеграционных тестов doc-service этого достаточно.

### Qwen2.5-VL (GPU)

1. Раскомментировать GPU-блок в `docker-compose.yml`.
2. Изменить `FROM` в `Dockerfile` на CUDA-базу (см. комментарий в конце файла).
3. В `.env` поставить `BACKEND=qwen`. На первом вызове скачается ~7-15GB весов в HuggingFace cache (volume `hf-cache`).
4. `docker compose up --build`.

### Локально без Docker

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"             # +qwen для GPU-режима
uvicorn inference_service.main:app --host 0.0.0.0 --port 8000 --app-dir src
```

Тесты:

```bash
pytest
```

## Связь с doc-service

Дефолтный network — `ai-platform` (external). Создать один раз:

```bash
docker network create ai-platform
```

В `doc-service/.env`:

```
LLM_INFERENCE_URL=http://inference:8000
```

В обоих docker-compose сервисы должны быть в `networks: [ai-platform]`. Теперь doc-service ходит по DNS-имени `inference` к внутреннему порту 8000.

## Структура

```
inference-service/
├── Dockerfile                # python:3.11-slim, переключается на CUDA base
├── docker-compose.yml        # standalone, общий network "ai-platform"
├── pyproject.toml            # PEP 621, extras [qwen, dev]
├── requirements.txt          # core, для быстрого Docker-кеширования
├── requirements-qwen.txt     # heavy ML deps (отдельный слой)
└── src/inference_service/
    ├── main.py               # FastAPI app
    ├── config.py             # pydantic-settings
    ├── auth.py               # Bearer middleware
    ├── deps.py               # DI: backend singleton
    ├── schemas.py            # request/response модели
    ├── routes/               # classify, extract, vision, verify
    ├── backends/             # base.py (ABC), stub.py, qwen_vl.py
    └── prompts/              # шаблоны промптов по задачам
```

## Заметки по безопасности

- API защищён Bearer-токеном (если задан `API_KEY`).
- Vision-ручка принимает base64 — это нагрузка на память при больших страницах. Для production: ограничить размер тела (uvicorn `--limit-max-request-size`, или nginx).
- Логи не содержат тел запросов и base64-картинок. При отладке — поставить `LOG_LEVEL=debug`.
