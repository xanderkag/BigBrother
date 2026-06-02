# Bench v3 — большие модели на 96 ГБ VRAM

**Дата:** 2026-06-01
**Повод:** появился сервер с **96 ГБ видеопамяти**. До сих пор потолок был
~20 ГБ (RTX 4000 Ada на `.28.10`), и Phi-4 14B стала production-дефолтом не
потому что лучшая, а потому что **влезала**. Лучшая арифметика `total` у неё —
60% (bench v2, прогон #17). Бизнес-цель (STATUS Tier 3) — **≥85% по полям**.

Bench v3 ищет модель, которая бьёт 60% Phi-4 и подбирается к 85%, теперь без
ограничения по VRAM.

## Гипотезы, которые проверяем

1. **Размер решает.** 70–72B-класс рассуждает и считает суммы принципиально
   лучше 14B. Ожидаем скачок `total`-arithmetic.
2. **Квантизация шумит на арифметике.** Часть провалов `total` у нас — это
   Q4-округление, а не «модель не умеет». Проверяем A/B: одна модель в Q4 vs
   Q8 vs fp16 на одних фикстурах.
3. **Длинный контекст убирает костыль multipass.** 70B+ имеют 128k контекста →
   документ >20k символов влезает в один проход (закрывает известный баг
   «single-shot падает на длинных текстах»).

## Инструмент

`doc-service/scripts/text-bench-real.py` — текстовый аналог `vision-bench-real.py`:
текстовый слой PDF (pymupdf) / DOCX → Ollama `/api/generate` (`format:json`) →
скоринг тем же компаратором, что и `src/scripts/eval/compare.ts`
(деньги ±0.01, дата ISO-нормализация, ИНН — только цифры) против
`eval/real/golden-set.v1.json`. **Все 9 фикстур** (vision пропускал 3 DOCX —
текстовым моделям картинка не нужна).

Запускается с рабочей Windows-машины, ходит на remote Ollama по HTTP.
Golden-набор и samples лежат локально (gitignored — содержат PII + ожидаемые
значения).

### Почему текстовый слой, а не Tesseract OCR

Для **отбора модели** нужен честный замер чистого навыка извлечения на
идентичном входе — OCR-шум здесь мешает. Production OCR делает; для шорт-листа
победителей второй проход с OCR-текстом через `--text-dir` подтвердит
устойчивость к OCR-шуму.

## Кандидаты и VRAM-бюджет (96 ГБ)

| Модель | Quant | ~VRAM | Зачем |
|---|---|---|---|
| **Llama 3.3 70B Instruct** | Q4_K_M | ~43 ГБ | сильное рассуждение/арифметика, приличный русский |
| **Qwen2.5 72B Instruct** | Q4_K_M | ~47 ГБ | сильный мультиязык вкл. русский, таблицы |
| **Qwen3 32B** | Q8 | ~35 ГБ | новее, reasoning-режим |
| **Gemma 3 27B** | Q8 | ~29 ГБ | ретест на бóльшей точности, чем Q4 в bench v2 |
| **Mistral Small 3.1 24B** | Q8 | ~25 ГБ | быстрый средний класс |
| **T-Pro-it 32B** (T-Bank) | Q4 | ~20 ГБ | русско-специализированная, может выиграть на RU |
| **Phi-4 14B** (baseline) | Q4 | ~9 ГБ | инкумбент — обязателен для apples-to-apples |
| **Qwen2.5 32B** | Q4 / Q8 / fp16 | 20/35/64 ГБ | A/B по квантизации (гипотеза 2) |

fp16 70B (~140 ГБ) **не влезает** — пропускаем. Для router'а (Tier 2)
проверяем co-residence: 70B-Q4 (43) + 32B-Q4 (20) + 14B (9) = 72 ГБ →
влезает с запасом под KV-cache.

## Сервер: vLLM vs ollama для bench

Из `DEPLOY_TOPOLOGY.md`: 96 ГБ-бокс — отдельный OpenAI-совместимый
inference-хост (по проекту фигурирует как vLLM). Риг `text-bench-real.py`
умеет **оба** протокола (`--api ollama` / `--api openai`).

- **Для свипа моделей удобнее ollama**: хот-свопит модели в рамках одного
  сервера (`ollama pull` + смена `--model`). vLLM держит одну модель на
  процесс — перезапуск под каждого кандидата = действие владельца ×N.
- **Под production-победителя — vLLM**: continuous batching → реальная
  concurrency worker'ов (сейчас потолок 2 из-за сериализации ollama).

Рекомендация: на время bench v3 поднять на боксе ollama (или дать нам право
пуллить); под выбранную модель в проде — vLLM.

## Прогон

Вариант A — **ollama** на боксе (`--api ollama`, дефолт):

```bash
# пулл кандидатов
ollama pull llama3.3:70b
ollama pull qwen2.5:72b
ollama pull qwen3:32b
ollama pull gemma3:27b
ollama pull mistral-small3.1:24b
ollama pull phi4:14b            # baseline
# T-Pro: ollama pull hf.co/t-tech/T-pro-it-1.0-Q4_K_M-GGUF  (если есть на HF)
```

С рабочей машины (заменить `<host>` на адрес 96 ГБ-сервера):

```bash
cd doc-service
for M in llama3.3:70b qwen2.5:72b qwen3:32b gemma3:27b mistral-small3.1:24b phi4:14b; do
  python3 scripts/text-bench-real.py --url http://<host>:11434 --model "$M"
done
```

Отчёты пишутся в `~/Desktop/parsdocs-validation-bench/results/text-<model>-real-<date>.json`.
Каждая модель печатает в конце:

```
field exact-match: NN.N%  (k/total)
'total' arithmetic: NN.N%  (k/total)
```

Вариант B — **vLLM / OpenAI-совместимый** (`--api openai`, `--url .../v1`):

```bash
python3 scripts/text-bench-real.py --api openai \
  --url http://<host>:8000/v1 --api-key "$OPENAI_API_KEY" \
  --model meta-llama/Llama-3.3-70B-Instruct
```

**A/B по квантизации** (гипотеза 2) — одна модель, три тега:
```bash
python3 scripts/text-bench-real.py --url http://<host>:11434 --model qwen2.5:32b          # Q4 (дефолт тега)
python3 scripts/text-bench-real.py --url http://<host>:11434 --model qwen2.5:32b-instruct-q8_0
python3 scripts/text-bench-real.py --url http://<host>:11434 --model qwen2.5:32b-instruct-fp16
```

**Замечания по честности замера:**
- temperature 0, num_predict 4096, num_ctx 32768 (зашито).
- Первый вызов модели — холодная загрузка в VRAM; гнать дважды, латентность
  брать со второго прогона.
- Один и тот же golden-набор и промпт на всех — меняется только модель.

## Критерии победителя

1. **Главное:** `total` arithmetic match-rate — должен бить 60% Phi-4.
2. **Вторично:** field exact-match %, classification accuracy.
3. **Цена:** сек/файл, влезает ли с запасом под concurrency.
4. **Tiebreak:** возможность co-residence для per-type router (Tier 2).

## Что дальше с победителем

1. Прогнать через **полный пайплайн** (`src/scripts/eval/run.ts --golden-set`)
   — подтвердить с нашим промптом/валидацией/очередью, а не «голым» ollama.
2. Второй проход на **OCR-тексте** (`--text-dir`) — проверить устойчивость к
   OCR-шуму (production реально кормит OCR).
3. Прописать как дефолт в `inference-service/.env` (`OPENAI_MODEL`).
4. Записать результаты в `docs/MODEL_REPORT.md` (прогон #29+) и обновить
   таблицу в `docs/TESTS_INDEX.md`.
5. Если латентность 70B высока — включить **per-type router** (Tier 2):
   простые типы → 14B/24B, сложные УПД → 70B (модели co-resident).
