# Локальные модели для parsdocs

Это операционная памятка: какие открытые VLM/LLM подключать к
parsdocs, что они умеют и сколько ресурсов хотят. Архитектура
сервиса нейтральна по модели — добавление новой = только смена
двух строк в `.env` (model + base_url), без правок кода.

## Архитектура подключения

```
                                  ┌──────────────────────────────────┐
                                  │      Inference сервер            │
   doc-service ──/v1/extract──► inference-service ──OpenAI API──►  (Ollama / vLLM /
              ──/v1/vision-ocr──►   backend=openai_compat        ──►  llama.cpp / LM Studio)
                                  └──────────────────────────────────┘
```

Один наш backend (`openai_compatible.py`) разговаривает на OpenAI Chat
Completions API. Под ним может стоять любой из популярных серверов —
выбирается по `OPENAI_BASE_URL` в env.

## Сравнение моделей под наши задачи

Задачи parsdocs три:

1. **classify** — текстовая классификация русского документа в один
   из ~10 типов.
2. **extract** — структурированное извлечение по JSON Schema.
   Параметризованный prompt с примерами полей.
3. **vision-ocr** — VLM-OCR на изображении/PDF-странице, fallback
   когда tesseract дал низкую confidence.

| Модель | Тип | VRAM (fp16) | VRAM (q4) | RU classify | RU extract | Vision | Лицензия | Комментарий |
|---|---|---:|---:|---|---|---|---|---|
| **Qwen2.5-VL-7B** | VLM | ~14 GB | ~5 GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Apache 2.0 | Базовый рекомендуемый. Хорошее качество русского. |
| **Qwen2.5-VL-3B** | VLM | ~6 GB | ~3 GB | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | Apache 2.0 | Минимальный VLM, для лёгкого железа. |
| **Llama 3.2-Vision 11B** | VLM | ~22 GB | ~7 GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | Llama Comm. | Сильна на табличных документах. |
| **MiniCPM-V 2.6 (8B)** | VLM | ~16 GB | ~6 GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Apache 2.0 | Лучше Qwen 7B по vision-OCR; компактнее. |
| **InternVL3-8B** | VLM | ~16 GB | ~6 GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | MIT | Хороша на длинных табличных документах. |
| **Granite-Vision 3.2 2B** | VLM | ~5 GB | ~2 GB | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | Apache 2.0 | Дешёвая, IBM-tuned под бизнес-доки. |
| **Gemma 3 4B / 12B** | LLM | ~8/24 GB | ~3/8 GB | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | — | Gemma | Text-only; для classify/extract без OCR-картинок. |
| **Qwen3 8B** | LLM | ~16 GB | ~6 GB | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | — | Apache 2.0 | Text-only, но топ по русскому. |
| **Saiga / Vikhr 7-8B** | LLM | ~14 GB | ~5 GB | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | — | Apache 2.0 | Русский fine-tune. Только text. |

⭐⭐⭐⭐⭐ — субъективная экспертная оценка по нашему типу документов
(российские транспортные и бухгалтерские). Реальное качество всегда
надо мерить на своих данных через `tests/golden/` (см. TECH_DEBT).

## Рекомендации по сценариям

### Dev-стенд (одна машина, без GPU)
- **Сервер:** Ollama.
- **Модель:** `qwen2.5vl:7b` (или `qwen2.5vl:3b` если 5+ GB VRAM/RAM маловато).
- **Запуск:** `docker compose -f docker-compose.doc-platform.yml -f docker-compose.local-models.yml up -d`
- **Скорость:** ~5-15 секунд на extract на macOS Metal, ~30s на CPU-only.

### Production GPU (1× A100/H100, 24-80 GB VRAM)
- **Сервер:** vLLM (заявленный throughput x3-5 над transformers).
- **Модель:** `Qwen/Qwen2.5-VL-7B-Instruct` или MiniCPM-V 2.6.
- **Преимущество:** continuous batching, prefix caching — выдерживает
  ~100 параллельных запросов на 7B модели.

### Air-gapped (без интернета, минимальное железо)
- **Сервер:** llama.cpp с моделью в GGUF Q4_K_M.
- **Модель:** `qwen2.5-vl-7b-instruct-q4_k_m.gguf` (~5 GB).
- **Сценарий:** ноутбук без сети, один экземпляр для разовых документов.

### «Хочу самое быстрое и дешёвое»
- **Сервер:** Ollama.
- **Модель:** Granite-Vision 3.2 2B (~2 GB Q4) — для классификации и
  лёгкого extract'а; **Tesseract** для основного OCR-фазы.
- Cтоимость на parsdocs: только электричество, лицензия Apache.

## Как поменять модель — пошагово

1. Если Ollama: `docker compose exec ollama ollama pull <new-model:tag>`
2. В `inference-service/.env`:
   ```env
   BACKEND=openai_compat
   OPENAI_BASE_URL=http://ollama:11434/v1
   OPENAI_MODEL=<new-model:tag>
   ```
3. `docker compose restart inference`
4. Проверь: `GET http://localhost:8000/v1/providers/status`
   → `available.openai_compat.configured=true`, `active="openai_compat"`.

## Что **не делать**

- ❌ Не запускайте `backend=qwen` (transformers напрямую) на проде —
  это однопоточный код, нет batching, cold start 30-90 сек. Тот же
  Qwen через vLLM в 5-10 раз быстрее.
- ❌ Не используйте text-only LLM (Qwen3, Gemma 3) для `vision-ocr` —
  упадёт, потому что модель не принимает image input. classify/extract
  по уже отOCR-енному тексту — пожалуйста.
- ❌ Не ставьте `temperature>0` для extract'а — детерминированность
  важна для воспроизводимости (наш код уже шлёт `temperature=0`).
- ❌ Не сравнивайте качество на двух документах. Соберите 50-100 в
  `tests/golden/` со reference JSON и считайте accuracy field-wise.

## TODO / следующий этап

- [ ] **vLLM compose-профиль** (`docker-compose.vllm.yml`).
- [ ] **Golden-set + benchmark** (TECH_DEBT, тестовая выборка).
- [ ] **Per-job выбор провайдера** — через `provider_settings` из
      doc-service пробрасывать `X-Provider-Id` в /v1/extract и
      инстанциировать backend on-demand.
- [ ] **Fine-tune Qwen2.5-VL 7B** на закрытом золотом сете
      transparent-доков — оценка прироста точности vs стоимость
      обучения.
