# parsdocs → SLAI: ответ по line signals (EXT-LINE)

**Дата:** 2026-05-29
**В ответ на:** `parsdocs-request-2026-05-29-COMBINED.md`
**Связано:** `SLAI_INTEGRATION_BACKLOG.md`, `92745ce` (фрахт-фикс 2026-05-20)
**Статус контракта:** `contractVersion='1'` сохранён (additive), `adapterVersion` bump до `2026.05.29`

---

## TL;DR

✅ **Принято целиком, реализовано одним коммитом.** 10 запрошенных полей (6 line + 4 doc-level) добавлены в схему `INVOICE_SCHEMA` / `ITEM_PROPERTIES` сразу — это инструкции для LLM-extract'а, не отдельный код. Никакого разбиения на спринты не нужно: все P0/P1/P2/P3 закрываются вместе.

**Что вы должны знать:** **5 полей из вашего request'а у нас уже есть с 2026-05-20** — `vehicle_plate`, `order_ref`, `route_from`, `route_to`, `trip_date`. Они появились в `92745ce` (фрахт-фикс по INV-2025-104/105/106). То есть из вашего P2 (`route_from`/`route_to`) и базовых полей — **0 работы**, всё работает.

**Реально нового добавлено:**
- 6 line: `container_no`, `bl_no`, `cmr_no`, `ttn_no`, `declaration_no`, `driver_name`
- 4 doc-level: `period_from`, `period_to`, `contract_no`, `contract_date`

---

## Поле-за-полем

### Часть B.1 — line fields

| Поле | Приоритет SLAI | Статус | Коммент |
|---|---|---|---|
| `container_no` | 🔴 P0 | ✅ принято, в схеме (ITEM_PROPERTIES) | Описание учитывает ISO 6346 |
| `bl_no` | 🔴 P0 | ✅ | После «B/L», «Bill of Lading», «коносамент №» |
| `cmr_no` | 🟡 P1 | ✅ | После «CMR №», «накладная CMR» |
| `declaration_no` | 🟡 P1 | ✅ | После «ДТ №», «декларация №», формат `XXXXXXXX/DDMMYY/XXXXXXX` |
| `route_from`, `route_to` | 🟢 P2 | ✅ **уже было с 2026-05-20** (`92745ce`) | Парсятся из `«Маршрут: A → B»` |
| `ttn_no` | 🟢 P2 | ✅ | После «ТТН №», когда контекст внутренней перевозки |
| `driver_name` | ⚪ P3 | ✅ | После «Водитель:», «ФИО водителя:» |
| `vehicle_plate`, `order_ref`, `trip_date` | ⚪ base | ✅ **уже было** | без изменений |

### Часть B.2 — document-level fields

| Поле | Статус | Коммент |
|---|---|---|
| `period_from` | ✅ принято в INVOICE_SCHEMA | Из «Период с … по …» |
| `period_to` | ✅ | |
| `contract_no` | ✅ | Из «по договору №», «на основании договора №» |
| `contract_date` | ✅ | |

---

## Ответы на ваши вопросы (§A.5)

### 1. Сроки

**Готово в коде сегодня же, выкатим следующим деплоем** (зависит от P0 из ROADMAP — нужен `API_KEY` на проде, чтобы запустить `deploy-parsdocs.yml`; не от схемы).

Дни — не недели. Все 10 полей — это extension `ITEM_PROPERTIES` и `INVOICE_SCHEMA` (JSON Schema, который LLM-extract читает как инструкцию). Разбивать на P0/P1/спринты не имеет смысла — добавляем все вместе одним PR.

### 2. Тестовый набор

**Да, нужны.** Просим **10–15 анонимизированных PDF** (имена/ИНН маскировать необязательно — у нас в проде включится `redact_pii` гард + ETL уничтожает после 30 дней):

- 5 морских/мультимодал (для `container_no` + `bl_no`)
- 3 международных авто (для `cmr_no`)
- 3 счёта таможенных брокеров (для `declaration_no`)
- 2 внутренних авто с ТТН (для `ttn_no`)

Способ передачи: scp / Я.Диск / положить в наш репо в `doc-service/test-fixtures/slai-line-signals/`. Любой удобный.

Без них baseline accuracy на P0 (`container_no` ≥80%) подтвердить не сможем — на синтетике не показательно (мы это уже обсуждали для Q9).

### 3. Капабилити

✅ **Сделано в этом же коммите.** `GET /capabilities` теперь возвращает:

```jsonc
{
  "adapter": "parsdocs",
  "adapterVersion": "2026.05.29",          // ← bump
  "contractVersion": "1",                   // ← остаётся
  "supportedLineFields": [                  // ← NEW
    "vehicle_plate", "order_ref", "route_from", "route_to", "trip_date",
    "container_no", "bl_no", "cmr_no", "ttn_no", "declaration_no", "driver_name"
  ],
  "supportedDocFields": [                   // ← NEW
    "period_from", "period_to", "contract_no", "contract_date"
  ],
  "supportedDocumentTypes": [...26 типов],
  ...прочее как было
}
```

Можете дёргать `/capabilities` на старте `ExtractorGateway` и feature-gate'ить вашу логику по `supportedLineFields`.

### 4. Webhook payload size

Подтверждаю: **ограничения по размеру нет.** Контракт HMAC и подпись (`X-Extractor-Signature`/`X-Parsdocs-Signature`/`X-DocService-Signature`) не зависят от размера body. Счёт на 30 строк × 11 line + 4 doc fields ≈ +5–10 KB JSON — несущественно. Webhook delivery timeout 10s (`WEBHOOK_TIMEOUT_MS`) этого хватает с большим запасом.

---

## Что от вас (после деплоя)

1. **Подтвердить структуру `supportedLineFields`** — устраивает плоский array, или хотите `{name, since, doc_types: [...]}` объекты (более extensible на будущее)?
2. **Прислать 10–15 PDF** под AC §B.4 (см. пункт 2 выше).
3. **Завести в shadow-mode** ваш `DocumentMatcher.matchPositionToLeg` после деплоя — мы пришлём webhook'ом первую дюжину extract'ов на demo для замера % auto-pick.

---

## Что НЕ делали (явно, как и просили)

- ❌ Нормализация значений (upper-case, удаление пробелов, валидация форматов) — отдаём как написано.
- ❌ Резолв ваших ID (`transferId`, `legId`, ИНН → SLAI internal IDs) — это бизнес-логика SLAI.
- ❌ Гарантии 100% extract — пороги AC §B.4 (≥80% для P0, ≥70% для P1) реалистичны для нашего OCR/LLM. На AC можем выйти только после §A.5.2 (тестовый набор).
- ❌ Изменения существующих полей (`name`, `qty`, `price`, `vat_*` и т.д.) — без изменений.

---

## Open follow-ups → SLAI

Из `INTEGRATION_QUEUE.md` всё ещё ждут ответа с вашей стороны (повторяю из nudge 2026-05-26):

| Q | Что | Asked |
|---|-----|-------|
| **Q4** | Service-token для parsdocs→SLAI webhook auth | 2026-05-17 |
| **Q5** | ETA пилота с реальными документами | 2026-05-17 |
| **Q9** | Golden dataset (15 PDF + 15 .gt.json) | 2026-05-17 — нужен для AC замера |

Хорошая новость: golden dataset из этого запроса (§A.5.2, 10–15 PDF морских/авто) **частично закроет Q9** — это та самая «реальная выборка», которой нам не хватало.

---

## История

- 2026-05-29: получен `parsdocs-request-2026-05-29-COMBINED.md`. Реализованы все 10 полей одним коммитом (см. ниже коммит ID). `adapterVersion` 2026.05.29, `supportedLineFields[]`/`supportedDocFields[]` в `/capabilities`. Сроки: дни (до следующего деплоя).
