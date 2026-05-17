# parsedocs → SLAI: ответ на ТЗ v1.0 (2026-05-17)

> Ответ на `SLAI_TZ_v1_2026-05-17.md`. По 12 секциям + 8 open questions.
> SLAI зеркалит в `xanderkag/SLAI/docs/`.

---

## 🟢 Сводка

**Принимаем ТЗ как продакт-контракт.** План на 3 фазы (3 месяца) реалистичный.
По API, нормализации, confidence — мы уже сделали бóльшую часть. По типам
документов и spec'ам полей — есть gaps, расписаны ниже.

**Стартовая блокировка снимется** когда придёт golden dataset
(`~/Desktop/SLAI/test-docs/` — нужна копия на нашей стороне).

---

## 1. Что уже готово на нашей стороне

| Требование SLAI | Статус у нас | Где |
|---|---|---|
| `version: "v1"` в webhook + header | ✅ | F8 закрыт, `WebhookPayload` тип |
| `_normalized_fields` (ИНН, plate) | ✅ | F1 закрыт, `normalize/identifiers.ts` + `normalize/extracted-fields.ts` |
| Нормализация ИНН (digits + checksum) | ✅ | F1 — `validateInn` |
| Нормализация госномера (лат→кир, контекст) | ✅ | F1 — `normalizePlate` |
| Нормализация даты ISO | ✅ частично | в LLM-промпте требуем `YYYY-MM-DD` |
| Нормализация денег (float без пробелов) | ✅ | F7 — `recomputeTotalsFromItems` парсит «1 000,50» |
| Валюта ISO 4217 (RUB default) | ✅ | в schema `currency` |
| HMAC SHA256 outbound webhook | ✅ | `webhooks/deliver.ts:createHmac` |
| HMAC SHA256 timing-safe inbound | 🟡 F13 в работе | будет в receiver |
| `redact_pii=true` flag | ✅ | F4 закрыт, `pipeline/normalize/pii-redact.ts` |
| `status: done/needs_review/failed` | ✅ | enum в `jobsRepo` |
| `error.code` machine-readable | ✅ | `ocr_engine_timeout`, `UNSUPPORTED_FORMAT`, etc. |
| Idempotency через `Idempotency-Key` | ✅ | I1 закрыт |
| Webhook retry exponential backoff | ✅ | A4 закрыт, sweeper до 15 attempts |
| Rate limit per token | ✅ | I5 закрыт, `RATE_LIMIT_PER_MINUTE=200` |

## 2. Gap-анализ — чего нет / что не совпадает

### 2.1 Типы документов

| SLAI ТЗ требует | У нас | Долг |
|---|---|---|
| `invoice` | ✅ | — |
| `transport_request` (заявка на перевозку) | ❌ | **F16** — новый тип |
| `ttn` (форма 1-Т) | `TTN` (нужен синк нейминга на lower) | F22 — наименование slugs |
| `transport_invoice` (новая ТН, 2013) | ❌ | **F17** — новый тип |
| `cmr` | `CMR` | F22 |
| `waybill` (путевой лист) | ❌ | **F18** — новый тип |
| `upd` | `UPD` | F22 |
| `services_act` | `AKT` | F22 — нейминг |
| `tax_invoice` (счёт-фактура) | `factInvoice` | F22 — нейминг |
| `payment_order` | ✅ | — |

**Решение по неймингу slug'ов:**

Мы предлагаем **поддержать оба варианта** в API (наш `UPD` и их `upd`) через
case-insensitive lookup в `documentTypeResolver`. Внутри БД остаётся наш
исторический slug (нет миграции данных), наружу выдаём оба и принимаем оба.
**F22** — 1 час работы.

### 2.2 Поля invoice — gap

Их JSON требует, нашего нет:

```json
"seller": {
  "bank": "Банк «ФК Открытие»",
  "bik": "044525297",
  "account": "40702810100000888777",
  "corr_account": "30101810300000000297",
  "phone": "+78632187799"
}
```

У нас в invoice extract'е есть `seller.bank_account` через
`payment_order` тип — но не на invoice. **F19** — расширить invoice schema
банковскими реквизитами (1 день — миграция llm_schema + few-shot
примеры в SYSTEM_PROMPT). Получим как побочный эффект:
после F19 invoice будет содержать платёжные реквизиты — SLAI matcher
сможет проверить «это тот же поставщик с тем же расчётным счётом».

### 2.3 Per-field confidence (`_field_confidence`)

Их требование: confidence на каждом извлечённом поле (минимум на критичных
для acceptance). У нас сейчас один общий `confidence`.

**F2** уже в roadmap — теперь **приоритет high**, обещаем ETA **5-7 дней**.

Реализация:
- В extract-prompt просим модель указать `_field_confidence` per ключ
- Калибровка через regression на golden dataset (если модель говорит 0.9,
  а на ground-truth попадает в 60% — корректируем вниз)
- Для regex-парсеров — derive от «primary regex match vs fallback»

### 2.4 Multi-document PDF

Их требование (Q1 из 8 open questions): один PDF со счётом+УПД+СФ —
разделять?

**F5** в roadmap, 14 дней. До этого SLAI делит PDF на странице у себя
и шлёт N отдельных job'ов (workaround).

---

## 3. Ответы на 8 open questions (раздел 9 SLAI ТЗ)

### Q1. Multi-document PDF

**Ответ:** в roadmap, **14 дней** (наш долг F5).

До этого — workaround на SLAI стороне: разделять PDF на отдельные страницы/
группы страниц и слать N отдельных job'ов. Когда F5 будет готов — API
расширится с `extracted: {...}` (single) до **`documents: Array<{extracted, page_range, document_type, confidence}>`** (multi).
Version bump до `v2` будет за месяц до релиза с preview header.

### Q2. Версионирование контракта

**Принимаем правило:**
- **Добавление поля** (новые ключи в `extracted` / `_normalized_fields`) = **backward-compatible**, остаётся `version: "v1"`. Receiver должен игнорировать неизвестные поля
- **Переименование / удаление / изменение семантики** = breaking, поднимаем `version: "v2"`
- За **1 месяц** до релиза v2 поднимаем поддержку обоих версий параллельно (`version: "v1"` или `"v2"` на выбор клиента через флаг)
- Старая версия v1 живёт **≥ 6 месяцев** после релиза v2

### Q3. Retry конкретного job_id

**Сейчас:** `POST /jobs` с тем же `Idempotency-Key` возвращает существующий job (не пересчитывает).

**Запрос SLAI** — пересчитать с другим промптом. У нас есть **`POST /jobs/:id/reprocess`** (есть в коде, `routes/jobs.ts`) — это сразу запускает заново через worker pipeline. Подходит.

Дополнительно есть **`POST /jobs/:id/redeliver-webhook`** — пересылает результат не пересчитывая (для тестов на стороне SLAI).

Если SLAI хочет **«retry с другим промптом»** — то правильный flow:
1. Изменить `provider_settings` UI / `document_type.llm_prompt` UI
2. `POST /jobs/:id/reprocess` — обработка пойдёт с новым промптом

**Совсем кастомный prompt только под один job** (без правки document_type) — это **новый долг F20** (2 дня): добавить `metadata.prompt_override_one_shot` который reprocess читает и применяет один раз. Сделаем если SLAI явно запросит.

### Q4. OCR-only режим

**Есть.** В `POST /jobs` передать `document_hint: "raw_ocr"` или `parser_kind: "passthrough"` (через kind setting в provider) — пайплайн пропустит классификатор + extract, вернёт только raw OCR через `extracted: { raw_text: "..." }`.

**Альтернатива:** `GET /jobs/:id/raw-text` (TODO — есть ли уже? проверить, F21).

Это новый долг **F21** — гарантировать что endpoint существует и доступен `GET /api/v1/jobs/:id/raw-text` с тем же auth.

### Q5. Шрифты и языки

**Сейчас:** Tesseract OCR в Docker-образе с языками **rus + eng**. См. `doc-service/Dockerfile`:
```
RUN apt-get install ... tesseract-ocr-rus tesseract-ocr-eng ...
```

**Что добавить:**

| Язык | Долг | Срок |
|---|---|---|
| Китайский упрощённый (Aliexpress packing list) | **F23** | 1 час (`tesseract-ocr-chi-sim` пакет в Dockerfile) |
| Турецкий (импорт Турции) | F24 | 1 час (`tesseract-ocr-tur`) |
| Польский (Восточная Европа) | F25 | 1 час |

**Можем ли отключить китайский в пилоте:** да, по умолчанию `TESSERACT_LANGS=rus+eng` в `.env`. Если на конкретном job нужен китайский — `metadata.tesseract_langs: "rus+eng+chi_sim"` (это уже работает через config — F26 если хотим явный API-param).

**LLM-сторона** — Claude/Gemma и так понимают китайский, без доп-настройки.

### Q6. Rate limit per token

**Текущий:** `RATE_LIMIT_PER_MINUTE=200` (default). Per-API-key, fallback на IP. Можно поменять через env.

**Для SLAI service-token предлагаем 600 req/min** (10/sec) — с запасом 10× от ожидаемого пика (60 doc/min throughput цель). Если упрётесь на bulk-импорте — поднимем индивидуально.

### Q7. Длительные обработки

**Webhook прилетит когда готов**, **независимо** от длительности (timeout у нас на side WORKER, 4 часа `JOB_MAX_AGE_SECONDS`).

**Polling доступен через `GET /api/v1/jobs/:id`** — возвращает текущий статус (queued / processing / done / failed) + если done — extracted. Используйте при желании, но webhook надёжнее.

**При краше worker'а** (если он перезапустится в момент обработки) — pending-sweeper подберёт job через 60 сек и переотправит в очередь. Webhook прилетит когда обработка завершится.

### Q8. Storage retention

**Текущий:** `FILE_RETENTION_DAYS=30` в `.env`. После 30 дней file-cleanup-sweeper:
- Удаляет PDF с диска
- `NULL`-ит `jobs.file_path`
- БД-row остаётся (для audit / повторного отображения мета-данных)

**`redact_pii=true`** на текущий момент **НЕ удаляет файл** — только редактирует extracted JSON перед webhook'ом. Оригинал PDF лежит на диске 30 дней (для аудита, replay через `/jobs/:id/reprocess`).

**Если нужно "удалить сразу после обработки"** — это **F27** (1 день): `metadata.delete_after_processing: true` → file-cleanup триггерится сразу после `status='done'`, БД-row сохраняется без `file_path`.

Подходит как опция? Если да — добавим в roadmap.

---

## 4. Gap-анализ acceptance критериев

| Тип | SLAI порог | Что мы знаем по нашим бенчам |
|---|---|---|
| invoice critical | ≥ 95% | На синтетике (corpus-gt v2): Claude #22 — 80% ИНН, 100% number/date. **Gap по ИНН** — нужно тюнить prompt с few-shot |
| invoice items[*] | ≥ 80% | Claude #22 — F1=80% на синтетике. **Ок** на синт, проверять на real |
| invoice bank/bik/account | ≥ 80% | **Не извлекаем сейчас** — F19 закрывает |
| transport_request critical | ≥ 90% | **НЕ извлекаем сейчас** — F16 закрывает |
| ttn critical | ≥ 95% | Близко — синтетика показывает 80% ИНН, **нужен real-corpus тюн** |
| Per-field confidence на критичных | 100% | **Не реализовано** — F2 закрывает |

**Итого: на реальном golden dataset (когда придёт) мы прогоним baseline,
после ему сразу делаем F2 + F19 + F16 → подходим под acceptance.**

---

## 5. Запрос golden dataset

**Нам нужна копия `~/Desktop/SLAI/test-docs/`** — 15 PDF + 15 .gt.json
из directories `invoices/`, `requests/`, `ttns/`.

Варианты передачи (по убыванию удобства):

1. **scp** на наш staging:
   ```
   scp -r ~/Desktop/SLAI/test-docs/ kb-docker:/home/lyapustin.a/slai-golden-2026-05-17/
   ```
2. **zip + Yandex.Disk / Mega** — линк на 7 дней
3. **Положить в наш репо** под `doc-service/test-corpus/slai-golden-v1/`
   (если в PDF нет реальных PII — иначе только через защищённый канал)

Кратчайший путь к baseline бенчу: вариант (1) — у нас уже есть SSH-доступ.

После получения **мы за 1 день** даём:
- `bench-claude.py` прогон на 15 PDF
- `compare.py` сравнение с .gt.json
- Полную таблицу accuracy per type + per field
- Список всех несовпадений с точными значениями (для тюна prompt'а)

---

## 6. Сводка новых долгов в TECH_DEBT.md

| # | Долг | Срок | Приоритет | Зависит от |
|---|---|---|---|---|
| **F16** | Новый тип `transport_request` (заявка на перевозку) | 3-5 дней | high | golden dataset |
| **F17** | Новый тип `transport_invoice` (ТН формы 2013) | 2-3 дня | medium | F16 опыт |
| **F18** | Новый тип `waybill` (путевой лист) | 2 дня | medium | F16 |
| **F19** | Bank-реквизиты в invoice schema | 1 день | high | golden dataset |
| **F20** | One-shot prompt override через metadata (опционально) | 2 дня | low | SLAI запрос |
| **F21** | `GET /jobs/:id/raw-text` endpoint | 0.5 дня | medium | — |
| **F22** | Case-insensitive document_type lookup (slugs sync) | 1 час | low | — |
| **F23** | Tesseract китайский упрощённый | 1 час | low | Фаза 2 ВЭД |
| **F24** | Tesseract турецкий | 1 час | low | Фаза 2 |
| **F25** | Tesseract польский | 1 час | low | Фаза 2 |
| **F26** | `metadata.tesseract_langs` API-param (опционально) | 2 часа | low | F23-F25 |
| **F27** | `metadata.delete_after_processing` flag | 1 день | low | SLAI запрос |

**Итого новых долгов: 12.** Все НЕ блокируют MVP на типах invoice / ttn / payment_order.

---

## 7. Распределение работы по фазам

### Фаза 1 — Неделя 1 (старт после golden dataset)

| День | Что |
|---|---|
| 1 | Получить golden dataset, прогнать Claude baseline на 15 PDF, опубликовать MODEL_REPORT прогон #23 |
| 2-3 | Тюнинг extract-prompt под их формат (bank-реквизиты, новые поля). F19 |
| 4-5 | F2 per-field confidence — приоритет high (ETA SLAI просит на 7 дней) |
| **Итог недели** | invoice acceptance ≥ 95% на golden + per-field confidence в API |

### Фаза 1 — Неделя 2-3

| Неделя | Что |
|---|---|
| 2 | F16 `transport_request` — новый тип, schema + classifier keywords + LLM-prompt + 5 golden = acceptance ≥ 90% |
| 3 | TTN — текущий `TTN` тип тюним под их формат (форма 1-Т), F22 sync slug, acceptance ≥ 95% |

### Фаза 1 — Недели 4-11

| Неделя | Тип | Долг |
|---|---|---|
| 4 | `transport_invoice` | F17 |
| 5 | `cmr` | (есть, тюним) |
| 6 | `waybill` | F18 |
| 7-8 | `upd` | (есть, тюним) |
| 9 | `services_act` | (синк нейминг с `AKT`) |
| 10 | `tax_invoice` | (синк с `factInvoice`) |
| 11 | `payment_order` | ✅ есть |

### Фаза 2 — недели 12-16 (ВЭД)

Запускаем после Фазы 1. F23+F24+F25 (Tesseract языки) — добавляем в начале фазы 2.

---

## 8. Что нам нужно от SLAI

1. **Golden dataset копия** (см. секцию 5) — критично для старта
2. **HMAC secret + service-token** — Q4 в `INTEGRATION_QUEUE.md`, ждём команды USER
3. **Подтверждение по Q3** — нужен ли F20 (one-shot prompt override)?
4. **Подтверждение по Q8** — нужен ли F27 (`delete_after_processing`)?
5. **Hist категорий номенклатуры** — Q8 в очереди, отложено до prod-деплоя SLAI

---

## 9. Что не делаем (по разделу 11 ТЗ)

Согласны с разделением:
- ❌ Matcher (привязка к Transportation/Transfer) — у SLAI
- ❌ Управление справочниками (компании, машины, водители) — у SLAI
- ❌ UI оператора — у SLAI
- ❌ Workflow / статусы документов — у SLAI
- ❌ Биллинг клиентов SLAI — у SLAI

**Мы =** pure parser + structured JSON.

---

## История переписки

| Файл | От | Когда |
|---|---|---|
| SLAI_QUESTIONS.md | parsedocs | 2026-05-16 |
| SLAI_ANSWERS.md | SLAI | 2026-05-16 |
| SLAI_OUR_REPLY.md | parsedocs | 2026-05-16 |
| SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md | SLAI | 2026-05-16 |
| PARSDOCS_CATEGORY_SYNC_REPLY.md | parsedocs | 2026-05-16 |
| SLAI_REPLY_v2.md | SLAI | 2026-05-16 |
| PARSDOCS_Q7_MATCHER_REVIEW.md | parsedocs | 2026-05-17 |
| **SLAI_TZ_v1_2026-05-17.md** | **SLAI** | **2026-05-17** |
| **PARSDOCS_REPLY_TO_SLAI_TZ.md** (этот) | **parsedocs** | **2026-05-17** |
