# Развёртывание parsdocs на локальной модели

Этот документ — пошаговый чеклист «от пустой машины до первого распознанного документа за 30-60 минут». Все команды проверены на Linux и Windows (через WSL2).

Если что-то не работает — смотрите раздел [Troubleshooting](#troubleshooting) в конце.

---

## 1. Что вам понадобится

### Железо

| Сценарий | RAM | Disk | GPU | Замечание |
|---|---|---|---|---|
| **Smoke (dev на ноуте)** | 16 GB | 30 GB | не обязателен (CPU/Metal сойдёт) | Скорость 30-60s/документ на CPU |
| **Пилот** (до 100 документов/день) | 32 GB | 100 GB | 1× с 16 GB VRAM (RTX 4080 / A4000) | Скорость 10-20s/документ |
| **Прод** (1000+ документов/день) | 64 GB | 500 GB SSD | 1× с 24+ GB VRAM (RTX 4090 / A100) + vLLM | Скорость 3-8s/документ, throughput за счёт continuous batching |

Подробное сравнение моделей × железа — [inference-service/MODELS.md](inference-service/MODELS.md).

### ПО на хосте

- **Docker** ≥ 24.0 и **docker compose** v2.
- **git**.
- (Опционально, для GPU) **NVIDIA Container Toolkit**: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
- На Windows: **WSL2** с Ubuntu 22.04+, Docker Desktop с включённой WSL-интеграцией.

### Проверка готовности хоста

```bash
docker --version           # >= 24.0
docker compose version     # >= v2.20
docker run hello-world     # должен пройти без ошибок

# Если планируете GPU:
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
# должен показать вашу GPU
```

---

## 2. Получаем код

**Канонический источник — корпоративный GitLab:**

```bash
git clone https://git.taipit.ru/airesearch/docs-parse.git parsdocs
cd parsdocs
```

Если учётки в `git.taipit.ru` нет — открыть портал, залогиниться через Keycloak доменной учёткой (`DOMAIN\username` или e-mail). После первого логина — обратиться в DB Support за апрувом, если доступ к репозиториям не появился.

GitHub-mirror (`xanderkag/BigBrother`) — параллельная отгрузка для backup'а и публичных демо. Канонический путь — **только** TAIPIT GitLab. Никаких чувствительных данных (паролей БД, API-токенов, экземпляров реальных документов) в обоих репозиториях быть не должно — только `.env.example` без значений.

---

## 3. Настройка окружения

### 3.1. Сеть Docker

Один раз создаём общую сеть для двух сервисов (doc-service + inference-service):

```bash
docker network create ai-platform
```

### 3.2. `doc-service/.env`

```bash
cp doc-service/.env.example doc-service/.env
```

Откройте `doc-service/.env` и заполните **три обязательные строки**:

```env
# Bearer-токен для API. Сгенерировать: openssl rand -hex 32
API_KEY=<вставьте_сгенерированный_токен>

# Master-ключ шифрования секретов в БД (api-ключи провайдеров).
# Сгенерировать: openssl rand -hex 32
SECRETS_ENCRYPTION_KEY=<вставьте_сгенерированный_ключ>

# HMAC-секрет для webhook-подписи (если используете). Если нет — оставьте change-me.
WEBHOOK_HMAC_SECRET=<вставьте_другой_сгенерированный_секрет>

# Связь с inference-service (Docker service name).
LLM_INFERENCE_URL=http://inference:8000
```

Сгенерировать все три значения одной командой:
```bash
for v in API_KEY SECRETS_ENCRYPTION_KEY WEBHOOK_HMAC_SECRET; do
  echo "$v=$(openssl rand -hex 32)"
done
```

### 3.3. `inference-service/.env`

```bash
cp inference-service/.env.example inference-service/.env  # если есть; иначе создайте пустой
```

Заполните для **локальной модели через Ollama** (самый быстрый путь):

```env
BACKEND=openai_compat
OPENAI_BASE_URL=http://ollama:11434/v1
OPENAI_MODEL=qwen2.5vl:7b
# OPENAI_API_KEY можно не задавать — Ollama не требует
```

> Если хотите облачный Claude вместо локалки — `BACKEND=claude` + `ANTHROPIC_API_KEY=sk-ant-...`. Локальный путь дальше.

---

## 4. Запуск

### 4.1. Полный стек с локальной моделью

```bash
docker compose \
  -f docker-compose.doc-platform.yml \
  -f docker-compose.local-models.yml \
  up -d --build
```

Что произойдёт:
1. Запустится Ollama (порт 11434).
2. Контейнер `ollama-bootstrap` начнёт **скачивать модель** (~6 GB для qwen2.5vl:7b). Это разовый процесс, может занять 5-20 минут в зависимости от интернета.
3. Параллельно поднимутся PostgreSQL, Redis, doc-service api+worker, inference-service.

### 4.2. Дождаться готовности

```bash
# Следим за скачиванием модели:
docker compose -f docker-compose.local-models.yml logs -f ollama-bootstrap

# Когда увидите "Bootstrap done." — Ctrl+C.

# Проверяем, что inference-service видит модель:
curl http://localhost:8000/ready
# Ожидаем: {"status":"ready","backend":"openai-compat"}

# Если "not_ready" с reason "probe failed" — значит Ollama не успела
# загрузить модель в память. Подождите 30 секунд и повторите.
```

### 4.3. Проверка doc-service

```bash
curl http://localhost:3000/ready
# Ожидаем: {"status":"ready"}
```

Откройте в браузере: **http://localhost:3000/**

Войдите тем `API_KEY`, который указали в `.env`.

---

## 5. Smoke-тест на реальном документе

Положите PDF/JPG/PNG с типовым счётом в `samples/test.pdf` и запустите:

```bash
docker compose -f docker-compose.doc-platform.yml exec api \
  npm run smoke -- /app/samples/test.pdf --ping-inference
```

(Если запускаете без Docker, на хосте: `cd doc-service && npm run smoke -- ../samples/test.pdf --ping-inference`)

Что увидите:
- **Pre-flight ping** к inference-service — если упало здесь, проблема с моделью (см. troubleshooting).
- **OCR step** — какой движок отработал (pdf-parse / tesseract / vision-llm), latency.
- **Classification** — какой тип распознан и по какому ключу.
- **Extraction** — финальный JSON + confidence + missing-поля.
- **Latency breakdown** в секции `duration` — сразу видно, где узкое место.

Пример вывода (фрагмент):
```json
{
  "duration": { "total_ms": 14523, "ocr_ms": 1820, "post_ocr_ms": 12702 },
  "ocr": { "engine": "pdf-parse", "confidence": 0.95, ... },
  "classification": { "document_type": "invoice", "source": "keyword" },
  "extraction": {
    "parser_confidence": 0.88,
    "extracted": { "number": "СЧ-001", "date": "2026-03-15", "total": 15000, ... }
  }
}
```

Если получилось — **развёртывание успешно**. Можно загружать документы через веб-UI.

---

## 6. Альтернативы Ollama

### vLLM (production GPU)

Когда нужен throughput больше ~20 документов/мин, или 3-5× меньше latency:

```yaml
# docker-compose.vllm.yml — пример, файл пока в TODO (см. TECH_DEBT)
services:
  vllm:
    image: vllm/vllm-openai:latest
    command: >
      --model Qwen/Qwen2.5-VL-7B-Instruct
      --max-model-len 16384
    ports: ["8001:8000"]
    deploy:
      resources:
        reservations:
          devices: [{driver: nvidia, count: 1, capabilities: [gpu]}]
    networks: [ai-platform]
```

Затем в `inference-service/.env`:
```env
OPENAI_BASE_URL=http://vllm:8000/v1
OPENAI_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
```

### LM Studio (desktop с GUI)

Удобно для оператора, который хочет «увидеть» работу модели:
- Установите LM Studio с https://lmstudio.ai/
- Скачайте модель через GUI, запустите local server (порт 1234).
- В `inference-service/.env`:
  ```env
  OPENAI_BASE_URL=http://host.docker.internal:1234/v1
  OPENAI_MODEL=qwen2.5-vl
  ```

### llama.cpp (минимальное железо, GGUF Q4)

Для air-gapped или ноутбука без GPU:
- Скачайте `qwen2.5-vl-7b-instruct-q4_k_m.gguf` (~5 GB) с HuggingFace.
- Запустите `llama-server -m <gguf> -c 16384 --port 8080`.
- В env: `OPENAI_BASE_URL=http://host.docker.internal:8080/v1`.

---

## 7. Замена модели

Через UI: открыть `http://localhost:3000/#providers`, найти провайдера `openai-compat` (или создать новый), поменять `model`, сохранить → следующий job подхватит изменение (TTL кэша 30 секунд).

Через CLI на Ollama:
```bash
docker compose -f docker-compose.local-models.yml exec ollama ollama pull llama3.2-vision:11b

# Потом в inference-service/.env:
# OPENAI_MODEL=llama3.2-vision:11b
docker compose -f docker-compose.doc-platform.yml restart inference
```

---

## 8. Troubleshooting

### `/ready` возвращает `not_ready`

```bash
curl -s http://localhost:8000/ready | jq
# {"status": "not_ready", "backend": "openai-compat", "reason": "probe failed: ..."}
```

**`probe timeout (5s)`** — Ollama ещё грузит модель в память. Подождать 30-60 секунд, попробовать снова. Проверить логи: `docker compose logs ollama`.

**`probe failed: ConnectionError`** — Ollama не запущен или не виден из inference-сети. Проверить: `docker compose ps`. Контейнеры `ollama` и `inference` должны быть в одной сети `ai-platform`.

**`probe failed: 404`** — версия Ollama старая или модель не установлена. `docker compose exec ollama ollama list` — должна показать модель из `OPENAI_MODEL`.

### Smoke падает на `pre-flight ping failed`

Проверьте по очереди:
1. `curl http://localhost:8000/health` — отвечает?
2. `curl http://localhost:8000/ready` — `ready` или `not_ready`?
3. Если `not_ready` — см. предыдущий пункт.

### Модель отвечает, но extract возвращает пустой JSON

Возможные причины:
- **`response_format: json_object` не поддерживается старой версией Ollama**. Обновите Ollama до 0.5+. Можно проверить логи inference-service — там будет `backend rejected response_format=json_object, retrying without`.
- **Промпт слишком длинный для контекста модели**. У Qwen2.5-VL 7B контекст 32k; документ до 12k символов (наш truncate) укладывается. Если у вас более крупный документ → увеличьте `--max-model-len` для vLLM, или используйте модель с большим контекстом.
- **Модель отвечает не на русском**. Попробуйте указать в админ-UI кастомную инструкцию для типа документа (`llm_prompt`): «Отвечай только на русском, в формате JSON».

### Ollama-bootstrap не докачал модель

Если интернет нестабильный или модель большая:
```bash
docker compose -f docker-compose.local-models.yml exec ollama \
  ollama pull qwen2.5vl:7b
```
Это можно повторять сколько угодно — `ollama pull` идемпотентен.

### GPU не виден из контейнера Ollama

Проверки:
```bash
# 1. На хосте видно GPU?
nvidia-smi

# 2. NVIDIA Container Toolkit установлен?
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi

# 3. В docker-compose.local-models.yml раскомментирован блок deploy.resources.reservations?
```

Без GPU Ollama работает на CPU — медленно, но работает.

### Высокая латентность на extract'е

Типичные цифры на разном железе (qwen2.5vl:7b, средний счёт):
- M2 MacBook Pro (Metal): 20-40s
- RTX 4080 16GB: 8-15s
- A100 40GB через vLLM: 2-5s

Если у вас в разы хуже — проверьте:
- `docker stats` — упирается ли в RAM/CPU?
- Размер документа (страниц много → больше vision-OCR'а).
- Не висит ли OCR на tesseract (см. `duration.ocr_ms` в smoke-отчёте).

---

## 9. Что после первого документа

1. **Создать тип документа под клиента**. Откройте `http://localhost:3000/#document-types/new` — заведите специфический тип (свой slug, поля, инструкция агенту).
2. **Подключить webhook**. В upload-запросе передавать `webhook_url` — после обработки на ваш endpoint придёт POST с результатом + HMAC-подпись.
3. **Сменить модель если качество не устроило**. Бенчмарки разных моделей под наши задачи — в [inference-service/MODELS.md](inference-service/MODELS.md). Универсальный совет: начинайте с Qwen2.5-VL 7B, если плохо на русском — попробуйте MiniCPM-V 2.6 или Granite-Vision 3.2.
4. **Включить аудит**. Просто работайте — каждое изменение типа/провайдера автоматически пишется в `audit_log` с before/after. Видно через `http://localhost:3000/#audit-log`.

---

## 10. Чек-лист завершения

- [ ] `curl http://localhost:3000/ready` → `ready`
- [ ] `curl http://localhost:8000/ready` → `ready`
- [ ] `npm run smoke -- samples/test.pdf --ping-inference` отрабатывает за разумное время
- [ ] Открывается веб-UI на `http://localhost:3000/`, логин по API_KEY работает
- [ ] Через UI можно загрузить документ, увидеть его в очереди, дождаться `done`
- [ ] Результат `extracted` соответствует ожиданиям
- [ ] (Опционально) Webhook доставляется на тестовый endpoint с правильной HMAC-подписью

---

## 11. Развёртывание в корпоративной песочнице ТАЙПИТ

Этот раздел — для случая «локально работает, теперь нужно поднять на `10.10.13.10` под поддоменом `*.taipit.ru`», по правилам внутренней AI-инициативы. Канонический документ-регламент — «Памятка автору решения, разрабатываемого вне штатного процесса разработки» (v0.2+, в стадии согласования). Этот раздел — практическая выжимка под наш конкретный стек.

### 11.1. Что должен подготовить автор

| Артефакт | Где | Статус |
|---|---|---|
| Репо в `git.taipit.ru/airesearch/docs-parse` | `git@git.taipit.ru:airesearch/docs-parse.git` | ✅ создан |
| Актуальная `main` запушена в TAIPIT-origin | `git push origin main` | проверяй каждый раз перед заявкой |
| `Dockerfile` + `docker-compose.yml` | в `doc-service/` и `inference-service/`, мастер-compose в корне | ✅ |
| `.env.example` без значений | в каждом сервисе | ✅ |
| `OWNERS.md` (owner + заместитель) | в корне | ✅ см. файл |
| `README.md` с описанием проекта и security-нотой | корень | ✅ |
| Deploy Token для прод-машины (read-only) | GitLab → Settings → Repository → Deploy tokens | создаётся по запросу DB Support |

### 11.2. Что просить у DB Support

Готовый шаблон письма — см. `OWNERS.md` (раздел «Запрос на развёртывание»). Кратко:

| Параметр | Значение |
|---|---|
| **Имя проекта** | `docs-parse` (внутренний name `parsdocs`) |
| **Желаемый поддомен** | `parsdocs.taipit.ru` (или другой свободный) |
| **Стек** | Node.js 22 (Fastify) + Python 3.11 (FastAPI) + PostgreSQL 16 + Redis 7. Опционально — Ollama / vLLM для локальной модели. Всё через `docker compose`. |
| **WebSocket / SSE / Upgrade-headers** | НЕ требуются. Чистый REST + polling в UI. |
| **Внешний порт** | один: `doc-service:3000` (UI + API). `inference:8000` — только внутри docker-сети, наружу не публикуется. |
| **TLS** | через корп. nginx, HTTPS-only. |
| **Ресурсы (пилот)** | 32 GB RAM, 100 GB disk, GPU желателен (≥16 GB VRAM для Qwen2.5-VL 7B). См. таблицу в разделе 1. |
| **Корп. БД** | НЕ требуется — у сервиса своя Postgres в compose. `pg_hba.conf` не релевантен. |
| **DBA-доступы** | не нужны. |

### 11.3. Регламент работы с кодом

- **Все правки идут в `origin` (`git.taipit.ru/airesearch/docs-parse`).** GitHub `xanderkag/BigBrother` — параллельный mirror, на него тоже пушим, но canonical = TAIPIT.
- **Перед каждым `git push`:** `git diff --cached`, проверка что в стейдже нет `.env`, ключей, sample-документов с реальными данными, отладочных принтов.
- **Секреты не в git и не в логах.** `.env` в `.gitignore` на всех уровнях; в репо — только `.env.example`.
- **Cloud-LLM (`claude`, `openai`) — для прод-данных запрещён.** На песочнице держим `BACKEND=stub` или `openai_compat` (локальная Ollama / vLLM). Cloud-ключи в env храним только если действительно нужны для отладки промптов на синтетике.
- **Действия с внешними последствиями — через confirm.** Webhook'и опциональны, через UI настраиваются явно. Никаких автоматических ответов / отправок без подтверждения оператора.

### 11.4. После приёмки (когда регламент v0.2+ войдёт)

По текущему черновику Памятки разворачивает DB Support, не автор. Тогда последовательность будет такая:

1. Автор связывается с DB Support **за ~2 недели** до планируемой подачи на ранний апрув.
2. Готовит локально (L1), доводит качество на golden-set'е (`npm run eval`).
3. Подаёт комплект: репо + README + `.env.example` + паспорт MVP + owner+зам + перечень секретов + резервный план + бюджет ресурсов.
4. DB Support разворачивает на корп. инфраструктуре, автор остаётся owner'ом.

### 11.5. Smoke после развёртывания

```bash
# С сервера
curl -i https://parsdocs.taipit.ru/health   # → 200 ok
curl -i https://parsdocs.taipit.ru/ready    # → 200 ready (postgres/redis/storage все живы)

# С токеном — operational metrics
curl -H "Authorization: Bearer $API_KEY" \
     https://parsdocs.taipit.ru/api/v1/metrics/operational?window=24h
```

Если `/ready` отдаёт 503 — смотри `error` в JSON. Чаще всего: postgres ещё не отмигрирован, redis недоступен, или storage volume не примонтирован.
