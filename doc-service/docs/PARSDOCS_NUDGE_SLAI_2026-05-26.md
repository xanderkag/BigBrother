# Нудж SLAI — 3 вопроса по пилоту (2026-05-26)

> Готово к отправке. Адресат: команда SLAI Суперлогист (xanderkag).
> Кросс-линки: `INTEGRATION_QUEUE.md` (Q4/Q5/Q9), `SLAI_INTEGRATION_BACKLOG.md`,
> `slai-response-to-parsdocs-2026-05-26.md`, `MODEL_REPORT.md` #26.

---

Привет!

Хорошие новости: ваше EXT ТЗ (`slai-response-to-parsdocs-2026-05-26.md`)
**реализовано у нас полностью**, всё под тестами:

- **EXT-A** — `GET /api/v1/capabilities` (adapter/contractVersion/
  supportedDocumentTypes/maxFileMB/webhookSupported) + webhook-заголовок
  `X-Extractor-Signature` как alias к существующему (back-compat). Можете
  писать contract-test против `ParsdocsAdapter`.
- **EXT-B** — BYO LLM-креды per-request через `X-LLM-Provider/Api-Key/Model/Base-Url`.
  Ключ зашифрован в envelope, редактится в логах/events/audit, за флагом
  `BYO_LLM_ENABLED`, плюс метрики `extractor_llm_credentials_supplied_total`.
- **EXT-D** — приём файла по `file_url` (снимает 50MB-multipart-боттлнек).
  SSRF-safe (private-IP блок до DNS, whitelist схем, no-redirect, byte-cap
  на лету), за флагом `FILE_URL_INGEST_ENABLED`, fail-closed.

Плюс по содержанию: **26 типов документов** в БД — обе фазы вашего ТЗ
(10 типов Фазы 1 + 8 ВЭД Фазы 2) покрыты. Vision (Qwen2.5-VL 32B)
**впервые прошёл ваши гейты точности** на реальных доках: critical 96%
(порог 95%), overall 90% (порог 85%) — `MODEL_REPORT.md` #26.

Мы готовы деплоить и поднять вам отдельный sandbox-тенант (dedicated
organization + token). Чтобы запустить пилот — три вопроса с вашей стороны,
все висят с 2026-05-17:

1. **Q4 — сервис-токен.** Нужен, чтобы наш webhook-receiver мог
   аутентифицироваться к вам. Вы писали «сгенерим через `openssl rand -hex 32`
   по команде продакта» — ждём команды.

2. **Q5 — ETA пилота на реальных документах.** Когда подключаемся к вашему
   dev-окружению? Ваша прежняя оценка — 2-3 недели, нужно подтверждение от
   продакта, чтобы синхронизировать деплой.

3. **Q9 — golden dataset (15 PDF + 15 `.gt.json`).** Критичный блокер:
   без него нет честного baseline точности на вашем распределении документов.
   Ждём с 2026-05-17 — можно scp / Я.Диск / в репо, как удобно.

Две честные оговорки, чтобы выровнять ожидания пилота:

- **Точность мерили на digital PDF** (text-layer, отрендеренный в картинку),
  не на настоящих растровых сканах. Golden dataset (Q9) как раз и нужен,
  чтобы проверить на вашей реальной выборке.
- **Latency vision сейчас 186с P50** (при SLA MVP 90с). У нас уже собран
  hybrid-routing — чистые text-PDF идут быстрым text-путём в рамках SLA,
  vision только для сканов; полная скорость vision — после прихода GPU-сервера
  (vLLM continuous batching). Предлагаем заодно согласовать ожидание по
  latency для MVP.

Как только прилетят Q4/Q5/Q9 — деплоим и стартуем sandbox.

Спасибо!
