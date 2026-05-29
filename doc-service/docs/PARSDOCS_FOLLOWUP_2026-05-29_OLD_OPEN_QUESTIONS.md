# parsdocs → SLAI: follow-up по 4 старым вопросам, блокирующим production

**Дата:** 2026-05-29
**От:** parsdocs
**Кому:** SLAI (Aleksandr Liapustin / Александр Ляпустин)
**Тип:** нудж, второй (первый был `PARSDOCS_NUDGE_SLAI_2026-05-26.md`)
**Связано:** `INTEGRATION_QUEUE.md`, `SLAI_INTEGRATION_BACKLOG.md`, `slai-response-to-parsdocs-2026-05-26.md`, `PARSDOCS_REPLY_TO_SLAI_LINE_SIGNALS_2026-05-29.md`

---

## TL;DR

С нашей стороны накатили всё что обещали (EXT-A/B/D + line-signals + hybrid-routing + Yandex prep + ASR ingest path). **Production-готовность parsdocs упёрлась в 4 ваших ответа**, висящих с 2026-05-16/17 (две недели). Без них пилот не запустить.

| # | Вопрос | Висит с | Что блокирует |
|---|--------|---------|---------------|
| **Q4** | Service-token для parsdocs→SLAI webhook auth | 2026-05-16 | webhook receiver, F3 items 1+3 |
| **Q5** | ETA пилота с реальными документами | 2026-05-16 | весь rollout-план |
| **Q9** | Golden dataset (15 PDF + 15 `.gt.json`) | 2026-05-17 (ANSWERED, файлов нет) | honest baseline accuracy → go/no-go решение |
| **AC9** | Sandbox-тенант: формат изоляции | 2026-05-26 (наш ответ ждёт подтверждения) | contract-test'ы и интеграционные прогоны |

---

## Что у нас уже сделано пока ждали (для контекста)

**В коде (ждут деплоя):**
- EXT-A: `GET /capabilities` + `X-Extractor-Signature` (`d798917`)
- EXT-B: BYO LLM credentials `X-LLM-*` headers (`808e5cb`, 18 тестов)
- EXT-D: pre-upload signed URL + SSRF DNS-rebind защита (`808e5cb`/`4a2ad6e`, 28 тестов)
- EXT-LINE: 10 transport signal fields (`42adffc`)
- Hybrid text/vision routing (`ef24a8d`)
- Extraction-from-image путь (`2aff356`)
- Yandex OCR scan-routing (`164f83e`, ждёт ключа)
- ASR (voice) ingest path (`164f83e`, ждёт модели)
- Auth fail-closed + DaData enrichment (`243fe04`/`d58ebdb`)
- 26 типов документов в БД (обе фазы SLAI ТЗ покрыты)

**В содержании:**
- Vision (Qwen2.5-VL 32B) впервые прошёл ваши гейты точности на реальных доках: critical **96%** / overall **90%** (пороги 95/85).
- Свой бенч `MODEL_REPORT.md` #26.

**Чего НЕ хватает с нашей стороны:** ничего, что зависит только от нас.

---

## Детально — что блокирует и почему важно

### Q4. Service-token для parsdocs→SLAI webhook auth

**Контекст:** наш webhook receiver (для прихода `apply_document_extraction` callback'а с вашей стороны после обработки) нуждается в bearer/HMAC-токене SLAI-side, чтобы аутентифицироваться к вам. F3 items 1+3 (`webhook-receiver + service-token slai`) полностью заблокирован.

**Что нужно от вас:** один shared secret (`openssl rand -hex 32`) + URL вашего endpoint'а для callback'а. Способ передачи — любой защищённый (envelope-зашифрованный, 1Password, или просто **через SLAI_SECRETS_INBOX.md** в их репо).

**Effort с вашей стороны:** ~5 минут.
**Effort с нашей стороны после получения:** 0.5 дня — записать в `provider_settings` (encrypted) + включить F3.

---

### Q5. ETA пилота с реальными документами

**Контекст:** мы готовы технически — EXT-A/B/D в коде, sandbox-инстанс можем поднять день в день. Но без даты «когда стартуем» — не можем согласовать деплой, координацию команд, мониторинг.

**Что нужно от вас:** конкретная неделя (`YYYY-WW`) когда подключаемся к вашему dev/staging. **Не обязательно сегодня start'ить — обязательно дату называть, чтобы планировать.**

**Effort с вашей стороны:** 1 решение продакта.

---

### Q9. Golden dataset (15 PDF + 15 `.gt.json`)

**Контекст:** ваш SLAI TZ v1 §5 явно требует golden dataset для AC замера: «critical fields ≥95%, остальные ≥80%». **Это критерий приёмки**. Без него:
- Не можем доказать что vision проходит ваши пороги на **вашем распределении** документов (наш бенч был на digital PDF, не на ваших реальных сканах);
- Не можем дать честный go/no-go для пилота;
- Если в проде окажется что pass-rate ниже — будет переделывать, а не пилотировать.

**Статус:** ANSWERED 2026-05-17, файлов нет 12 дней.

**Что нужно от вас:** 15 PDF + 15 `.gt.json` любым способом (scp, Я.Диск, GitHub в наш репо в `doc-service/test-fixtures/slai-golden/`, лично с переноской).

**Бонус:** в нашем ответе по `EXT-LINE` (`PARSDOCS_REPLY_TO_SLAI_LINE_SIGNALS_2026-05-29.md` §A.5.2) уже попросили 10–15 PDF морских/авто/брокерских — они частично закрывают Q9.

**Effort с вашей стороны:** 30 минут — экспортировать из вашей системы, заанонимизировать (опционально, у нас есть PII redaction), отправить.

---

### AC9. Sandbox-тенант: формат изоляции

**Контекст:** в нашем `PARSDOCS_REPLY_TO_SLAI_EXT_2026-05-26.md` обещали выдать вам dedicated `organization_id` + token для sandbox после деплоя EXT-A. Ждём подтверждения формата:

1. Отдельная organization (полная изоляция от prod jobs, отдельные quota/rate-limits)?
2. Или дополнительный project внутри существующей org (jobs пересекаются по storage/Redis, но отдельный токен)?
3. Какая retention-политика для test jobs (24h / 7d / навсегда)?
4. Нужен ли rate-limit `?` (например 60 req/min для предотвращения flooding'а из contract-test'ов)?

**Что нужно от вас:** ответ {1|2}, {retention в днях}, {rate-limit или нет}. 4 строки в Telegram.

**Effort с вашей стороны:** ~3 минуты.
**Effort с нашей стороны после получения:** ~10 минут — `INSERT INTO organizations` + `INSERT INTO personal_access_tokens`, прислать вам токен зашифрованным.

---

## Предложение по форме ответа

Текст ответа на 4 пункта **может уложиться в одно сообщение**:

```
Q4: secret_token=<hex>, callback_url=https://slai.example/api/v1/webhooks/parsdocs
Q5: WW-23 (start 02.06)
Q9: PDF→https://disk.yandex.ru/<link>, .gt.json→в репо commit ...
AC9: (1) отдельная organization, retention 7d, rate-limit 60/min
```

Если что-то из этого требует продуктовой проработки/встречи — скажи **что именно** и **когда сможем** — это уже план.

---

## Если не будет ответа

Если до 2026-06-05 (неделя от сегодня) не будет ответов хотя бы по **Q4/Q5/Q9** — мы:

- Деплоим EXT-A/B/D на prod (`API_KEY` ставим сами по P0-1).
- Включаем `BYO_LLM_ENABLED=false`, `FILE_URL_INGEST_ENABLED=false` (no breaking surface).
- Sandbox-тенант **не** заводим (нечего тестировать без callback'а к вам).
- Свой mini-golden-set собираем из реальных доков ТАЙПИТ — даём первую honest цифру точности **на наших** документах. Прод-проверка SLAI-кейсов остаётся на ваших файлах.

То есть наша сторона **не** ждёт вас — переходит в режим «готовы когда вы готовы». Но интеграционный пилот сдвинется на ваш ответ.

---

## Контакты

- **parsdocs technical owner:** Aleksandr Lyapustin (`a.liapustin@mod-soft.ru`) / `liapustin@gmail.com`
- **Канал для технических Q:** `INTEGRATION_QUEUE.md` в git (зеркало у вас — `xanderkag/SLAI/docs/PARSDOCS_QUEUE.md`)
- **Канал для продуктовых Q:** чат

---

## История

- 2026-05-26: первый нудж (`PARSDOCS_NUDGE_SLAI_2026-05-26.md`) по Q4/Q5/Q9 — без ответа.
- 2026-05-29: этот followup, добавлен AC9. Если до 2026-06-05 нет ответа — заморозка пилота, переход в самостоятельный режим.
