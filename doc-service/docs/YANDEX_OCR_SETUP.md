# Yandex Vision OCR — runbook включения

> **Статус: код готов, движок ВЫКЛЮЧЕН.** Этот документ — чеклист на момент,
> когда решим включить. Пока `YANDEX_VISION_API_KEY` / `YANDEX_FOLDER_ID`
> пустые — движок не попадает в OCR-цепочку (см. `isAvailable()`).
> Подготовлено 2026-05-20. Контракт сверен в commit `7ccadd7`.

## Зачем

Yandex OCR заменяет **Tesseract** на плохих сканах (где локальный OCR даёт мусор),
а не Claude. Это OCR-шаг (raw text) → дальше всё равно LLM-extract. Подключается
последним fallback'ом в OCR-цепочке.

**Цена** (с НДС, постранично): печатный текст `page` — **0.1321 ₽/стр**,
таблицы 1.22 ₽, рукопись 1.52 ₽. При 50 doc/day ≈ 400 ₽/мес, и то только когда
Яндекс реально вызывается. Free-tier нет.

## 152-ФЗ

Яндекс — **российское облако**, data-residency по 152-ФЗ соблюдается. Дополнительно:
- Каждый запрос шлёт `x-data-logging-enabled: false` → Яндекс не сохраняет наши доки.
- PII-документы (ТТН/CMR с паспортом водителя / контактами) **не уходят** в Яндекс
  вообще — гард I8 (`YANDEX_DISABLE_FOR_PII` + per-job `metadata._disable_external_ocr`).

Для печатных счетов/актов/УПД без перс.данных — включать безопасно.

## Чеклист включения (ops)

### 1. Облако / каталог
- Зайти в [console.yandex.cloud](https://console.yandex.cloud), выбрать (или создать) **каталог** (folder).
- Скопировать **folder ID** (в URL или в свойствах каталога, вид `b1g…`). → это `YANDEX_FOLDER_ID`.

### 2. Сервисный аккаунт
- В каталоге → «Сервисные аккаунты» → создать (имя напр. `parsdocs-ocr`).
- Назначить роль **`ai.vision.user`** на этот каталог (право `yc.ai.vision.execute` —
  достаточно для OCR, ничего лишнего).

### 3. API-ключ
- Открыть сервисный аккаунт → «Создать новый ключ» → **API-ключ** (не статический access key, не IAM-токен).
- Скопировать значение **сразу** (показывается один раз). → это `YANDEX_VISION_API_KEY`.
- Зафиксировать дату создания для будущей ротации.

### 4. Env на сервере
```env
YANDEX_VISION_API_KEY=<api-key из шага 3>
YANDEX_FOLDER_ID=<folder id из шага 1>
YANDEX_TIMEOUT_MS=30000
# OCR-модель по умолчанию (page / table / page-column-sort / handwritten):
YANDEX_OCR_MODEL=page
# Табличная модель для сканов счёт-фактур/УПД: для перечисленных типов
# вместо YANDEX_OCR_MODEL применяется YANDEX_TABLE_MODEL. CSV slug'ов
# (case-insensitive). Пусто = везде YANDEX_OCR_MODEL.
YANDEX_TABLE_MODEL=table
YANDEX_TABLE_MODEL_TYPES=invoice,tax_invoice,UPD
# Сделать Яндекс первым scan-движком (перед tesseract/vision-llm) на растрах.
# false = Яндекс остаётся last-resort fallback'ом (порядок цепочки не меняется).
YANDEX_PREFER_FOR_SCANS=false
# Запретить Яндекс для PII даже если включён (рекоменд. оставить true):
YANDEX_DISABLE_FOR_PII=true
```
Положить в секреты деплоя (не в git). Рестарт `api` + `worker`.

Конфиг-сводка (все knob'ы env-driven, ключ — только в секретах деплоя):

| Env | Назначение | Default |
| --- | --- | --- |
| `YANDEX_VISION_API_KEY` | API-ключ сервисного аккаунта. Пусто → движок OFF. | — |
| `YANDEX_FOLDER_ID` | folder ID каталога. Пусто → движок OFF. | — |
| `YANDEX_TIMEOUT_MS` | таймаут одного recognizeText-вызова. | `30000` |
| `YANDEX_OCR_MODEL` | модель по умолчанию. | `page` |
| `YANDEX_TABLE_MODEL` | модель для табличных типов. | `table` |
| `YANDEX_TABLE_MODEL_TYPES` | CSV slug'ов → используют `YANDEX_TABLE_MODEL`. | пусто |
| `YANDEX_PREFER_FOR_SCANS` | Яндекс впереди локальных scan-движков. | `false` |
| `YANDEX_DISABLE_FOR_PII` | выключить Яндекс для PII-типов (TTN/CMR). | `false` |

Per-job override (через `metadata`, побеждает env):
- `_yandex_ocr_model` — принудительная модель для конкретного job'а.
- `_disable_external_ocr=true` — не отправлять этот job в Яндекс (PII opt-out).

### 5. Smoke-проверка (обязательно до боевого прогона)
Прогнать один тестовый печатный документ (без PII) через `src/scripts/smoke.ts`
или загрузкой через UI с `metadata._force_engine` если поддерживается. Убедиться:
- ответ приходит, `text` непустой, `engine: "yandex"`;
- HTTP 200 (не 400 — значит ключ/folder/роль верны);
- (по логам Яндекса) запрос с `x-data-logging-enabled: false` — данные не залогированы.

### 6. Включение в цепочку
Никаких правок кода — как только env заполнен и сервис перезапущен, `isAvailable()`
вернёт true и оркестратор начнёт пробовать Яндекс. Где именно в цепочке:

- **По умолчанию** (`YANDEX_PREFER_FOR_SCANS=false`) — Яндекс последний fallback,
  после `pdf-text` → `tesseract` → `vision-llm` (как было).
- **`YANDEX_PREFER_FOR_SCANS=true`** — на растровых входах (image/* и сканы PDF)
  Яндекс встаёт ПЕРЕД локальными scan-движками (tesseract / vision-llm). Нативный
  текстовый слой (`pdf-text` / xlsx / docx) всё равно пробуется первым — на чистом
  тексте Яндекс не нужен. Так скан-документ маршрутизируется: pdf-text не дотянул
  порог → **Яндекс table-OCR → текст → LLM-extract** (быстрый облачный OCR вместо
  медленного локального vision). PII-гард сохраняется: на TTN/CMR (при
  `YANDEX_DISABLE_FOR_PII=true`) и при `_disable_external_ocr=true` Яндекс
  выкидывается из цепочки до всякого переупорядочивания.

**Табличная модель.** Заполните `YANDEX_TABLE_MODEL_TYPES` slug'ами табличных типов
(напр. `invoice,tax_invoice,UPD`). Тогда для этих типов Яндекс вызывается с
`model=table` вместо `page` — точнее на сканах счёт-фактур. document_type берётся из
`document_hint`/классификатора. Точечно можно форсировать модель per-job:
`metadata._yandex_ocr_model=table`.

## Откат
Очистить `YANDEX_VISION_API_KEY` (или `YANDEX_FOLDER_ID`) → рестарт. Движок мгновенно
выпадает из цепочки, остальной pipeline не меняется.

## Технические детали (для справки)
- Endpoint: `POST https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText` (синхронный, 1 стр PDF/вызов).
- Многостраничные PDF — постранично через `rasterizedPages` (оркестратор уже растеризует).
- Реализация: `src/pipeline/ocr/yandex.ts`, тесты `tests/yandex-ocr.spec.ts`.

## Источники
- [Vision OCR pricing](https://aistudio.yandex.ru/docs/ru/vision/pricing)
- [TextRecognition.Recognize API](https://yandex.cloud/en/docs/vision/ocr/api-ref/TextRecognition/recognize)
- [About Yandex Vision OCR](https://yandex.cloud/en/docs/vision/concepts/ocr/)
- [IAM API key](https://yandex.cloud/en/docs/iam/concepts/authorization/api-key)
