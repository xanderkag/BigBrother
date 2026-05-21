# ТЗ. Интеграция parsdocs с инстансом slai (OpenAI-compatible LLM backend)

> ⚠ **Не путать с ERP-интеграцией.** Этот документ — про parsdocs как
> **OpenAI-совместимый LLM-backend** (inference). Контракт интеграции parsdocs ↔
> SLAI **ERP** (webhook документов, авто-создание счетов, category-sync) описан
> отдельно: `SLAI/docs/specs/parsdocs-integration.md` (канон, перепроверен по коду).

> **Статус:** v0.1, draft.
> **Автор задачи:** Ляпустин А.Ю. (`klgaigpt3@gmail.com`).
> **Исполнитель:** AI-команда ТАЙПИТ.
> **Связанные документы:** [README.md](../README.md), [DEPLOY.md](../DEPLOY.md), [inference-service/MODELS.md](../inference-service/MODELS.md), [docs/TESTING_REGULATION.md](TESTING_REGULATION.md), [TECH_DEBT.md](../TECH_DEBT.md).

---

## 1. Цель и контекст

parsdocs использует LLM для классификации, vision-OCR и парсинга документов. Сейчас prod-конфигурация — `BACKEND=openai_compat` с локальным Ollama (`qwen2.5vl:7b`) рядом в Docker compose. Это работает, но:

- Ollama держит **одну модель за раз** в VRAM, нет встроенной маршрутизации/квот.
- Нет multi-tenant изоляции по моделям, нет учёта токенов, нет приоритезации очереди.
- При росте нагрузки и расширении парка моделей нужен полноценный **inference control-plane**.

Под это разворачиваем **slai** — отдельный self-hosted инстанс на корп. железе («биг бро на другом серваке»), который parsdocs будет потреблять как OpenAI-совместимый сервис.

### 1.1 Цели интеграции

1. parsdocs ходит в slai по OpenAI Chat Completions API (с vision), не меняя контракт `inference-service`.
2. Переключение между backend'ами (Ollama / slai / fallback) — конфигурацией, без правки кода.
3. Все артефакты прогонов фиксируют какой backend использован (в `audit_log` и `runs/<run_id>/`).
4. Правило ТАЙПИТ #5 не нарушается: slai self-host на корп. железе → real-prod-данные разрешены.

### 1.2 Не-цели

- Замена Ollama. Ollama остаётся как dev-fallback и low-touch инсталляция для пилотов.
- Перенос обучения / fine-tune моделей в slai (отдельное ТЗ).
- Интеграция с control-plane UI slai. Управление slai — на стороне slai-команды.

---

## 2. Глоссарий

| Термин | Значение |
| --- | --- |
| **slai** | Self-hosted инстанс LLM inference платформы, разворачиваемый на отдельном серве ТАЙПИТ. Контракт — OpenAI-compatible HTTP API (точную spec поставляет slai-команда, см. § 14). |
| **slai endpoint** | URL вида `https://slai.taipit.local:PORT/v1` (точный формат подтверждается на этапе развёртывания). |
| **slai access key** | Bearer-токен или эквивалент для аутентификации parsdocs в slai. |
| **inference-service** | Микросервис parsdocs на Python/FastAPI, абстрагирующий backend. См. `inference-service/`. |
| **backend** | Реализация `inference_service.backends.base.InferenceBackend`. Сейчас: `stub`, `openai_compat`, `qwen`, `claude`, `openai`. |
| **OCR-цепочка** | `pdf-parse → tesseract → vision-llm → yandex`. slai встаёт в звено `vision-llm`. |

---

## 3. Что трогаем, что не трогаем

### 3.1 Затрагивается

- `inference-service/src/inference_service/config.py` — пресет slai, при необходимости новые поля.
- `inference-service/src/inference_service/backends/openai_compatible.py` — расширения, **только если** у slai есть отличия от OpenAI 1:1.
- `inference-service/.env.example` — секция slai с комментариями.
- `inference-service/MODELS.md` — список моделей в slai, рекомендованных для каждого типа документа.
- `doc-service/src/routes/provider-settings.ts` — UI-управление выбором backend (опционально, если решаем переключать без рестарта).
- `docs/TESTING_REGULATION.md` — добавить колонку «backend» в snapshot окружения.
- `docs/test-runs/_TEMPLATE.md` — графа «backend».
- `scripts/network-test/lib.sh::snapshot_env` — фиксация активного backend и slai endpoint.
- Возможно — миграция `doc-service/migrations/00XX_provider_settings_slai.sql`, если в БД лежит каталог провайдеров.

### 3.2 Не затрагивается

- `doc-service/src/pipeline/*` — извлечение, классификация, валидация (доменная логика).
- Public API (`POST /api/v1/jobs`, `GET /jobs/:id`, webhooks) — контракт остаётся.
- Файловое хранилище, очередь BullMQ, retention-схема.

---

## 4. Функциональные требования

### FR-1. Конфигурация backend'а

- Активный backend выбирается через `BACKEND` env-var в `inference-service/.env`. Допустимые значения после интеграции:
  - `stub` — без изменений.
  - `openai_compat` — без изменений (Ollama, vLLM, LM Studio, **slai**, OpenAI cloud — всё через единый клиент при условии 1:1 совместимости).
  - `qwen` — без изменений.
  - `claude`, `openai` — без изменений (cloud, для dev).
  - *(опционально)* `slai` — отдельный backend, **только если** у slai есть несовместимости с OpenAI Chat Completions, которые нельзя закрыть конфигом.
- Конфигурация slai через env (минимум):
  - `OPENAI_BASE_URL=<slai-endpoint>/v1`
  - `OPENAI_MODEL=<model-id>` — slug модели в slai.
  - `OPENAI_API_KEY=<slai-token>`
  - *(если потребуется)* `OPENAI_EXTRA_HEADERS_JSON=` — JSON-объект кастомных headers (например, `{"X-Project-ID":"parsdocs"}`).
  - `OPENAI_TIMEOUT_SECONDS` — default 120, slai с холодным стартом может потребовать ≥ 180.

### FR-2. Контракт inference-service не меняется

`POST /v1/extract` и сопутствующие endpoints inference-service отдают тот же JSON (см. `inference-service/README.md`). slai прозрачен для doc-service.

### FR-3. Vision multimodal

slai обязан поддерживать messages с `content` массивом, включающим `{type: "image_url", image_url: {url: "data:image/png;base64,..."}}` (формат OpenAI). Если slai требует другой формат — закрываем правкой в `_build_user_message` в `openai_compatible.py` (см. § 7.2).

### FR-4. Health-check и discovery

- На старте `inference-service` (или per-request, lazy) проверяет доступность slai: `GET <base_url>/models` или эквивалент.
- При недоступности — fallback на следующий backend по приоритету (`BACKEND_FALLBACK_ORDER=slai,ollama,stub`, default — без fallback).
- Состояние slai отдаётся через `/v1/providers/status` (см. `inference-service/src/inference_service/routes/metrics.py`) с полями: `configured`, `reachable`, `last_check_ts`, `last_error`.

### FR-5. Multi-API-key (опционально)

doc-service уже умеет крутить несколько ключей (`API_KEYS_JSON`, см. коммит `a0d9b29`). Если slai выдаёт несколько токенов под разные приоритеты — задействуем существующий механизм.

### FR-6. Аудит и наблюдаемость

Каждая job-строка получает поле `inference_backend` (например `"slai/qwen2.5-vl-72b"`). Доступно через `GET /jobs/:id` и `/metrics/operational`. Реализация: расширить `jobs` (миграция) либо складывать в `metadata`.

### FR-7. Переключение через UI (опционально, P2)

В админ-странице Provider Settings — кнопка «Set active backend → slai», запись в `provider_settings` БД, hot-reload без рестарта контейнера. Если на P1 этого нет — переключаем через `.env` + рестарт.

---

## 5. Нефункциональные требования

| Категория | Требование |
| --- | --- |
| **Производительность** | E2E latency PDF (1 стр) при slai-backend ≤ baseline Ollama × 1.20. Throughput при `CONCURRENCY=4` ≥ baseline Ollama × 0.80. Уточняется после baseline-прогона по [docs/TESTING_REGULATION.md](TESTING_REGULATION.md). |
| **Доступность** | slai endpoint должен держать ≥ 99 % uptime в рабочее окно. При недоступности — fallback по FR-4 или явный `failed` job с понятным error message (без 5xx наружу клиенту). |
| **Безопасность** | (1) slai endpoint только во внутренней сети ТАЙПИТ, наружу не торчит. (2) Bearer-токен parsdocs к slai — в `.env`, не в коде, не в git, не в логах. (3) В payload к slai не уходят PII за пределами картинки/текста документа (нет user_id, tenant_id и пр. в `messages`). (4) Audit-log фиксирует hash запроса, не сам запрос. |
| **Совместимость** | Поддержка Python ≥ 3.11 (как у inference-service сейчас), OpenAI SDK ≥ 1.x. |
| **Логи** | Включить `httpx` debug-log в случае ошибки slai, при успехе — только status и latency. Никаких `messages` в logs. |
| **Соответствие правилам** | Правило ТАЙПИТ #5 (`README.md` § Безопасность): slai как self-host на корп. железе разрешён для прод-данных. Cloud-ускорители — запрещены без отдельного согласования. |

---

## 6. Архитектурное решение

```
doc-service  ──HTTP──▶  inference-service  ──HTTP──▶  slai/v1/chat/completions
   (BullMQ)               (FastAPI, Python)            (на отдельном серве)
                              │
                              └── /v1/providers/status ◀── healthcheck
```

- doc-service остаётся **единственной точкой входа** для клиентов.
- inference-service — backend-агностичный фасад; знание «куда ходить» — только тут.
- slai — внешняя зависимость, парсит наши OpenAI-like запросы, отдаёт completion'ы.

### 6.1 Развилка: один backend или два

Гипотеза по умолчанию: **slai = OpenAI 1:1, переиспользуем `openai_compat`** (минимальный объём правок).

Триггеры на отдельный `BACKEND=slai`:
1. slai обязательно требует свои HTTP-headers или auth-scheme не Bearer.
2. slai возвращает свой error envelope, который ломает retry в OpenAI SDK.
3. slai требует своих полей в `request body` (например, `tenant_id`, `priority`).
4. slai ожидает свой формат image input.

Если хотя бы один триггер сработает — оформляем `inference_service/backends/slai.py` по образцу `claude.py`.

---

## 7. Детальный план изменений

### 7.1 Конфигурация (`config.py`, `.env.example`)

- В `Settings` добавить опциональные:
  - `openai_extra_headers_json: str = ""` — JSON-строка, парсится в `dict[str,str]`.
  - `backend_fallback_order: str = ""` — CSV, default пусто.
- В `.env.example` секция slai с комментариями и примерами.
- В `inference-service/MODELS.md` — раздел «slai backend»: какие модели, минимальная VRAM, проверено на каких типах документов.

### 7.2 Backend (`openai_compatible.py`)

- В конструктор `httpx.Client` пробросить `headers=settings.parsed_extra_headers()`.
- Метод `_build_user_message`: если `OPENAI_IMAGE_FORMAT=base64_data_url` (default — как сейчас), используем `data:image/...;base64,...`. Если slai потребует `bytes` или URL — расширить enum.
- Retry-политика: ловить 429/503 от slai, exponential backoff, max 3 retry — выровнять с уже существующим `RATE_LIMIT_*` в doc-service.

### 7.3 Health и providers status

- В `inference_service/routes/metrics.py::providers_status` — поле `slai` (configured / reachable / last_error). Используется UI и алертами.
- Healthcheck — `GET <base_url>/models` с `Authorization: Bearer …`. Кэш на 30 секунд.

### 7.4 Audit и observability

- В `jobs` (doc-service) — поле `inference_backend TEXT NULL` (миграция `00XX_jobs_inference_backend.sql`).
- `worker.ts`: при отправке запроса в inference-service пишем `inference_backend = response.headers['X-Backend'] || configured`.
- `inference-service` отдаёт `X-Backend: slai/<model-id>` в response headers.

### 7.5 UI (опционально, P2)

- `doc-service/src/routes/provider-settings.ts`: POST `/provider-settings/active-backend` с body `{backend: "slai"|"ollama"|...}`. Запись в `provider_settings` (есть таблица — подтверждается миграцией).
- inference-service подписывается на изменение через webhook от doc-service либо polling каждые N секунд.

### 7.6 Тестирование (привязка к регламенту)

- В `scripts/network-test/lib.sh::snapshot_env` добавить строки `BACKEND=`, `OPENAI_BASE_URL=`, `OPENAI_MODEL=`.
- В `docs/test-runs/_TEMPLATE.md` — графа «Backend» в окружении.
- Smoke-прогон через slai — обязательный gate для приёмки этапа развёртывания.

---

## 8. Этапы и зависимости

| # | Этап | Зависит от | Срок (оценка) |
| --- | --- | --- | --- |
| E1 | Получение spec'а API slai от slai-команды (см. § 14) | — | блокирует всё ниже |
| E2 | Развёртывание slai на корп. серве, выдача endpoint + access key | E1 | внешний |
| E3 | Конфиг + пресет в `.env.example` + правка `config.py` | E1 | 2–4 ч |
| E4 | Smoke-прогон `run-smoke.sh` против slai | E2, E3 | 1 ч |
| E5 | При несовместимостях — отдельный backend `slai.py` | E4 | 4–8 ч |
| E6 | Audit-поле `inference_backend` + миграция | E3 | 2 ч |
| E7 | Provider-settings UI (P2) | E6 | 4–6 ч |
| E8 | Baseline load + soak через slai по регламенту | E4 | 4–8 ч на прогон |
| E9 | Документация: README + DEPLOY + MODELS.md | E4–E7 | 2 ч |

---

## 9. Acceptance-критерии

Приёмка интеграции считается выполненной, когда **все** пункты ниже зафиксированы артефактами в репо:

1. **AC-1.** В `inference-service/.env.example` есть рабочий пресет `slai` с комментариями, по которому DevOps может развернуть с нуля.
2. **AC-2.** `BACKEND=openai_compat` + slai endpoint → `inference-service` стартует, `/v1/providers/status` показывает slai как `reachable: true`.
3. **AC-3.** `scripts/network-test/run-smoke.sh` PASS на slai (5/5 job в `done` или `needs_review`).
4. **AC-4.** `scripts/network-test/run-load.sh` PASS по НФТ § 5: latency ≤ baseline × 1.20, throughput ≥ baseline × 0.80.
5. **AC-5.** В `GET /api/v1/jobs/:id` (или эквивалентном поле) виден активный backend, по которому обработан документ.
6. **AC-6.** В `docs/test-runs/` появилась запись baseline-прогона на slai по шаблону `_TEMPLATE.md`.
7. **AC-7.** В `README.md` § Безопасность slai упомянут как разрешённый prod-backend; в `DEPLOY.md` есть раздел «Подключение slai».
8. **AC-8.** В `audit_log` (или logs) для каждого extract-вызова фиксируется backend без сырых `messages`. Sanity: `grep "base64" logs/` за час прогона → 0 совпадений.

---

## 10. Открытые вопросы (для slai-команды)

Перед началом E3 нужно получить от slai-стороны:

1. **Точный URL** инстанса (схема, хост, порт, путь до `/v1`).
2. **Auth-scheme** — Bearer? mTLS? api-key в header? Что выдаётся на каждого потребителя.
3. **Endpoints**: `/v1/chat/completions`, `/v1/models`, `/v1/embeddings` — какие реализованы, какие нет.
4. **Multimodal**: поддержка `image_url` в формате OpenAI? Если нет — какой формат принимает (binary upload, signed URL, base64 в отдельном поле)?
5. **Max tokens / context window** на доступных моделях.
6. **Rate limits**: токены/мин, запросы/мин, конкурентность — на наш токен.
7. **Streaming**: поддерживается ли `stream: true`? (Нам не критично, но влияет на retry.)
8. **Error envelope**: формат тела ошибок (OpenAI стиль `{error:{message,type,code}}` или свой?).
9. **Список моделей** в slai, рекомендованных под наш сценарий (vision-VL ru, 7B–72B).
10. **SLA / окно обслуживания**: когда планируются перезапуски, какой ретеншн логов запросов на стороне slai.

Ответы фиксируются прямо в этом ТЗ в § 14 (см. ниже) перед стартом E3.

---

## 11. Риски

| ID | Риск | Митигация |
| --- | --- | --- |
| R-1 | slai окажется не 1:1 OpenAI-compat — придётся писать отдельный backend | Этап E5 в плане учтён. Лимит trade-off — если правок > 200 LOC, обсуждаем с slai-командой стандарт совместимости. |
| R-2 | slai vision не принимает наш формат картинок | E4 smoke ловит это сразу; запас в E5. |
| R-3 | Latency slai существенно хуже Ollama (≥ ×1.5) | Baseline + load до раскатки; при провале — не катим, остаёмся на Ollama, открываем тикет в slai-команду. |
| R-4 | slai периодически недоступен (рестарты, миграции) | FR-4 fallback + алерт по `providers_status.reachable=false` ≥ 5 мин. |
| R-5 | Утечка токена slai через логи / ENV | Token только в `.env` (не в git, см. `.gitignore`), `httpx` логи фильтруют `Authorization` header. |
| R-6 | slai требует своих полей tenancy → наши `extract`-запросы валятся | Контракт уточняется в § 14, прокидываем через `OPENAI_EXTRA_HEADERS_JSON` или новый backend. |

---

## 12. Откатной план

Если интеграция оказывается нестабильной в проде:

1. В `inference-service/.env` поменять `OPENAI_BASE_URL` обратно на Ollama (`http://ollama:11434/v1`), `OPENAI_MODEL=qwen2.5vl:7b`.
2. `docker compose restart inference` — занимает < 30 секунд.
3. doc-service ничего не замечает (контракт inference-service неизменен).
4. Журналируем инцидент в `TECH_DEBT.md`, отчёт baseline-прогона на slai остаётся как референс.

Code-rollback не требуется, изменения backend-агностичны.

---

## 13. Влияние на регламент тестирования

После E3 в [docs/TESTING_REGULATION.md](TESTING_REGULATION.md) добавляются:

- В § 2 «Окружение» — строка `BACKEND` и `slai endpoint` (без токена).
- В § 4 «Метрики» — `inference_backend` как dimension при выгрузке.
- В § 3.2 Load — отдельный прогон на slai после смены backend → референс-сравнение Ollama vs slai.

Это будет PR'ом одновременно с финализацией интеграции (этап E9).

---

## 14. Spec slai (заполнить после ответа slai-команды)

> Пока пусто. Поля помечены `TBD`. Без их заполнения этап E3 не стартует.

- Endpoint URL: `TBD`
- Auth scheme: `TBD`
- Реализованные endpoints: `TBD`
- Формат vision/image: `TBD`
- Доступные модели и context windows: `TBD`
- Rate limits на наш токен: `TBD`
- Error envelope: `TBD`
- SLA / окно обслуживания: `TBD`
- Контакт slai-команды: `TBD`

---

## 15. История документа

| Версия | Дата | Изменения |
| --- | --- | --- |
| 0.1 | TBD | Первоначальный draft. Числа НФТ и spec slai — заглушки до этапа развёртывания. |
