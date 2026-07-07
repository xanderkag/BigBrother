# Inference cost analysis — asha (Yandex Cloud on-demand vs local GPU)

> **Статус:** scaffold — числа Yandex заполняются по факту прогона Ф2/Ф3
> (ждёт Ф0: аккаунт + ключи). Baseline и гейты — зафиксированы.
> **Окружение:** только asha (135.106.158.143, Selectel личный, SLAI-пилот).
> Синтетика/BYO, без корп-данных → облачный egress ок.
> **ТЗ:** «On-demand инференс на Yandex Cloud для asha — bench & test».

Yandex Cloud — **российский** сервис: с RU-IP asha достаётся **напрямую, без
EU-прокси** (в отличие от Anthropic/OpenAI, которые режут RU-IP). Это и есть
причина, почему облачный путь для asha реален именно через Yandex.

---

## 1. Кандидат-конфигурация

| Слой | Сервис | Как подключается |
|---|---|---|
| Vision OCR (сканы) | Yandex Vision `ocr/v1/recognizeText` | код готов (`pipeline/ocr/yandex.ts`), только env |
| Extraction | Yandex AI Studio (OpenAI-совм.) | `openai_compat` backend, 2 строки конфига |

- Base URL: `https://llm.api.cloud.yandex.net/v1`
- Модель: `gpt://<folder-id>/<model-id>/latest` (folder в URI → `x-folder-id` заголовок не нужен)
- Модель-кандидат: **TBD** — подтвердить в каталоге AI Studio (Qwen 3.x / DeepSeek / YandexGPT); берём лучшую доступную.

---

## 2. Baseline — локальный qwen3.6:27b (MODEL_REPORT #36)

| Метрика | Локальный qwen3.6:27b |
|---|---|
| Поля (golden-set) | 98.3% |
| Арифметика total | 100% |
| Латентность (медиана) | ~7 с |
| Стоимость железа | аренда GPU L4 ≈ **58 500 ₽/мес** (фикс, вне зависимости от объёма) |

Экономика различается принципиально: L4 — **фиксированная аренда**, Yandex —
**per-token** (платишь за объём). Точка безубыточности зависит от реального
числа документов/мес пилота (см. §4).

---

## 3. Гейты приёмки

| Гейт | Порог | Тип |
|---|---|---|
| Critical-поля (ИНН/total/number/date) | ≥ 95% на golden-set | **жёсткий** |
| Поля в целом | не ниже локального qwen3.6:27b более чем на 2 п.п. | желательный |
| Латентность p95 (с сетевым RT) | ≤ 90 с (SLA) | жёсткий |
| Стоимость | замеренный ₽/док × объём < 58 500 ₽/мес | жёсткий |
| PII-гард | ТТН/CMR НЕ уходят в Yandex (`YANDEX_DISABLE_FOR_PII`) | жёсткий |

PII-гард проверен в коде: `router.ts` `PII_DOCUMENT_TYPES={TTN,CMR}` →
при `disableYandexForPii && isPiiDoc` yandex-движок выкидывается из OCR-цепочки.

---

## 4. Замеры (заполнить в Ф3) — TBD

Снять на выборке пилота:

| Показатель | Значение |
|---|---|
| Средние токены вход (OCR-текст + prompt) | _TBD_ |
| Средние токены выход (JSON) | _TBD_ |
| Доля сканов vs текст-PDF | _TBD_ |
| Доля table-страниц (табличный OCR) | _TBD_ |
| ₽/док (Vision OCR) | _TBD_ |
| ₽/док (AI Studio extraction) | _TBD_ |
| **₽/док суммарно** | _TBD_ |
| Объём пилота (док/мес) | _TBD_ |
| **₽/мес экстраполяция** | _TBD_ |
| Точка безубыточности vs L4 (58 500 ₽) | _TBD_ док/мес |

Источник токенов: `llm_gateway_usage` (per-request prompt/completion tokens) +
логи inference. Тариф Yandex — из актуального прайса AI Studio + Vision на
момент замера.

---

## 5. Результат bench (заполнить в Ф2/Ф4) — TBD

| Метрика | Локальный qwen3.6:27b | Yandex AI Studio (`<model>`) | Δ |
|---|---|---|---|
| Поля % | 98.3% | _TBD_ | _TBD_ |
| Critical % | _TBD_ | _TBD_ | _TBD_ |
| Арифметика total % | 100% | _TBD_ | _TBD_ |
| Валидный JSON % | _TBD_ | _TBD_ | _TBD_ |
| Латентность p50 | ~7 с | _TBD_ | _TBD_ |
| Латентность p95 | _TBD_ | _TBD_ | _TBD_ |
| ₽/док | — (фикс L4) | _TBD_ | — |

Полный прогон — в `../../docs/MODEL_REPORT.md` (новый #-блок: Yandex AI Studio).

---

## 6. Вывод — TBD

_Проходит / не проходит гейты + рекомендация по конфигурации asha
(Yandex endpoint как рабочая конфигурация пилота / fallback: другая модель
AI Studio / вернуться к локальному GPU). Заполняется в Ф4._

---

## История

- 2026-07-07: scaffold — код Ф1/Ф2 верифицирован готовым, endpoint/PII-гард
  подтверждены, baseline+гейты зафиксированы. Ждёт Ф0 (аккаунт+ключи).
