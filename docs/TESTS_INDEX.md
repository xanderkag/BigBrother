# 📊 Индекс испытаний parsedocs — модели, бенчмарки, реальные прогоны

> **Назначение:** единая точка входа во ВСЕ тесты системы распознавания
> документов. Подробные данные — в связанных отчётах (ссылки ниже).
> Обновляется при каждом новом прогоне.
>
> **Последнее обновление:** 2026-05-25 (прогон #28)

---

## TL;DR — что выбрали и почему

| Слот | Модель | Обоснование |
|---|---|---|
| 🥇 **Локальный production-дефолт** | **Phi-4 14B** (text, после OCR) | Лучшая арифметика (`total` 60%), 34 сек/файл, влезает в 20 GB VRAM |
| 🥈 **Критичные документы** | Gemma 3 27B (text) | По полям = Phi-4, чуть медленнее; запас точности |
| ☁️ **Облачный target (пилот SLAI)** | Claude Sonnet 4.6 | 5× быстрее локальных, $0.02/doc; **только через корп-шлюз для реальных данных** |
| 🪶 **Edge / компактный** | YandexGPT-5 Lite 8B | 5 GB, 5 мин/10 — для ограниченного железа |
| 👁 **Vision (сканы без OCR-слоя)** | Mistral Small 3.1 (image) | Единственная vision с реальным ИНН 80%; но `total` слабый — vision только когда нет текстового слоя |
| 🖥 **GPU-стенд** | RTX 4000 Ada, 20 GB VRAM, узел `10.10.28.10` | Главное ограничение — всё >32B Q4 идёт в CPU offload и тормозит |

**Главный вывод:** для документов с текстовым слоем (PDF, хороший скан) **text-пайплайн (OCR → Phi-4) стабильно бьёт vision** по арифметике сумм. Vision держим для фото/кривых сканов.

---

## Сводная таблица — bench v2 (10 PDF + ground-truth)

Метрики: F1 items / точность type-number-date / ИНН / **total** (сумма с НДС — самая сложная метрика, по ней модели и расходятся).

| Модель | Режим | Размер | Время/10 | type | number | date | items F1 | ИНН | **total** |
|---|---|---|---|---|---|---|---|---|---|
| **Phi-4 14B** ⭐ | text | — | **5.6 мин** | 100% | 100% | 100% | 80% | 80% | **60%** |
| T-Pro 32B (Т-Банк) | text | 20 GB | 19.4 мин | 100% | 100% | 100% | 80% | 80% | **60%** |
| Gemma 3 27B | text | 17 GB | 11.5 мин | 100% | 100% | 100% | 80% | 80% | 50% |
| Qwen 2.5 32B | text | 20 GB | 18.6 мин | 100% | 100% | 100% | 80% | 80% | 50% |
| Mistral Small 3.1 | text | 15 GB | 7.6 мин | 100% | 100% | 100% | 80% | 80% | 40% |
| YandexGPT-5 Lite 8B | text | **5 GB** | **5.1 мин** | 100% | 100% | 100% | 80% | 80% | 30% |
| Gemma 3 12B | text | 8 GB | 5.0 мин | 100% | 100% | 100% | 80% | 80% | 20% |
| **Mistral Small 3.1** | vision | 15 GB | 8.4 мин | 100% | 100% | 100% | 79% | **80%** | 20% |
| MiniCPM-V 2.6 | vision | 5.5 GB | 9.0 мин | 10% | 10% | 40% | 49% | 0% | 0% ❌ |
| **Claude Sonnet 4.6** | cloud | — | **1.3–2.2 мин** ⚡ | 100% | 100% | 100% | 80% | 80% | 60% |

❌ **Не использовать:** MiniCPM-V (vision провал), Qwen 2.5 32B (медленнее Gemma 27B без выигрыша).

---

## Хронология прогонов (детали — в MODEL_REPORT.md)

Полные данные каждого прогона: [`docs/MODEL_REPORT.md`](./MODEL_REPORT.md)

### Phase 1 — синтетический corpus (8 PDF, май 15–17)
| # | Что | Итог |
|---|---|---|
| #2–10 | Qwen 3B/14B, Gemma 4B/12B/27B, Qwen-VL 7B/32B, MiniCPM-V | Gemma 27B лидер по точности, Qwen-VL 32B точен но тормозит |

### Phase 2 — расширенный corpus v2 (10 PDF + ground-truth, май 16)
| # | Модель | Итог |
|---|---|---|
| #12 | Gemma 3 12B (text) | baseline v2, 0 провалов |
| #13 | MiniCPM-V (vision) | провал — 3 BAD-JSON, ИНН 0% |
| #14 | Gemma 3 27B (text) | total 50% |
| #15 | Qwen 2.5 32B (text) | медленно, без выигрыша |
| #16 | Mistral Small 3.1 (text) | total 40% |
| **#17** ⭐ | **Phi-4 14B (text)** | **total 60% — лучший, выбран дефолтом** |
| #18 | Mistral Small 3.1 (vision) | первая vision с ИНН 80% |
| #19 | YandexGPT-5 Lite 8B (text) | компактная, total 30% |
| #20 | T-Pro 32B (text) | = Phi-4 по точности, в 3.5× медленнее |

### Phase 3 — облако (10 PDF, май 17)
| # | Модель | Итог |
|---|---|---|
| #21 | Claude Sonnet 4.6 | 9/10 JSON, $0.0165/doc, 4× быстрее локальных |
| #22 | Claude Sonnet 4.6 + F14/F15 фиксы | 10/10 JSON, сравнялся с Gemma 27B при 5× скорости |

### Phase 4 — РЕАЛЬНЫЕ документы + golden-set (6–9 PDF, май 25)
| # | Что | Итог |
|---|---|---|
| #23 | Phi-4 на реальных (Phase 1 labeled) | первый прогон на бою |
| #24 | re-бенч после envelope-recovery fix | — |
| #25 | re-бенч после 3 prod-фиксов (money-flatten, party-mapping, tax_invoice→LLM) | свежий baseline |
| #26 | Qwen2.5-VL 32B vision vs phi4-text | сравнение vision/text на реале |
| #27 | vision-поиск in-SLA: llama3.2-vision 11B, gemma3 27B/12B | — |
| **#28** | **Qwen2.5-VL 7B vs 32B head-to-head** (точность + латентность) | последний прогон |

---

## Реальные документы — отдельные отчёты

| Отчёт | Что внутри |
|---|---|
| [`doc-service/docs/REAL_DOCS_FULL_REPORT_2026-05-18.md`](../doc-service/docs/REAL_DOCS_FULL_REPORT_2026-05-18.md) | Полный прогон на VED-документах EWL/ANJI MINGPAI: PDF-text ✅, scan ⚠️, XLSX ✅, EAC-cert 10MB. Выявленные баги (classifier priority, single-shot OOM на длинных текстах), production readiness |
| [`doc-service/docs/REAL_DOCS_SMOKE_RESULTS_2026-05-18.md`](../doc-service/docs/REAL_DOCS_SMOKE_RESULTS_2026-05-18.md) | Smoke на 3 реальных: Акт взвешивания, Коносамент FESCO, ВТБ заявление на перевод. Что работает / что подкрутить |

---

## Как воспроизвести тесты

| Скрипт | Назначение |
|---|---|
| [`doc-service/scripts/vision-benchmark.py`](../doc-service/scripts/vision-benchmark.py) | Бенч vision-моделей на синтетическом corpus |
| [`doc-service/scripts/vision-bench-real.py`](../doc-service/scripts/vision-bench-real.py) | Бенч на реальном golden-set |
| [`doc-service/src/scripts/eval/run.ts`](../doc-service/src/scripts/eval/run.ts) | Eval-прогон (`npm run eval`) — точность по полям против golden-set |
| [`doc-service/src/scripts/eval/compare.ts`](../doc-service/src/scripts/eval/compare.ts) | Сравнение extracted vs ground-truth, считает F1 по полям |
| [`doc-service/src/scripts/smoke.ts`](../doc-service/src/scripts/smoke.ts) | Smoke-тест пайплайна (`npm run smoke`) |

**Golden-set формат:** см. [`doc-service/src/scripts/eval/golden-set.example.json`](../doc-service/src/scripts/eval/golden-set.example.json) и [`schema.ts`](../doc-service/src/scripts/eval/schema.ts).

GPU-стенд: узел `10.10.28.10` (RTX 4000 Ada, 20 GB VRAM), ollama на `:11434`. Доступ — у владельца узла (не наш `10.10.13.10`).

---

## Что в очереди (не прогнано, кандидаты)

- **`qwen3:14b`** — уже скачан на узле `.28.10`, новее Qwen2.5, НЕ бенчмаркали. Первый кандидат на бесплатный прогон.
- **InternVL3 8B/14B** — лучший открытый doc-vision, закрыл бы слабое место vision-трека (требует пулла).
- **Gemini 2.0 Flash** — облачный, дёшево + нативный vision, для сканов (через корп-шлюз).
- **Per-type model router** — простые типы → лёгкая модель, сложные (УПД с длинными таблицами) → Phi-4/Gemma 27B.

См. полный список кандидатов в истории обсуждений / TECH_DEBT.
