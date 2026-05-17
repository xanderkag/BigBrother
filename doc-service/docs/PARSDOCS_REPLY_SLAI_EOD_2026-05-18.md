# Ответ parsdocs на EOD-отчёт SLAI от 2026-05-17

> **Версия parsdocs:** `2660ffd → 1014e23` (свежий деплой 18.05 ~00:10 MSK)
> **Адресат:** SLAI integration team
> **Авторы:** parsdocs team
> **Связано:** [`PARSDOCS_E2E_FINDINGS_2026-05-17.md`](../../slai/docs/PARSDOCS_E2E_FINDINGS_2026-05-17.md)

---

## TL;DR

Спасибо за подробный отчёт — реальный e2e-прогон 30 PDF сильно прояснил картину.

**Закрыто 4 из 6 P0/P1 issues** (commit `1014e23`, задеплоено на `parsedocs.taipit.ru`):

| Issue | Что | Статус |
|---|---|---|
| #1 | payment_order ложно срабатывал на «БИК» в шапке 1С | ✅ migration 0021 |
| #2 | transport_request не матчил «ЗАЯВКА-ДОГОВОР № X» | ✅ migration 0021 |
| #3 | UPPERCASE slugs в outbound API (TTN→ttn etc.) | ✅ outbound slug-normalize |
| #4 | webhook без `version: 'v1'` поля | ✅ во всех 3 webhook-каналах |
| #5 | HMAC под header'ом `x-docservice-signature` вместо `X-Parsdocs-Signature` | ✅ дубль headers'ов |
| #6 | LLM fallback не триггерится при confidence=0 | ⏸ root cause = Issue #1, после фикса должно решиться |

**Когда удобно — прогоните batch-eval ещё раз**, должны увидеть:
- invoices: 0/10 → ожидаемо 10/10 на classifier (плюс ~80% field accuracy с LLM)
- requests: 0/10 → ожидаемо ≥9/10
- ttns: 5/5 → должны остаться 5/5
- document_type теперь `ttn` (lowercase), не `TTN`

---

## Подробно по каждому issue

### ✅ Issue #1 — payment_order на 1С-счёте

**Root cause найден:** в БД `document_types.classification_keywords` для `payment_order` был bare-pattern `БИК\s*\d{9}` (legacy seed). Этот pattern матчит ЛЮБОЙ документ с банковскими реквизитами, включая шапку «Образец заполнения платёжного поручения» в 1С-счёте.

**Фикс:** [`migrations/20260524000021_classifier_fixes_slai_eod.sql`](../../doc-service/migrations/20260524000021_classifier_fixes_slai_eod.sql)

Убрали bare-БИК паттерн. Реальные платёжки сохраняют детект через:
- `платёжное\s+поручение` / `платежное\s+поручение` (title — самый надёжный сигнал)
- `\bП\.?\s*П\.?\s*№` (сокращение «П/П №»)
- `Поступ\.\s+в\s+банк\s+плат\.` / `Списано\s+со\s+сч\.\s+плат\.` (банковские отметки на сканированных копиях)

**Замечание команды.** Ваше предложение №3 (regex учитывает позицию: «БИК в первых 300 символах в блоке `Образец...` ≠ payment_order») — хорошее, но потребовало бы изменения keyword classifier'а с support'ом positional / context'-aware rules. Сейчас он просто ищет совпадение в любом месте текста. Мы решили проще: убрать noise-pattern. Если в будущем появятся другие false-positives, готовы добавить positional support'.

---

### ✅ Issue #2 — transport_request не матчит «ЗАЯВКА-ДОГОВОР»

**Root cause:** keyword'ы матчили только две формы:
1. `заявка\s+(?:№|на\s+перевозку|...)` — требует whitespace после «заявка»
2. `заявка-договор\s+на\s+перевозку` — требует точно «на перевозку»

Ваш шаблон **«ЗАЯВКА-ДОГОВОР № X от Y г. на оказание транспортно-экспедиционных услуг»** не подходит:
- После «заявка» идёт «-договор» (нет whitespace) → паттерн 1 не матчит
- После «заявка-договор» идёт «№ X от Y г.» (не «на перевозку») → паттерн 2 не матчит

**Фикс:** добавили 3 новых паттерна + расширили старый (migration 0021):

```
заявка\s+(?:№|на\s+перевозку|на\s+транспортные\s+услуги|на\s+автоперевозку|на\s+транспортно-экспедиционн)
заявка-договор\s+на\s+перевозку
заявка-договор\s*№                                          ← NEW (ваш шаблон)
заявк[аи][^\n]{0,100}транспортно-экспедиционн               ← NEW (fallback)
заявка\s+на\s+оказание\s+транспортн                         ← NEW (синонимичная форма)
```

**Странность с confidence=1.0 на null type.** Это семантический баг в нашем classifier — `confidence: 1.0` при `type: null` означает «100% уверены, что не нашли совпадений», что неинтуитивно. Согласны с вашим предложением 4.3 — выделить `classification_confidence` отдельным полем + null → 0. Сделаем отдельным коммитом (это поломает существующих потребителей, нужно подумать про backwards compat).

---

### ✅ Issue #3 — UPPERCASE document_type

**Минимально-инвазивный фикс — outbound slug normalize.**

[`src/types/slug-normalize.ts`](../../doc-service/src/types/slug-normalize.ts):

```typescript
export const OUTBOUND_SLUG_ALIASES: Record<string, string> = {
  TTN: 'ttn',
  UPD: 'upd',
  CMR: 'cmr',
  AKT: 'services_act',
  factInvoice: 'tax_invoice',
};
```

Применяется в:
- `jobsRepo.toApi()` — GET /jobs/:id и /jobs response
- Webhook payload (все 3 канала: initial delivery + sweeper re-delivery + manual redeliver)

БД и внутренний pipeline продолжают использовать историческое имя (`TTN`) — это только outbound фасад. Inbound трансляцию (вы шлёте `services_act` → мы ищем `AKT` в БД) уже делает `documentTypeResolver.expandSlugCandidates()` начиная с commit `91585c2` (F22).

Покрыто 9 unit-тестами — контракт залочен.

**Почему не полная DB-миграция слагов:**
- `TTN` → `ttn` ломает existing `provider_settings.metadata`, `document_types` audit log, тестовые fixture'ы
- Хочется делать отдельной фазой когда будут все системы готовы (parsdocs UI, parsdocs admin scripts, наш eval suite, ваш импортер)
- Outbound фасад покрывает 100% ваших use-cases прямо сейчас

Если вам критично иметь lowercase ВЕЗДЕ (включая логи `pipeline_steps`, `metadata` из ваших старых job'ов и т.п.) — скажите, сделаем полную миграцию.

---

### ✅ Issue #4 — webhook body без `version` поля

**Старый payload:**
```json
{ "job_id": "...", "status": "done", "document_type": "TTN", ... }
```

**Новый payload (после commit `1014e23`):**
```json
{
  "version": "v1",
  "job_id": "...",
  "status": "done",
  "document_type": "ttn",      ← lowercase (Issue #3)
  "confidence": 0.96,
  "ocr_engine": "pdf-text",
  "extracted": { ... },
  "metadata": { ... },
  "error": null,
  "_field_confidence": { "seller.inn": 0.97, ... }
}
```

Тип в TypeScript: `version: 'v1'` is required field. Если мы будем менять контракт ломающе → бампаем до `'v2'`, вы сможете отказывать старые webhooks через valid'атор.

Поле `version` теперь во всех 3 каналах отправки:
1. `pipeline/webhook-delivery.ts` — основной flow после finalize'а job'а
2. `workers/webhook-sweeper.ts` — sweeper-retry для не доставленных
3. `routes/jobs.ts POST /jobs/:id/redeliver-webhook` — manual replay

---

### ✅ Issue #5 — HMAC header name

**Исторически отправляли:**
```
x-docservice-signature: sha256=<hex>
x-docservice-job-id: <uuid>
x-docservice-attempt: <n>
```

**Теперь дублируем под ваш header (для совместимости):**
```
x-parsdocs-signature: sha256=<hex>           ← вы это проверяете
x-parsdocs-job-id: <uuid>
x-parsdocs-attempt: <n>
x-docservice-signature: sha256=<hex>         ← старые потребители
x-docservice-job-id: <uuid>
x-docservice-attempt: <n>
```

Подпись и алгоритм те же — HMAC SHA-256 от raw body со `WEBHOOK_HMAC_SECRET` (`env`).

**Когда вам удобно — снимите** `PARSDOCS_WEBHOOK_SKIP_VERIFY=true` с dev-стенда и проверьте подпись. Если рукопожатие не сходится — у нас разные секреты, координируем.

Через 1-2 месяца после миграции SLAI можем убрать legacy `x-docservice-*` headers (отдельный коммит).

---

### ⏸ Issue #6 — LLM fallback не триггерится

**Гипотеза подтверждена частично.** В DB у вас `payment_order parser_kind=llm_extract`, так что когда classifier выдал payment_order, parser ВСЁ ЖЕ вызвал LLM (GenericLlmParser). Но LLM получил промпт для **payment_order** (с полями П/П: payer, payee, BIC, account), а реальный документ — invoice (счёт на оплату). LLM честно вернул `{}` или 1-2 поля из совпадения → confidence ~0, fields_missing все 8.

Лог `llm_fallback_triggered: false` — это поле специфично для **regex-парсеров** (когда они САМИ внутри триггерят LLM как fallback при низкой regex confidence). GenericLlmParser в принципе не имеет fallback'а — он сам и есть LLM call.

**После фикса Issue #1** этот сценарий исчезает: classifier на 1С-счёте больше не уйдёт в payment_order → подберёт invoice → промпт для invoice → правильное извлечение. Прогон вашего batch-eval'а на новой версии покажет.

Если в будущем найдёте кейсы где **правильно** классифицированный документ не получил LLM-extract (например classifier выдал invoice + parser_kind=`builtin:upd_regex` mistakenly), напишите репро — добавим эскалацию на LLM-reclassify.

---

## Архитектурные предложения (раздел 4 отчёта)

Спасибо за глубокий анализ. Раскрашиваем по приоритету:

| # | Что | Наш план |
|---|---|---|
| 4.1 | Двухслойный classifier (keyword + LLM fallback) | **TODO**. Заведём `F28` — keyword < 0.85 → LLM-classify. Это закроет corner-cases типа когда добавляется новый шаблон без обновления keywords |
| 4.2 | Унификация enum DocumentTypeSlug в lowercase | Согласны. Будем делать отдельной фазой (см. ответ на #3) |
| 4.3 | `classification_confidence` отдельным полем | Согласны. Сделаем отдельным коммитом — это семантический breaking change |
| 4.4 | JSON Schema валидации webhook на нашей стороне | Не критично пока. Если хотите — выложим JSON Schema контракта в шаге выше |
| 4.5 | Inference как отдельный сервис | ✅ уже так (`parsdocs-inference` отдельно от `parsdocs-api`) |
| 4.6 | DB vs ENV priority для provider_settings + индикация в UI | **TODO**. Сейчас resolver уже работает по принципу «БД > env» через `dynamicLlm` (см. F22), но UI индикации нет. Добавим в Phase 5 миграции UI |
| 4.7 | `reprocessing` status | **TODO**. Сейчас reprocess создаёт новую попытку в том же job'е (см. POST /jobs/:id/reprocess) — действительно может путать audit log. Добавим transition в `reprocessing` и обратно |

---

## Открытые вопросы (раздел 9 отчёта)

### 1. Multi-document PDF — один PDF с пачкой (счёт + УПД + СФ)

**Текущий статус:** F5 skeleton сделан (commit `14fae43`, `pipeline/multidoc/`). Splitter определяет границы по классификации каждой страницы и группирует consecutive страницы того же типа. **Не дошло до production** — нет evaluation корпуса с multi-doc PDF'ами + bench'а accuracy.

**План:**
- Если у вас в проде встречаются такие PDF — поделитесь 5-10 примерами (или генератором). Тогда сразу довинтим до full implementation.
- Webhook payload будет содержать `documents: [{ page_range, document_type, extracted, ... }]` (см. `WebhookPayload.documents` в `webhooks/deliver.ts`). При single-doc behaviour не меняется (backwards-compat через `extracted` поле).

### 2. Lossless re-extract после ручной правки

**Текущее поведение:** оператор правит extracted через UI v2 «Edit» → PATCH /jobs/:id/extracted → backend ре-валидирует, статус → 'done', `extracted_corrected_at` ставится. **Webhook повторно НЕ шлётся.**

**Согласны это надо.** Добавим в Phase 5: после `PATCH /extracted` если был `webhook_url`, шлём **обновлённый** webhook с `version: 'v1'` и новым `extracted`. В payload добавим поле `correction: true` (или подобное), чтобы вы могли отличать initial delivery от correction'а.

### 3. classifier-rules.json обратный sync

**Решение:** не нужен. У вас более ограниченный enum (`ttn`/`invoice`/`upd`/...), у нас расширенный (всё SLAI + AliExpress packing list + customs declaration + ...). Двухсторонний sync будет источником конфликтов.

**Лучше:** мы публикуем JSON Schema нашего enum'а (см. ответ на 4.4), вы валидируете incoming webhook против него.

### 4. Confidence schema — что такое 0.85?

**Текущее значение** `confidence` в job response:
- combineConfidence(ocr_confidence, parser_confidence) — арифметическое среднее
- Где `parser_confidence` для LLM-парсера = `1 - (missing_fields / expected_fields)` (т.е. coverage)
- Для regex-парсеров — там сложнее, разные правила per type

**Согласны это надо чётче.** В Phase 5 миграции UI разнесём:
- `confidence_ocr` — confidence OCR-движка
- `confidence_extract` — coverage + per-field средний из `_field_confidence`
- `confidence` — combined (текущее значение, сохраняется для backwards-compat)

Документируем в `PARSDOCS_REQUIREMENTS_TZ.md`.

---

## Что ещё попросим у вас

1. **Прогон batch-eval после деплоя.** Хочется увидеть числа сейчас, до того как делать ещё фиксы.

2. **Дельта тестов.** Если есть test PDF на которых сейчас классификатор всё ещё ошибается (после migration 0021) — поделитесь 1-2 файлами, разберём конкретно.

3. **Замечания по UI v2.** Вы упомянули что job-detail в SLAI компактнее чем наш (280 строк vs 1058). Если есть конкретный UX feedback по нашему `/ui/jobs/:id` — будем рады услышать.

---

## Контакты

- Репозиторий: `git.taipit.ru/airesearch/docs-parse` (mirror: `github.com/xanderkag/BigBrother`)
- Issue tracker: пока через этот документ + комменты в `INTEGRATION_QUEUE.md`
- Тестовый стенд: `https://parsedocs.taipit.ru/` (UI v2 главный)
- Готовы к walkthrough — назначайте звонок

— parsdocs team, 2026-05-18 00:30 MSK
