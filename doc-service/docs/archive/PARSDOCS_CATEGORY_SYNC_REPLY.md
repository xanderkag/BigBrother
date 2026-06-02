# parsedocs → SLAI: ответ на 7 open questions по continuous category sync (2026-05-16)

> Ответ на ваш `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md`. Зеркало этого файла
> ждём от вас в `xanderkag/SLAI/docs/`.

---

## Сводка

**Принимаем вашу архитектуру целиком:** realtime webhook (debounce 10s) +
nightly snapshot (safety net) + manual trigger в admin UI.

**Что делаем у себя** — новый долг **F13** в TECH_DEBT.md:
- Webhook receiver `POST /api/v1/integrations/slai/sync/nomenclature` (events)
- Webhook receiver `POST /api/v1/integrations/slai/sync/nomenclature/snapshot` (daily)
- Lookup-table `slai_category_id → our category_hint` (Redis cache + Postgres backup)
- `sync_inbox` для failed events (retry queue)
- HMAC verify через ваш `SLAI_TO_PARSDOCS_HMAC_SECRET`

**Срок реализации на нашей стороне:** 5-7 дней после согласования этого
документа. Параллельно вы можете стартовать receiver + hist endpoint —
они уже у вас в `65f731c` (M2 skeleton).

---

## Ответы на 7 open questions

### 1. Есть ли уже receiver / какой URL

**Сейчас нет.** Поднимаем новый endpoint:

| Окружение | URL |
|---|---|
| Staging | `https://parsedocs.taipit.ru/api/v1/integrations/slai/sync/nomenclature` |
| Production | то же (один инстанс пока) |
| Local dev | `http://localhost:3000/api/v1/integrations/slai/sync/nomenclature` |

Snapshot variant: `/api/v1/integrations/slai/sync/nomenclature/snapshot`.

Аутентификация:
- `Authorization: Bearer <SLAI_SERVICE_TOKEN>` (Named API key из нашего `API_KEYS_JSON`)
- + `X-SLAI-Signature: sha256=...` (HMAC, см. ответ 5)
- + `X-SLAI-Version: v1`

Оба endpoint'а:
- 200 на успех → возвращаем `{ "ok": true, "processed_at": ISO }`
- 4xx если signature не сходится / version неизвестна / payload невалиден
- 5xx если у нас внутренняя ошибка → ждём retry с вашей стороны

### 2. Какой объём готовы переваривать

**Реалистичный сценарий приемлем:**
- 50-100 webhook events/day = ~1 event каждые 15 минут в среднем
- 1 snapshot/day ~50KB JSON

Никакие лимиты ставить не нужно. Запас по производительности 10×.

**При burst (массовый импорт логистов 500 events за минуту):**
- Ваш debounce 10 сек батчит это в ~6 webhook'ов — мы переварим
- Если у вас debounce проскочит — мы сами поставим rate-limit на endpoint
  (default `RATE_LIMIT_PER_MINUTE=200` уже есть, можем поднять/опустить
  per-service-token)

### 3. Как parsdocs реагирует на изменения

**Уровень MVP — простая lookup-table:**

```
parsdocs Redis:
  slai_category:{slai_category_id} → { name, our_hint, updated_at }
  slai_category_by_name:{name} → slai_category_id

При новом extract'е:
  1. Наш keyword-mapper определяет our_category_hint ("metal", "fuel", ...)
  2. Если в Redis есть slai_category_by_name с похожим name → берём оттуда
  3. Иначе — fallback на keyword-mapper результат
```

**Никакого retrain не нужно** — наш классификатор rule-based
(keyword-mapper в `src/pipeline/normalize/categories.ts`). Изменение
ключевых слов — это просто обновление JSON-таблицы, без перезапуска
сервиса.

**Если в snapshot прилетит новая категория которой нет в нашем list:**
- Не падаем
- Логируем `warn: unknown SLAI category code <code> — adding to lookup as-is`
- Кладём в Redis с `our_hint = 'other'`
- Раз в неделю operator смотрит лог и решает добавить новые keyword'ы
  в `categories.ts`

**Что НЕ делаем (по сравнению с retrain):**
- Не переименовываем категории автоматически по `category.renamed` event —
  только обновляем display-name в lookup. Семантика категории `metal`
  остаётся `metal`, даже если SLAI переименовал на «Прокат и метизы»
- Не удаляем категории по `category.deleted` event — только помечаем
  `active: false` в lookup. Старые extracted документы могут ссылаться
  на удалённую категорию, потеря данных недопустима

### 4. Format snapshot

**Ваш JSON — отлично, не переизобретаем.**

Только два уточнения:

**4a.** `category_hist_30d` поле — добавьте сюда `subcategory_id` если
доступно (некоторые наши категории на их side могут жить на 2-м уровне
NomenclatureSubCategory):
```json
"category_hist_30d": [
  { "code": "metal", "subcategory_code": "steel_rolled", "count": 1240 },
  { "code": "metal", "subcategory_code": null, "count": 320 }
]
```
Если у вас только 1-уровневая иерархия — пропускайте поле.

**4b.** Add `version` в body:
```json
{
  "version": "v1",
  "event": "snapshot",
  ...
}
```
Дублируется с header'ом — на случай middleware которые header'ы режут.

### 5. HMAC secret — **2 отдельных**

| Direction | Secret env var | Стороны |
|---|---|---|
| parsdocs → SLAI (наши webhook'и с distress JSON) | `PARSDOCS_TO_SLAI_HMAC_SECRET` | сейчас уже `WEBHOOK_HMAC_SECRET` в нашем .env |
| SLAI → parsdocs (ваши category sync events) | `SLAI_TO_PARSDOCS_HMAC_SECRET` | новый, поставим на момент F13 |

**Зачем 2:** независимая ротация. Если кто-то скомпрометировал один —
не нужно менять и второй. Также проще аудит: «откуда пришёл webhook»
видно сразу по тому какой secret подошёл.

Генерим оба через `openssl rand -hex 32`. Обмен — через 1Password / signal.

### 6. Versioning — header

`X-SLAI-Version: v1` хорошо. В URL не надо — добавит сложность routing'а
без выгоды.

**Контракт version bump:**
- `v1.x` — обратно-совместимые добавления полей (мы игнорируем неизвестные)
- `v2` — breaking changes; за месяц до релиза мы поднимаем поддержку обоих
  параллельно, оператор переключается через flag

### 7. Failure handling — **retry с backoff + queue, ваша + наша**

**На вашей стороне:**
- 3 попытки с экспоненциальным backoff: 1с → 5с → 30с
- Если все 3 fail — записать в `SyncFailedQueue` для manual recovery
- Hint в админ UI: «N failed events; replay all?»

**На нашей стороне (defense in depth):**
- Принятый event пишем в `sync_inbox` (Postgres) **до** обработки —
  чтобы при крэше обработчика событие не потерялось
- Background sweeper читает `sync_inbox` и применяет изменения к
  lookup-table (Redis + Postgres)
- При application crash в момент `INSERT` в `sync_inbox` — вы получите
  HTTP 5xx и сделаете retry. Идемпотентность через `event_id` (см. ниже)

**Идемпотентность:**
- Добавьте в каждый event поле `event_id: <ulid>` (или ваш timestamp+counter)
- Мы кладём в `sync_inbox` с UNIQUE на event_id
- Если приходит дубль — отвечаем 200 без обработки (idempotent replay safe)

**Snapshot — safety net:**
- Каждое утро (после вашего 03:00 UTC snapshot) мы делаем reconcile:
  сравниваем нашу lookup-table со snapshot, при расхождениях — обновляем
  по snapshot'у
- Это закрывает кейс «потерялся один event между retry'ями»

---

## Что нам от вас остаётся

После согласования этого ответа:

1. **HMAC secret** `SLAI_TO_PARSDOCS_HMAC_SECRET` — генерим вместе перед F13 имплементацией
2. **Стартовый snapshot** для bootstrap — после деплоя SLAI вы прогоняете
   `POST /admin/nomenclature/snapshot` принудительно один раз, мы создаём
   полную lookup-table
3. **Список known event types** окончательный (мы предполагаем 6 типов
   из вашего note: `category.added/renamed/deleted` +
   `nomenclature.added/changed/deleted`). Если будут другие — добавим
   обработчики

---

## Что мы делаем на нашей стороне (новый долг F13)

| Артефакт | Срок | Зависит от |
|---|---|---|
| `routes/integrations/slai-sync.ts` — receiver endpoints | 1 день | — |
| HMAC verify middleware (timing-safe, переиспользуем `crypto.createHmac`) | 0.5 дня | — |
| Миграция `slai_category_map` table | 0.5 дня | — |
| `storage/slai-categories.ts` — Redis cache + Postgres backup | 1 день | миграция |
| `sync_inbox` table + sweeper | 1 день | — |
| Snapshot reconciler (cron 04:00 UTC, через час после вашего snapshot'а) | 1 день | snapshot endpoint |
| Интеграция в `applyCategoryHints` в orchestrator — читать из lookup-table | 0.5 дня | storage |
| Unit-тесты | 1 день | всё выше |
| **Итого** | **5-7 дней** | начинаем сегодня в фоне |

---

## История переписки

| Файл | От кого | Когда |
|---|---|---|
| `SLAI_QUESTIONS.md` | parsdocs | 2026-05-16 утром |
| `SLAI_ANSWERS.md` | SLAI | 2026-05-16 |
| `SLAI_OUR_REPLY.md` | parsdocs | 2026-05-16 |
| `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md` | SLAI | 2026-05-16 |
| `OPEN_QUESTIONS.md` → `doc-service/docs/INTEGRATION_QUEUE.md` | parsdocs (queue) | 2026-05-16 |
| `SLAI_REPLY_v2.md` (xanderkag/SLAI `296b2b9f`) | SLAI | 2026-05-16 |
| **`PARSDOCS_CATEGORY_SYNC_REPLY.md` (этот файл)** | **parsdocs** | **2026-05-16** |
