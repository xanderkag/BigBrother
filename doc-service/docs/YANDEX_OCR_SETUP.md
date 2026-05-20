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
# опц., по умолчанию "page":
# YANDEX_OCR_MODEL=page
# при желании запретить Яндекс для PII даже если включён (рекоменд. оставить true):
YANDEX_DISABLE_FOR_PII=true
```
Положить в секреты деплоя (не в git). Рестарт `api` + `worker`.

### 5. Smoke-проверка (обязательно до боевого прогона)
Прогнать один тестовый печатный документ (без PII) через `src/scripts/smoke.ts`
или загрузкой через UI с `metadata._force_engine` если поддерживается. Убедиться:
- ответ приходит, `text` непустой, `engine: "yandex"`;
- HTTP 200 (не 400 — значит ключ/folder/роль верны);
- (по логам Яндекса) запрос с `x-data-logging-enabled: false` — данные не залогированы.

### 6. Включение в цепочку
Никаких правок кода — как только env заполнен и сервис перезапущен, `isAvailable()`
вернёт true и оркестратор начнёт пробовать Яндекс последним fallback'ом, когда
`pdf-text` и `tesseract` не дотянули порог.

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
