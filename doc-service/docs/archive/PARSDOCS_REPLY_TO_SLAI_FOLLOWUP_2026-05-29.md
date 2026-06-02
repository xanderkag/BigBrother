# parsdocs → SLAI: подтверждение по 4 закрытым блокерам

**Дата:** 2026-05-29 (поздний вечер)
**В ответ на:** `PARSDOCS_REPLY_TO_FOLLOWUP_2026-05-29.md` (ваш ответ на наш followup)
**Связано:** `INTEGRATION_QUEUE.md`, `SLAI_INTEGRATION_BACKLOG.md`, `SLAI_SECRETS_INBOX.md`

---

## TL;DR

✅ Все 4 ответа приняты. С нашей стороны подготовили каналы и обновили план — **готовы стартовать пилот WW-23 (2026-06-02)** при условии что P0 deploy состоится 30.05-01.06.

---

## По вашим ответам

### Q4 — webhook secret (ETA 2026-05-30)

**Канал получения секрета готов:** в корне нашего репо лежит `SLAI_SECRETS_INBOX.md`
с блоком **S1** под `PARSDOCS_WEBHOOK_SECRET`. Шлите PR с envelope.

**Формат шифрования:** age (https://age-encryption.org) — recipient public key
оставлен placeholder'ом, владелец сгенерирует через `age-keygen` и положит до
30.05. Если age неудобно — Telegram `@xanderkag` для временного канала, как
вариант (но age предпочтительнее: PR версионируется, видно когда applied).

**Callback URL** `https://api.demo.sls24.ru/api/v1/parsdocs/webhook` —
**подтверждаем**. После prod-выхода уточним отдельный prod-host.

### Q5 — пилот WW-23 (2026-06-02)

**Цель подтверждена.** План parsdocs до 2026-06-02:

| Срок | Что | Кто |
|------|-----|-----|
| 30.05-01.06 | P0 ROADMAP-deploy (API_KEY + `deploy-parsdocs.yml`) | owner |
| 30.05 | Получить secret из S1, положить в `provider_settings` | claude (после S1 RECEIVED) |
| 30.05-01.06 | После deploy: создать sandbox-org + token (Q13/AC9) → положить в S2 | claude |
| 02.06 | Confirm у вас: всё работает, шлём первый webhook | оба |

Если P0 deploy сдвинется — двигаем пилот на WW-24, предупредим за 1-2 дня.

### Q9 — golden dataset (ETA 2026-06-02..04)

**Канал готов:** `doc-service/test-fixtures/slai-golden/` + README со
структурой:
```
maritime/        — для container_no, bl_no
international-auto/ — для cmr_no
customs-broker/  — для declaration_no
domestic-auto/   — для ttn_no
```
Каждый PDF + парный `<id>.gt.json`. PR в наш репо предпочтителен (write-доступ
дадим, как только владелец вернётся — напишет в IQ). Fallback: Я.Диск ссылка.

**Eval-runner** (`scripts/eval/run-golden.ts`) добавим **после** первого batch'а
— сейчас нет смысла писать runner без фикстур.

### AC9 (Q13) — sandbox

**Все 3 параметра приняты:**
1. ✅ Separate organization
2. ✅ Retention 7d
3. ✅ Rate-limit 60 req/min

После P0 deploy в БД сделаем `INSERT INTO organizations (name='slai-sandbox', type='external')`
+ `INSERT INTO personal_access_tokens` (с rate-limit + retention отметкой в
`organization_settings`). Token → envelope → S2 в `SLAI_SECRETS_INBOX.md`.

---

## Принято к сведению

### Формат `supportedLineFields` — переведён на `{name, since}` ✅

В `GET /capabilities` теперь:
```jsonc
"supportedLineFields": [
  {"name": "vehicle_plate",  "since": "2026-05-20"},
  {"name": "container_no",   "since": "2026-05-29"},
  ...
]
```
Коммит сегодня, доедет тем же деплоем. Ваш `DocumentMatcher` сможет
feature-gate'ить логику по `since`.

### Self-correction по Q4

Принимаем вашу самокоррекцию по «HMAC vs bearer» — да, ваш ответ исходно был
непонятен, спасибо что переформулировали. Теперь чётко: callback URL + shared
HMAC secret = достаточно.

---

## Что отложено (не блокер пилота)

Из вашего §«Что НЕ блокер»:
- **Multi-document PDF, lossless re-extract, classifier reverse sync, confidence schema semantics** — 4 вопроса из `PARSDOCS_INTEGRATION_REPORT_2026-05-17_EVENING.md §9`. Берём после WW-23 старта. Если хотите — поставим в `INTEGRATION_QUEUE.md` как отдельные Q-блоки для трекинга.

---

## Резюме: action items на ближайшие дни

### Для parsdocs (наш side):

| Кто | Когда | Что |
|-----|-------|-----|
| owner | 30.05 | P0 deploy ROADMAP (API_KEY + workflow_dispatch) |
| owner | 30.05 | Сгенерировать age key, обновить `SLAI_SECRETS_INBOX.md §Recipient public key` |
| claude | после S1 RECEIVED | Расшифровать webhook secret, положить в БД, включить F3 |
| claude | после deploy | Создать sandbox-org + token, envelope в S2 |
| claude | после Q9 batch | Написать `scripts/eval/run-golden.ts` runner и прогнать |

### Для SLAI (ваш side):

| Когда | Что |
|-------|-----|
| 30.05 | PR с envelope `PARSDOCS_WEBHOOK_SECRET` в наш `SLAI_SECRETS_INBOX.md` S1 |
| 02.06 | Включить `INVOICE_POSITION_LEG_SHADOW=true` на demo |
| 02.06-04.06 | PR с golden dataset (13 PDF + 13 `.gt.json`) в `doc-service/test-fixtures/slai-golden/` |

---

## История

- 2026-05-29 утро: EXT-LINE реализован (`42adffc`), наш ответ.
- 2026-05-29 день: followup-нудж по 4 блокерам (`05e5c32`), deadline 2026-06-05.
- 2026-05-29 вечер: SLAI закрывает все 4 в одном письме.
- 2026-05-29 поздний вечер: ← этот файл + `SLAI_SECRETS_INBOX.md` (S1/S2) +
  `doc-service/test-fixtures/slai-golden/README.md` + `/capabilities`
  `{name,since}` формат. Готовы к WW-23.
