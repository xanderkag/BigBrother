# Runtime-топология parsdocs: где что реально крутится

> **Зачем этот документ.** 2026-07-21 автор трижды подряд ошибся, отвечая «где
> работает vision / extraction», потому что **судил по имени модели и по
> env-конфигу, а не по реальному трафику**. Всё ниже — сведено из адверсариальной
> верификации по факту (live `curl`/DB/probe/чтение исходников), а не по памяти.
> Если сомневаешься — не гадай, а прогони рецепты из раздела «Как проверять».
>
> **Обновлять этот файл только фактами** (curl/probe/чтение конфига). Дата сверки: 2026-07-21.

---

## TL;DR (то, на чём легко ошибиться)

- **Extraction (текст), classify, verify → vLLM `10.10.33.10:8100`** (`qwen36-vllm`).
- **Vision-OCR (сканы/фото) → vLLM `10.10.33.10:8101`** (`qwen3-vl-32b`). **Не Ollama.**
- **Ассистент SLAI (tool-calling) → vLLM `10.10.33.10:8100`** (через наш шлюз, per-alias).
- **Ollama `10.10.33.10:11434` НЕ обслуживает extraction/vision.** Только gateway-chat алиасы (`parsdocs-chat`, `parsdocs-large`) + неиспользуемая fallback-строка.
- **Имя модели в конфиге ≠ адрес бэкенда.** Маршрут задаёт `upstream_base_url`/порт, а не строка `model`.
- **`jobs.(finished_at − started_at)` — НЕ латентность** (загрязнено застрявшими джобами; средние выходят «часы/сутки»). Мерить только прямым timed-вызовом эндпоинта.

---

## 1. GPU-бокс и бэкенды (проверено live-probe)

GPU-бокс **`10.10.33.10`** (Blackwell 96 ГБ). Доступ с прод-хоста `kb-docker` только по `curl`. vLLM **0.24.0**, оба vLLM-инстанса — веса NVFP4, сосуществуют с Ollama на одной карте.

| Бэкенд | Адрес | Модель (id / root) | Что обслуживает у parsdocs | Замер (факт) |
|---|---|---|---|---|
| **vLLM :8100** | `10.10.33.10:8100/v1` | `qwen36-vllm` (`qwen36-nvfp4`), max_len 32768, gpu_util≈0.35, prefix-cache **off** | **Extraction / classify / verify** (текст) + **assistant tool-calling** | tool-call smoke OK; латентность текста таймером ещё не мерена |
| **vLLM :8101** | `10.10.33.10:8101/v1` | `qwen3-vl-32b` (`qwen3vl-32b-nvfp4`), max_len 16384, prefix-cache **on**, ~1 параллельный vision | **Vision-OCR + hybrid-vision** | реальный скан 1.24 МБ: **~19–21с** (cap 1024) … до **149с** (uncapped, 17k симв). Декод ~40–52 ток/с — **латентность = число выходных токенов, не хоп** |
| **Ollama :11434** | `10.10.33.10:11434` | 22 тега (`qwen3-vl:32b`, `qwen3.6:27b`, `qwen2.5:72b`, `phi4`, `bge-m3`…) | **НЕ extraction/vision.** Только gateway-chat (`parsdocs-chat→qwen3-vl:32b`, `parsdocs-large→qwen2.5:72b`) + неиспользуемая `local-qwen36-ollama-fallback` | тёплый `/api/generate` 5.34с — это liveness, **не** метрика |

**Контейнеры на прод-хосте `10.10.13.10`:** `parsdocs-api-1` (:8085, **тут живёт LLM-gateway**), `parsdocs-worker-1` (обработка джобов), `parsdocs-inference-1` (:8000), `parsdocs-ollama`, `parsdocs-postgres-1`, `parsdocs-redis-1`.

---

## 2. Как маршрутизируется вызов модели (per-request override)

**Ключ: маршрут задаёт НЕ имя модели, а `upstream_base_url` (порт), который doc-service кладёт в тело каждого запроса.**

Путь: `worker` → `http://inference:8000/v1/{extract|vision-ocr|classify|verify}` → inference-service → реальный GPU-бэкенд.

- doc-service **всегда инжектит override в тело** каждого запроса: `withModel()` (`src/pipeline/llm/http-client.ts:93-110`) кладёт `model`, `backend`, `base_url` (= `extra.upstream_base_url` из строки `provider_settings`), `api_key`.
- inference-service **honor'ит per-request override**: `resolve_backend(body.backend, body.base_url, …)` + `effective_model = model_override or self.model_id` (`inference-service/.../backends/openai_compatible.py:483`, `deps.py:7-20,115-129`). Бэкенд кэшируется по `(kind, base_url, api_key)`; `model` — **не** в ключе (применяется per-call).
- **env inference-service — мёртвый fallback.** `OPENAI_BASE_URL=http://10.10.33.10:11434/v1`, `OPENAI_MODEL=qwen3-vl:32b` срабатывают ТОЛЬКО на голом вызове без override (в проде такого нет). Probe подтверждает: `11434/v1/models` даже **не листит** `qwen36-vllm`/`qwen3-vl-32b` — если бы env-дефолт использовался, роутинг бы падал в 500/Ollama-404.

### Карта: функция → провайдер → реальный бэкенд (live prod DB + probe)

| Функция | Провайдер (`provider_settings.id` / `model`) | `body.base_url` (из `extra.upstream_base_url`) | Реальный бэкенд (probe `/v1/models`) |
|---|---|---|---|
| **Extraction / classify / verify** | `local-qwen3-6-27b` / `qwen36-vllm` (is_default) | `http://10.10.33.10:8100/v1` | **vLLM 8100** ✅ `qwen36-vllm` |
| **Vision-OCR / hybrid** | `local-qwen3-vl-32b` / `qwen3-vl-32b` (vision=true) | `http://10.10.33.10:8101/v1` | **vLLM 8101** ✅ `qwen3-vl-32b` |
| **Assistant-chat (SLAI)** | шлюз-alias `parsdocs-assistant` → `qwen36-vllm` | upstream `…:8100/v1` (минуя inference) | **vLLM 8100** |
| Прочий chat через шлюз | alias `parsdocs-chat`(деф.)→`qwen3-vl:32b`; `parsdocs-large`→`qwen2.5:72b` | `LLM_GATEWAY_BASE_URL` = `…:11434/v1` | **Ollama 11434** |
| Embeddings | — | — | **Выключено** (`LLM_GATEWAY_EMBEDDINGS_ENABLED` не задан → `/v1/embeddings`=503) |

Vision выбирается **детерминированно по env** `OCR_VISION_PROVIDER_ID=local-qwen3-vl-32b` (не по alphabetical `display_name` — иначе победил бы `Mistral Small 3.1`). Все `provider_settings.base_url=http://inference:8000`; настоящий GPU-upstream едет **в теле** как `base_url`.

> **Не путать два разных пути:** extract-пайплайн (`LLM_INFERENCE_URL=http://inference:8000` → HttpLlmClient) и LLM-gateway (`/v1/chat/completions`, `LLM_GATEWAY_BASE_URL`) — **разные вещи**. Gateway обслуживает чат/DaData/embeddings для внешних клиентов (SLAI), extract-пайплайн — разбор документов.

---

## 3. ГЛАВНАЯ ЛОВУШКА: имя модели ≠ реальный бэкенд

`provider_settings.model` (`qwen36-vllm`, `qwen3-vl-32b`, `phi4`, `qwen2.5:72b`) — **просто тег в теле запроса, он НЕ определяет маршрут.** Маршрут задаёт только **`extra.upstream_base_url` / порт**:

```
8100 = vLLM extraction   ·   8101 = vLLM vision   ·   11434 = Ollama (gateway-chat / fallback)
```

**Особо коварно:** у vLLM 8101 модель зовётся `qwen3-vl-32b` (дефис), а в Ollama 11434 есть почти одноимённый тег `qwen3-vl:32b` (двоеточие) — **это разные бэкенды**. Различить можно ТОЛЬКО по порту/`upstream_base_url`, не по строке модели.

### Как проверять правильно (рецепты — используй их вместо догадок)

1. **Читать конфиг маршрутизации, а не имя.** Источник истины — `provider_settings.extra.upstream_base_url` (что doc-service отправляет), а не `provider_settings.model`.
   ```bash
   PW=$(ssh kb-docker "docker exec parsdocs-worker-1 printenv DATABASE_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
   ssh kb-docker "docker exec -e PGPASSWORD='$PW' parsdocs-postgres-1 psql -U docservice -d docservice -t -A -c \"SELECT id, model, is_default, vision, extra->>'upstream_base_url' FROM provider_settings WHERE is_active AND kind='llm'\""
   ```
2. **`curl /v1/models` на подозреваемый порт** — сверить `id` и `root`-путь весов:
   ```bash
   ssh kb-docker "curl -s -m6 http://10.10.33.10:8100/v1/models"   # ждём qwen36-vllm / qwen36-nvfp4
   ssh kb-docker "curl -s -m6 http://10.10.33.10:8101/v1/models"   # ждём qwen3-vl-32b / qwen3vl-32b-nvfp4
   ```
3. **Timed прямой вызов эндпоинта** — единственный честный замер латентности (см. §4):
   ```bash
   ssh kb-docker "curl -s -m60 -o /dev/null -w 'http=%{http_code} total=%{time_total}s\n' http://10.10.33.10:8101/v1/chat/completions -H 'content-type: application/json' -d '{...image_url…}'"
   ```
4. **НЕ** по имени модели, **НЕ** по памяти/предположению, **НЕ** по `avg(jobs.duration)`.

---

## 4. Ловушка данных: `jobs.(finished_at − started_at)` ≠ латентность

**Механизм (корень, `src/storage/jobs.ts:450`):**
```sql
UPDATE jobs SET status='processing', started_at = COALESCE(started_at, now()) WHERE id=$1
```
`started_at` пишется **один раз** на первой попытке и **никогда не сбрасывается** при re-enqueue / reclaim / ретрае; `finished_at` — на финальном finalize. Дельта включает **всё wall-clock**: время в pending, застревание до reclaim (≥15 мин/цикл), все `attempts:3`.

**Доказательство (2288 джоб, прод) — физически невозможные средние:**

| ocr_engine | n | avg | max | min (истинный быстрый путь) |
|---|---|---|---|---|
| pdf-text | 872 | ≈15.0 ч | ≈41.9 дн | 2.7с |
| tesseract | 797 | ≈14.1 ч | ≈46.1 дн | 3.3с |
| vision-llm | 407 | ≈6.1 ч | ≈27.6 дн | 3.1с |
| xlsx | 179 | ≈44.5 ч | ≈43.8 дн | 0.0с |

Даже перцентили загрязнены: `p50=58.5с`, `p90≈45 мин`, `p99≈35 дн`. `324/2288 (14%)` джоб имеют дельту >15 мин (сигнатура застревания). Дополнительный загрязнитель: строки `ocr_engine=NULL` при `finished_at IS NOT NULL` (reclaim'нутые). Только `min` близок к правде — но это нижняя граница, не метрика.

**Цена ошибки:** прямой timed vision-вызов ~5–21с против «avg 6 ч» по `jobs` — расхождение на 3+ порядка. Именно на этих «часах» автор построил ложный вывод «vision медленный, нужна миграция». Vision уже на vLLM 8101 и не медленный.

**Как мерить правильно:** зафиксировать документ/картинку, warm-up, несколько прогонов прямо на эндпоинт, взять медиану. НЕ агрегировать `jobs`.

---

## 5. Assistant tool-calling (путь через шлюз)

- SLAI-ассистент → alias **`parsdocs-assistant`** → `clientForUpstream()` идёт **напрямую в vLLM 8100, минуя inference-service** (`src/routes/llm-gateway.ts:173-180`).
- Конфиг задеплоен на `parsdocs-api-1` (`735feee`): `LLM_GATEWAY_MODELS_JSON` содержит `"parsdocs-assistant":{"model":"qwen36-vllm","upstream":"http://10.10.33.10:8100/v1"}`.
- Шлюз — прозрачный passthrough: `tools`/`tool_choice`/`chat_template_kwargs` пробрасываются verbatim, `tool_calls` возвращаются как есть; стрипается только `stream`, подменяется `model` (alias→backend-tag).
- Парсер tool-calls на vLLM 8100 — **`qwen3_xml`** (не `hermes`; Qwen 3.6 отдаёт вызовы в XML). Смоук на бэкенде: `finish_reason:tool_calls`, корректный вызов. **End-to-end смоук со стороны SLAI (23 tools, мультитёрн) — отдельный шаг, ждёт joint-smoke.**

---

## 6. Известные env-рассинхроны (безвредны, поправить при redeploy)

- `parsdocs-worker-1` несёт **старый** `LLM_GATEWAY_MODELS_JSON` без `parsdocs-assistant` — не влияет (gateway-роут живёт в `parsdocs-api-1`, воркер его не обслуживает).
- `.env.example` показывает `WORKER_CONCURRENCY=1`, факт на проде — `2`.

---

## Ключевые файлы (источники истины кода)

- `src/pipeline/llm/http-client.ts` (`withModel` инжектит model/backend/base_url/api_key), `provider-resolver.ts` (resolve/vision-pin/readBackendOverride).
- `src/routes/llm-gateway.ts` (per-alias upstream), `src/config.ts` (models `{model,upstream?}`, `ocrVisionProviderId`).
- `inference-service/src/inference_service/{deps.py, backends/openai_compatible.py:483, routes/*.py, schemas.py}` — **`inference-service/` — сосед `doc-service/` в монорепо `Big Brother/`, не подпапка** (путь от корня монорепо, из doc-service — `../inference-service/…`).
- `src/storage/jobs.ts:450` (корень ловушки латентности), `src/queue.ts`, `src/worker.ts`, `src/workers/pending-job-sweeper.ts`.
