# Integration Queue — parsedocs ↔ SLAI

> **Очередь нерешённых вопросов и pending-задач интеграции.**
> При работе над parsedocs Claude **читает этот файл в начале сессии**,
> ищет блоки со статусом `ANSWERED` (есть ответ — надо что-то сделать) или
> `OPEN` (ждём ответ).
>
> Файл живёт в git → синхронизация между машинами и сторонами автоматическая
> (через `git pull`). SLAI зеркалит копию в `xanderkag/SLAI/docs/PARSDOCS_QUEUE.md`.

---

## Convention

Каждый вопрос — отдельный блок `### Q{N}. ...` со структурой:

```
### Q{N}. <короткое название>

- **Status:** `OPEN` | `ANSWERED` | `RESOLVED`
- **Asked:** YYYY-MM-DD
- **From:** USER | SLAI_DEV | CLAUDE | PARSDOCS_DEV
- **To:** USER | SLAI_DEV | CLAUDE | PARSDOCS_DEV
- **Что нужно:** короткое описание
- **Что сделать когда ответят:** action plan

#### Question / Context
<свободный текст>

#### Answer
<ответ когда придёт — Status переходит в ANSWERED>

#### Resolution
<что сделано + ссылка на commit — Status переходит в RESOLVED>
```

### Действия Claude по статусам

| Status | Что делать |
|---|---|
| `OPEN` (To: USER) | Напомнить пользователю в чате что вопрос ждёт ответа |
| `OPEN` (To: SLAI_DEV) | Если уже неделя — спросить пользователя, может стоит напомнить |
| `OPEN` (To: CLAUDE) | TODO для Claude — выполнить когда подходящая сессия |
| `ANSWERED` | **Обработать**: выполнить action plan, commit + push, перевести в RESOLVED |
| `RESOLVED` | Ничего; можно вычистить если старше 2 недель → переезжает в `INTEGRATION_LOG.md` |

---

## Active Questions

### Q1. ANTHROPIC_API_KEY для F11 baseline bench

- **Status:** OPEN
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Anthropic API key чтобы прогнать Claude Sonnet 4.7 на corpus-gt и получить production baseline вместо Gemma 12B
- **Что сделать когда ответят:**
  1. Положить в provider_settings (через UI или env) на staging
  2. Адаптировать bench.py чтобы вызывать через inference-service вместо прямо Ollama
  3. Прогнать `bench.py --model claude-sonnet-4-7-20260301 --mode text` через inference
  4. Сравнить через compare.py — ожидаем F1 items ≥ 0.85, total ≥ 0.7
  5. Обновить MODEL_REPORT.md прогон #19
  6. Push в 3 ремоута

#### Question / Context
В проде SLAI пилота используется Claude API (F9 уже переключила default на Sonnet 4.7). Но мы ещё не прогнали Claude на наших 10 синтетических PDF — все baseline'ы только для локальных моделей. **SLAI рекомендует получить отдельный ключ** (не делиться их prod-ключом) — это вопрос продактов обеих сторон.

#### Answer
<ждём>

---

### Q4. Service-token для SLAI side

- **Status:** OPEN
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Решение когда генерить и передать SLAI dev сервис-токен (`API_KEYS_JSON`) для аутентификации их вызовов к нам
- **Что сделать когда ответят:**
  1. Сгенерить ключ через `openssl rand -hex 32`, добавить в `API_KEYS_JSON={"<key>":"slai"}` на staging
  2. Сгенерить также `SLAI_TO_PARSDOCS_HMAC_SECRET` для подписи их webhook'ов к нам (см. Q6 ответ 5)
  3. Отправить SLAI через защищённый канал (1Password / signal / encrypted email)
  4. Зафиксировать дату ротации (через 6 месяцев)

#### Question / Context
SLAI ответил (SLAI_REPLY_v2.md): «Сейчас в дев-фазе токен не нужен. Когда продакт скажет деплоим — сгенерим вам сразу через openssl rand -hex 32. Передам через 1Password / secure channel.»

То есть **они тоже ждут команды от продакта**. Q4 зависит от Q5 ETA.

#### Answer
<ждём ETA от продакта>

---

### Q5. ETA пилота с реальными документами

- **Status:** OPEN
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Когда планируется развернуть всё и начать получать реальные PDF от логистов
- **Что сделать когда ответят:**
  - **Сегодня-неделя** → F11 + F12 + F13 (cost tracking + dedupe + sync receiver)
  - **2-3 недели** → + F5 (multi-doc PDF) + F2 (per-field confidence)
  - **Месяц+** → широкий пакет + пересмотр моделей через bench

#### Question / Context
SLAI оценили (Q5 в их `SLAI_REPLY_v2.md`): **2-3 недели**, с распределением:
- Неделя 1: наш M3.4 + M3.5 (multi-doc + per-field confidence) + их TypeORM realtime sync
- Неделя 2: интеграционный smoke на обоих staging
- Неделя 3: 1-2 логиста пилот на прод

«Финальное решение за продактом SLAI.» **Ждём подтверждения.**

#### Answer
<ждём>

---

### Q7. Подтверждение что наш implementation matcher / target_entity_hint / HMAC verify подходит под SLAI видение

- **Status:** ANSWERED
- **Asked:** 2026-05-16
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / USER
- **Что нужно:** Проверить реализованные SLAI элементы (matcher scoring +50/+30/+25/+15/+10/+5, HMAC verify timing-safe, `target_entity_hint` auto-detect через vehicle.plate) и подтвердить совпадение с нашим видением
- **Что сделать когда обработаем:**
  1. Прочитать [match-transportation-for-document.tool.ts](https://github.com/xanderkag/SLAI-backend/blob/master/src/modules/core/api/routes/ai/tools/match-transportation-for-document.tool.ts)
  2. Прочитать [parsdocs-integration.service.ts](https://github.com/xanderkag/SLAI-backend/blob/master/src/modules/core/api/routes/parsdocs/parsdocs-integration.service.ts)
  3. Сравнить с нашим документом `SLAI_OUR_REPLY.md` (раздел про scoring) и `SLAI_QUESTIONS.md`
  4. Если расхождения — записать в ANSWER и предложить SLAI правки

#### Question / Context
SLAI реализовали 3 коммита:
- `65f731c`: M2 skeleton — webhook receiver + nomenclature hist + sync stub
- `be23aa6`: M3.1 — DocPlatformProcessor + match_transportation_for_document AI tool
- `3545380`: M3.2 — propose_document_attachment + attach_document executor

Scoring у них:
- vehicle.plate exact match Transfer → +50
- carrier.inn в любой стороне → +30
- shipper.inn / buyer.inn → +25 каждый
- date ±7d → +15
- amount ±5% → +10
- not closed/archive → +5

Threshold: HIGH ≥ 70, MEDIUM 40-69, LOW < 40. auto_pick = top HIGH + (top.score ≥ 2× second.score).

#### Answer
<нужен read-через и сравнение с нашим SLAI_OUR_REPLY.md — TODO для Claude>

---

### Q8. 7 open questions по continuous category sync

- **Status:** ANSWERED
- **Asked:** 2026-05-16
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / CLAUDE
- **Что нужно:** Ответы на 7 вопросов из их `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md` — без них они не подключат TypeORM realtime hooks
- **Что сделать когда обработаем:**
  1. Составить файл-ответ `docs/PARSDOCS_CATEGORY_SYNC_REPLY.md` в git
  2. Параллельно создать F13 (новый долг) — webhook receiver `POST /api/v1/integrations/slai/sync/nomenclature` + snapshot variant
  3. Поднять storage для lookup-table `slai_category_id → our_category_hint`
  4. Push в 3 ремоута
  5. SLAI зеркалит ответ

#### Question / Context
Они переходят от разового hist'а на непрерывный bidirectional sync. Цель — чтобы через 6 месяцев когда логисты добавят 30 новых типов груза, parsdocs не отстал.

**Архитектура:** realtime webhook (debounce 10 сек, event-driven) + nightly full snapshot (safety net).

**7 вопросов от них:**
1. Есть ли уже у нас webhook receiver / какой URL?
2. Какой объём готовы переваривать?
3. Как parsdocs реагирует на изменения (lookup-table / retrain / просто лог)?
4. Format snapshot их JSON ок?
5. HMAC secret — единый или отдельный?
6. Versioning header vs URL?
7. Failure handling — retry+queue или fire-and-forget?

#### Answer (2026-05-16, Claude/parsdocs)
См. `doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md` (этот же commit). Сжато:
1. **Нет существующего receiver**, поднимаем новый `POST /api/v1/integrations/slai/sync/nomenclature` (events) + `/snapshot` (daily). На staging — `https://parsedocs.taipit.ru/...`
2. 50-100 webhooks/day + 1 snapshot/day = ~150 запросов/день — **комфортно**, никаких лимитов не нужно ставить
3. **Lookup-table** в Redis с TTL 24ч (back-up в Postgres `slai_category_map`). Никакого retrain — наш classifier rule-based (keyword-mapper)
4. **Их JSON ок**, не переизобретаем
5. **2 отдельных HMAC секрета**: `PARSDOCS_TO_SLAI_HMAC_SECRET` (наши webhook'и) и `SLAI_TO_PARSDOCS_HMAC_SECRET` (их sync). Разные ротации — независимо
6. **Header `X-SLAI-Version: v1`** — да, в URL не надо
7. **Retry с backoff** на их стороне (3 попытки), мы дополнительно записываем failed events в `sync_inbox` для повторной обработки. Snapshot — safety net на случай потери events

#### Resolution
- Файл-ответ `doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md` создан и запушен
- Новый долг F13 в `TECH_DEBT.md`: webhook receiver + lookup-table + snapshot обработчик (5-7 дней работы)
- Ждём подтверждения SLAI что наши 7 ответов их устраивают → потом стартуют TypeORM hooks

---

## Resolved Questions (последние 7 дней)

### Q2. SLAI ответ на наш SLAI_OUR_REPLY.md

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** SLAI_DEV

#### Answer (2026-05-16, SLAI_DEV)
См. `SLAI_REPLY_v2.md` (xanderkag/SLAI commit `296b2b9f`, docs/PARSDOCS_REPLY_v2_2026-05-16.md). Сжато:
- **Все 14 [ПРОДУКТ]-решений приняты** ✅
- **Все 6 наших ответов приняты**, причём 4 из них уже реализованы в коде SLAI:
  - `target_entity_hint` в matcher (auto-detect через vehicle.plate)
  - HMAC verify (timing-safe)
  - `redact_pii: true` flag в DocPlatformProcessor
  - matcher scoring (+50/+30/+25/+15/+10/+5)
- 2 ждут нашей доставки:
  - multi-doc PDF (`documents: Array<>` типы готовы, активируют когда мы запустим F5)
  - per-field confidence (типы готовы `_field_confidence`, добавят в matcher в M3.3 когда мы запустим F2)

#### Resolution
- Q2 закрыт. Все принципиальные продуктовые расхождения сняты — переходим к технической имплементации
- Q7 (новый) — нужно прочитать их код matcher/HMAC и подтвердить детали реализации (TODO для Claude)
- Q8 (новый) — 7 вопросов по category sync, ответы в этом же commit'е

---

### Q3. Hist категорий номенклатуры

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** SLAI_DEV

#### Answer (2026-05-16, SLAI_DEV)
Endpoint **`GET /api/v1/admin/nomenclature/hist`** уже реализован (SLAI commit `65f731c`). SQL и формат описаны в `SLAI_REPLY_v2.md` раздел Q3.

**Реальные данные — после деплоя SLAI на prod** (на дев-стенде синтетика, отдавать смысла нет).

**Workflow после деплоя:** admin прогоняет `curl` → кладёт `slai_hist.json` в общую папку → parsdocs Claude подгружает и сравнивает с нашими 17 категориями → обновляет keyword-mapper в `categories.ts` → push в 3 ремоута.

#### Resolution
- Q3 закрыт принципиально (механизм согласован)
- Реальная синхронизация будет через Q8 механизм (continuous sync), а разовый hist остаётся как fallback
- На дев пока не нужен, ждём prod-деплой

---

### Q0. (пример формата) Sonnet vs Opus как production default

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER

#### Answer (2026-05-16, USER)
Sonnet. Опус только если будут провалы качества на пилоте.

#### Resolution (2026-05-16, Claude)
F9 — изменено в `inference-service/.env.example`:
`ANTHROPIC_MODEL_ID=claude-sonnet-4-7-20260301`. Commit `e8f3f6f`.
Через provider_settings UI пользователь может переключить на Opus для отдельных типов документов.

---

## История изменений этого файла

| Дата | Действие |
|---|---|
| 2026-05-16 | Файл создан как `Desktop\OPEN_QUESTIONS.md`. 5 active questions: Q1-Q5. |
| 2026-05-16 | Переехал в git: `doc-service/docs/INTEGRATION_QUEUE.md` (рекомендация SLAI A vs B). Q2, Q3 RESOLVED. Добавлены Q7, Q8 от SLAI. |
