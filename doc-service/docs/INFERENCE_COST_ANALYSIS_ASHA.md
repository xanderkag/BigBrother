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
- **Folder ID: `b1gnihkga1nso6ecb50r`** (снят из консоли 2026-07-07)

### Каталог AI Studio — Qwen 3.6 НЕТ

Проверено 2026-07-07. Доступны (по офиц. описанию сервиса):

| Модель | Комментарий |
|---|---|
| `Qwen3-235B-A22B` | крупный MoE — ближайший родственник нашего локального qwen3.x |
| `GPT-OSS-120b` | open-weights |
| DeepSeek | семейство |
| YandexGPT 5.1 Pro / Lite | нативные Yandex |

**Модель-кандидат: `Qwen3-235B-A22B`** (наибольшее семейное сходство с baseline
`qwen3.6:27b` → сравнение честнее). Fallback-кандидаты: GPT-OSS-120b, YandexGPT 5.1 Pro.

⚠ **Тарифы ₽/1K токенов не верифицированы**: страницы прайса AI Studio отдают
CAPTCHA («Вы не робот?») автоматизированному доступу. Снять вручную из консоли/
прайса перед расчётом ₽/док. Из открытых источников (НЕ подтверждено):
YandexGPT Pro 5.1 ≈ 0.80 ₽/1K, Lite ≈ 0.20 ₽/1K.

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

### ✅ Блокер Ф3 ЗАКРЫТ (2026-07-08)

`usage {prompt_tokens, output_tokens}` теперь возвращается в **каждом** ответе
inference-service (classify / extract / verify / vision), независимо от
`include_debug`. doc-service складывает расход по **всем** вызовам джобы через
AsyncLocalStorage и пишет итог в `jobs.llm_usage`:

```json
{ "calls": 7, "prompt_tokens": 18432, "output_tokens": 2015, "calls_without_usage": 0 }
```

**Счётчик знает, чего не знает.** Backend без usage (`stub`, `qwen_vl`) попадает
в `calls_without_usage`, а НЕ считается нулевым. `calls_without_usage > 0` →
суммы неполны, и ₽/док по такой строке — **нижняя граница**.

Ф3-замер теперь:

```sql
SELECT
  count(*)                                                   AS docs,
  avg((llm_usage->>'prompt_tokens')::bigint)                 AS avg_in,
  avg((llm_usage->>'output_tokens')::bigint)                 AS avg_out,
  count(*) FILTER (WHERE (llm_usage->>'calls_without_usage')::int > 0) AS incomplete
FROM jobs
WHERE llm_usage IS NOT NULL AND finished_at > now() - interval '7 days';
```

`incomplete > 0` — цифры считать нельзя, сначала разобраться с backend'ом.

<details><summary>Что было сломано (история)</summary>

### 🔴 Блокер Ф3: токены multipass-документов сейчас НЕ измеримы

Разобрано по коду 2026-07-07. Наивный источник даёт **систематический недосчёт**:

1. **`llm_gateway_usage` не подходит.** В неё пишет только код внешнего
   SLAI-шлюза (`storage/llm-usage.ts`, `routes/gateway-admin.ts`). Внутренний
   extraction идёт doc-service → inference-service и в эту таблицу не попадает.
2. **`jobs.last_llm_call` (JSONB) содержит токены** — но только **последнего**
   вызова.
3. **Убийственное:** в `parsers/multipass-llm.ts` Pass 1 (шапка) идёт с
   `includeDebug: true`, а Pass 2 — **все N чанков с позициями** — с
   `includeDebug: false`. Токены возвращаются inference-сервисом только внутри
   `debug`. Значит **токены чанков не возвращаются вообще** — ни в БД, ни в лог.

Итог: для документа с большим `items[]` (12 KB на чанк) замер покажет стоимость
**только шапки** и выдаст её за стоимость документа. Чем больше позиций — тем
сильнее занижение. Инвойс ВЭД-комплекта (53 позиции) пострадает заметно.

**Минимальный корректный фикс (аддитивный, без миграции):**
- inference-service: возвращать `usage {prompt_tokens, output_tokens}` в
  `ExtractResponse` **всегда**, а не только внутри `debug` (2 int, дёшево);
- doc-service: логировать токены на **каждый** extract-вызов с `job_id`
  (включая чанк-проходы);
- Ф3: агрегировать структурированные логи по `job_id` → настоящие токены/док.

Без этого Ф3 нельзя считать выполненным.

</details>

Тариф Yandex — из актуального прайса AI Studio + Vision на момент замера
(см. оговорку про CAPTCHA выше).

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
