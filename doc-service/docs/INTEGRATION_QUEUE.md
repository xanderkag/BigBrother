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

- **Status:** RESOLVED (2026-05-17)
- **Asked:** 2026-05-16
- **From:** CLAUDE
- **To:** USER
- **Что нужно:** Anthropic API key
- **Что сделать когда ключ придёт:**
  1. USER кладёт ключ в env переменную `ANTHROPIC_API_KEY` на своей машине
     (или передаёт Claude напрямую в чате — Claude положит в `.env.local`
     **только локально**, не коммитит)
  2. Claude запускает на сервере подготовку:
     ```bash
     # на kb-docker
     export ANTHROPIC_API_KEY=sk-ant-...
     cd /tmp/vision-test-v2
     pip install anthropic
     # bench-claude.py уже на месте после scp с Desktop
     python3 bench-claude.py --model claude-sonnet-4-7-20260301 --warmup
     ```
  3. Claude прогоняет `python3 compare.py --bench-json results/claude-sonnet-4-7-20260301__claude_api.json --gt-dir gts`
  4. Claude обновляет MODEL_REPORT.md прогон #19 — F1 items, total_match, ИНН, category, **+стоимость на 10 файлов и экстраполяция $/мес для 50 doc/day**
  5. Push в 3 ремоута

**Инфраструктура подготовлена:**
- `Desktop/parsdocs-validation-bench/bench-claude.py` — bench с Anthropic SDK + cache_control (F8) + cost calc
- Использует тот же `SCHEMA_BLOCK` что и bench.py — fair comparison против Gemma/Mistral
- compare.py отрабатывает без изменений на output

#### Question / Context
В проде SLAI пилота используется Claude API (F9 уже переключила default на Sonnet 4.7). Но мы ещё не прогнали Claude на наших 10 синтетических PDF — все baseline'ы только для локальных моделей. **SLAI рекомендует получить отдельный ключ** (не делиться их prod-ключом).

#### Answer (2026-05-17, USER)
Вариант A — генерирую свой ключ сейчас, прогоняем синт тесты.

#### Resolution (2026-05-17, Claude)
- Прогон выполнен через `bench-claude.py` на 10 синтетических PDF
- Модель: `claude-sonnet-4-6` (после фикса фейкового `claude-sonnet-4-7-20260301`)
- Результаты в MODEL_REPORT.md прогон #21:
  - **1.3 мин на 10 файлов** (в 4-9× быстрее локальных топ-моделей)
  - 9/10 valid JSON, items_F1 70%, ИНН 70%, total 50%
  - **Cost: $0.0165/doc → $25/мес для 50 doc/day**
- Найдены 2 issue для prod-tuning (заведены как F14 + F15):
  - F14: prefilled `{` для structured output (10/10 valid JSON)
  - F15: prompt caching boost через boilerplate ($25 → $10/мес)
- `.env.example` исправлен на правильный model_id `claude-sonnet-4-6`
- API key пользователя был использован один раз для прогона, сразу удалён
  из env, в git не попал. **USER должен ротировать ключ в Anthropic Console**
  (попал в чат-историю).

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

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / USER

#### Answer (2026-05-17, Claude/parsdocs)
См. `doc-service/docs/PARSDOCS_Q7_MATCHER_REVIEW.md` (этот же commit).

**Принципиально устраивает.** Их matcher:
- ✅ Правильные сигналы (vehicle.plate primary, ИНН secondary)
- ✅ Threshold-логика лучше нашего предложения: HIGH ≥ 70 + (top ≥ 2× second)
  защищает от ложного auto-attach когда два кандидата равноценны
- ✅ Терминология shipper / consignee / carrier правильнее нашего seller/buyer
- ✅ HMAC verify timing-safe — best practice
- ✅ `target_entity_hint` auto-detect через vehicle.plate — совпало с нашим
  предложением, наш explicit hint в JSON опционален
- ✅ `Document.metadata.matched_fields` для audit — отличная идея

**3 уточнения (не блокеры) к SLAI:**
1. Используется ли `vehicle.driver` ФИО в scoring? Если да — вес? Если нет — добавлять?
2. Учитывается ли `doc.number` против `transportation.reference` / `transfer.documents[].number`?
3. Учитывается ли route (`from_city` / `to_city`) match?

#### Resolution
- Файл `doc-service/docs/PARSDOCS_Q7_MATCHER_REVIEW.md` создан и запушен
- TECH_DEBT.md F13: добавлено явное требование использовать `crypto.timingSafeEqual`
  при имплементации inbound HMAC verify (best practice)
- 3 уточнения зависают как nice-to-have, обсудим на пилоте по
  `Document.metadata.matched_fields` статистике

---

### Q8. 7 open questions по continuous category sync

- **Status:** RESOLVED
- **Asked:** 2026-05-16
- **From:** SLAI_DEV
- **To:** PARSDOCS_DEV / CLAUDE

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
| 2026-05-17 | Q7 RESOLVED — review matcher/HMAC/target_entity_hint, файл `PARSDOCS_Q7_MATCHER_REVIEW.md`. Q8 переведено из ANSWERED в RESOLVED (action plan был выполнен ещё `4087510`). |
| 2026-05-17 | Q1 RESOLVED — прогон Claude Sonnet 4.6 на синт. PDF: $0.0165/doc, F1 70%, 4× быстрее локальных. Найдены F14 (prefilled `{`) и F15 (cache boost). Model_id в `.env.example` исправлен с фейкового `claude-sonnet-4-7-20260301` на реальный `claude-sonnet-4-6`. |
