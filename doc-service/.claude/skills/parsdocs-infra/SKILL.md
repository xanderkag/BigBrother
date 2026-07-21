---
name: parsdocs-infra
description: "parsdocs/doc-service runtime infra — INVOKE FIRST before answering any 'which backend / vLLM or Ollama / where does vision|extraction|classify|verify|embeddings run / is the assistant tool-calling on vLLM / what backs the gateway chat aliases / why is it slow / how long does processing take / tokens per second / what GPU port / RAG or bge / per-document cost' question. Answers by FACT via live checks (curl /v1/models, provider_settings, timed probe) and the local knowledge graph, instead of guessing from model names, env, or jobs-duration — which has repeatedly produced wrong answers."
---

# /parsdocs-infra — где что реально крутится (по факту, не по догадке)

**Когда вызывать.** Любой вопрос про инфраструктуру parsdocs: на каком бэкенде
работает vision / extraction / classify / verify; vLLM или Ollama; какой порт;
почему медленно; сколько занимает обработка; куда идёт tool-calling ассистента.

**Зачем скилл существует.** Эти вопросы уже трижды получали неверный ответ,
потому что отвечали по имени модели / по env inference-service / по длительности
джоб. Все три — ложные сигналы (см. «Ловушки»). Этот скилл заставляет ответить
по факту.

---

## Проверенная топология (сверено live-probe 2026-07-21, повторяемо командами ниже)

| Порт на 10.10.33.10 | Бэкенд | id модели | Что обслуживает |
|---|---|---|---|
| **8100** | vLLM | `qwen36-vllm` | extraction · classify · verify · assistant tool-calling |
| **8101** | vLLM | `qwen3-vl-32b` | vision-OCR (сканы/фото) |
| **11434** | Ollama | 22 нативных тега | только gateway-chat; **НЕ** extraction/vision |

Маршрут вызова задаёт `provider_settings.extra.upstream_base_url` (порт), который
doc-service кладёт в тело каждого запроса — **не** строка `model`.

**Ещё два факта (частые вопросы):**
- **Embeddings — ВЫКЛЮЧЕНЫ.** `/v1/embeddings` шлюза → 503 (`LLM_GATEWAY_EMBEDDINGS_ENABLED`
  не задан). Тег `bge-m3` висит в Ollama, но **не используется** — не путать наличие
  тега с работающим сервисом (классический decoy «по имени модели»).
- **Gateway-chat алиасы** (для внешних клиентов, не extract-пайплайн): `parsdocs-chat`
  (деф.) → `qwen3-vl:32b` на Ollama; `parsdocs-large` → `qwen2.5:72b` на Ollama;
  `parsdocs-assistant` → `qwen36-vllm` на vLLM **8100** (tool-calling, минуя inference-service).

---

## Ловушки — почему догадка врёт (не повторять)

1. **Имя модели ≠ бэкенд.** `qwen3-vl-32b` (дефис) на vLLM 8101 ≠ `qwen3-vl:32b`
   (двоеточие) в Ollama 11434 — это РАЗНЫЕ бэкенды. Различать только по порту/upstream.
2. **`OPENAI_BASE_URL=…:11434` в inference-service — мёртвый fallback.** Живёт в env
   контейнера, но НИКОГДА не используется: doc-service инжектит `base_url`/`model`
   per-request. Не делать вывод «работает на Ollama» из этого env.
3. **`jobs.(finished_at − started_at)` — НЕ латентность.** `started_at` пишется один
   раз (`src/storage/jobs.ts`), не сбрасывается при retry/reclaim → средние = «часы/сутки».
   Латентность мерить только прямым timed-`curl` (рецепт F ниже).
4. **Vision-строк в `provider_settings` две** (`local-qwen3-vl-32b` и `local-mistral-small-31`).
   Реальный vision-провайдер пинится env `OCR_VISION_PROVIDER_ID=local-qwen3-vl-32b`,
   а не «первой vision=true строкой». Только у qwen3-vl-32b выставлен upstream :8101.

---

## Рецепты проверки (все проверены — copy-paste, read-only, безопасно)

SSH-алиас `kb-docker` = прод-хост 10.10.13.10. GPU-бокс 10.10.33.10 доступен только
`curl`'ом с kb-docker. Контейнеры: `parsdocs-{api,worker,inference,postgres,redis}-1`
+ `parsdocs-ollama` (без `-1`). Если имя не совпало — `ssh kb-docker "docker ps --format '{{.Names}}'"`.

**A. Источник истины — маршрутизация (что doc-service реально шлёт):**
```bash
PW=$(ssh kb-docker "docker exec parsdocs-worker-1 printenv DATABASE_URL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
ssh kb-docker "docker exec -e PGPASSWORD='$PW' parsdocs-postgres-1 psql -U docservice -d docservice -t -A -c \"SELECT id, model, is_default, vision, extra->>'upstream_base_url' FROM provider_settings WHERE is_active AND kind='llm'\""
```
Ждём: default/extraction (`is_default=t, vision=f`) → `…:8100/v1`; vision (`vision=t`,
провайдер `local-qwen3-vl-32b`) → `…:8101/v1`; `local-qwen36-ollama-fallback` → `…:11434/v1` (НЕ default).

**B–D. Что реально слушает каждый порт (сверить id модели):**
```bash
ssh kb-docker "curl -s -m6 http://10.10.33.10:8100/v1/models"    # → id qwen36-vllm  (extraction)
ssh kb-docker "curl -s -m6 http://10.10.33.10:8101/v1/models"    # → id qwen3-vl-32b (vision)
ssh kb-docker "curl -s -m6 http://10.10.33.10:11434/v1/models"   # → Ollama-теги; НИ qwen36-vllm НИ qwen3-vl-32b
```

**E. Доказать, что env-fallback мёртв (для объяснения, а не для вывода о бэкенде):**
```bash
ssh kb-docker "docker exec parsdocs-inference-1 printenv OPENAI_BASE_URL OPENAI_MODEL"
# → http://10.10.33.10:11434/v1  /  qwen3-vl:32b  — это fallback, doc-service его перебивает per-request
```

**F. Настоящий замер латентности (единственный честный способ):**
```bash
ssh kb-docker "curl -s -m8 -o /dev/null -w 'http=%{http_code} total=%{time_total}s\n' http://10.10.33.10:8101/v1/models"
# для реального vision-замера — POST /v1/chat/completions с image_url (base64) на :8101, тот же -w формат.
# НЕ agg-ировать jobs.(finished−started) — это мусор (ловушка 3).
```

---

## Граф знаний (быстрый указатель; локально, без внешних LLM)

Запрос — **чистый локальный обход** `graphify-out/graph.json` (NetworkX BFS, 0 сети,
безопасно для коммерческих доков; проверено в graphify 0.8.40). Из папки doc-service:
```bash
graphify query "vision OCR backend port qwen3-vl vLLM"
graphify query "text extraction classify verify backend vLLM qwen36"
graphify query "why jobs finished_at started_at not latency"
```
**Важно про фразировку:** давай запросу *топологический словарь* (порт/vLLM/qwen/backend),
а не обычный английский — иначе BFS садится на узлы кода (`vision-llm.ts`,
`ExtractionCatalog.tsx`) и не дотягивается до узла топологии за бюджет обхода.
Узлы фактов: `docs_runtime_topology_*`, `docs_operations_runbook_*`.

---

## Как отвечать

1. Если вопрос про **бэкенд/маршрут** → рецепт A (+ B/C/D для подтверждения id). Ответ =
   что вернули команды, не что «логично».
2. Если про **латентность/«медленно»** → рецепт F (прямой timed-вызов). Никогда не
   ссылаться на средние из `jobs`.
3. Если нужен **быстрый указатель без SSH** → граф (топологическим словарём) или
   [`docs/RUNTIME_TOPOLOGY.md`](../../../docs/RUNTIME_TOPOLOGY.md) / [`docs/OPERATIONS_RUNBOOK.md`](../../../docs/OPERATIONS_RUNBOOK.md).
4. Всегда предпочитать факт догадке. Ответить по памяти, не сверившись, — регресс.
