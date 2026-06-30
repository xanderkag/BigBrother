# parsdocs → SLAI: сверка изменений извлечения / выхода (PD-CONTRACT-1)

**Дата:** 2026-06-30
**От:** parsdocs (Vanga / Big Brother)
**Кому:** SLAI dev
**Канал контракта:** `extracted._match_signals` (PD-CONTRACT-1 §2.1) + webhook v1

> Сверка по тому, что parsdocs изменил в этой сессии на поверхности
> извлечения/выхода. Перечислены **имена полей и структурные факты** —
> значения документов не приводятся. Для каждого пункта указано, нужно ли
> SLAI что-то делать на своей стороне.

---

## 0. TL;DR для матчера

- **2 действия на стороне SLAI ничего не требуют** (фоновые: качество ↑, и
  «пустые» доки переотдать/перетянуть).
- **Контракт `_match_signals` ТРЕБУЕТ 1 правки на нашей стороне** (не SLAI):
  `commercial_invoice.containers[].number` сейчас **НЕ** проецируется в
  `_match_signals.containers` (commercial_invoice шарит invoice-проектор, а
  тот не собирает контейнеры). Заводим как Q-блок, чинит parsdocs. После
  фикса — **`schema_version` НЕ меняется** (ключ `containers` уже в контракте
  1.0, расширяется только источник).
- `price_list.hs_code` и прочие новые поля — **richer extraction**, не
  match-ключи. В `_match_signals` не идут (по дизайну present-only flat).
- `buyer.inn` / `buyer.kpp` у `commercial_invoice` — **уже** проецируются
  generic/invoice-проектором (`parties.buyer.inn/kpp`). Действий нет.

---

## 1. Смена модели извлечения (качество, не контракт)

| Что | Деталь |
|---|---|
| Было | phi4 14B (дефолт с 2026-06-18) |
| Стало | qwen3.6:27b (heavy-tier), fast-mode (`reasoning_effort:"none"`) |
| Замер | 98.3% golden-set (= уровень 70B/72B), 100% арифметика, 9/9 классификация, vs phi4 88.3%. MODEL_REPORT #36. |

**Для SLAI:** контракт НЕ меняется. Ожидайте **выше fill-rate** и более
полные `parties` / `items` (контейнеры, ИНН, суммы заполняются там, где
phi4 промахивался). Канонические ключи `_match_signals` те же — просто чаще
**present**. Никаких действий.

---

## 2. Восстановление «пустых» извлечений (операционно важно)

- ~24% боевого корпуса (30 из 32 затронутых доков) раньше отдавали **ПУСТОЕ**
  извлечение: старый free-thinking режим упирался в 8192-токен cap → пустое
  тело → в `extracted` оставался по сути только конверт `_match_signals` без
  бизнес-полей. Эти доки **переобработаны** и теперь несут полное извлечение.
- 2 near-duplicate инвойса остаются пустыми — edge case, на контроле.

**Для SLAI (нужно решение):** любые `_match_signals`, которые SLAI получил по
этим докам РАНЬШЕ, были near-empty (только `schema_version`, без
container/parties/totals). Сейчас по ним есть реальные сигналы. **Вопрос к
вам:** перетягиваете ли вы их сами (`GET /jobs/:id`) или ждёте от нас
повторную webhook-доставку? Мы можем переотдать по списку `job_id`, если так
удобнее. См. Q-блок Q16 в очереди.

---

## 3. Новые поля извлечения (живая схема) — карта на релевантность матчеру

Легенда: **M** = matcher-relevant (кандидат в `_match_signals`),
**R** = richer extraction only (видно в `extracted`, не match-ключ).

### 3.1 `price_list` (миграция `20260630000001`)

| Поле | Уровень | Класс | `_match_signals` действие |
|---|---|---|---|
| `incoterms` | header | R | нет |
| `contract_ref` | header | R | нет |
| `supplier_address` | header | R | нет |
| `items[].hs_code` | line | **M*** | см. примечание — проектора у `price_list` нет |
| `items[].country_of_origin` | line | R | нет |
| `items[].brand` | line | R | нет |
| `items[].manufacturer` | line | R | нет |
| `items[].model` | line | R | нет |
| `items[].description` | line | R | нет |

\* `hs_code` потенциально линкует `price_list` ↔ ГТД по коду ТН ВЭД. НО:
(1) у `price_list` сейчас **нет per-type проектора** — работает только
generic fallback, который hs_code не собирает; (2) `_match_signals` сегодня
**не имеет канонического ключа `hs_codes`** ни для одного типа (ГТД тоже не
проецирует hs_code в сигналы). Это **не дельта этой сессии, а отсутствующая
фича**. Решение: HS-линковка — отдельная фича (нужен и источник в ГТД, и
ключ в контракте, т.е. `schema_version` bump). Заводим как обсуждение в
Q-блоке, **в этой сверке к немедленной реализации НЕ берём** — пусть SLAI
подтвердит, что HS-матчинг им вообще нужен как кросс-док ключ (а не просто
поле в карточке).

### 3.2 `commercial_invoice` (миграция `20260630000002`)

| Поле | Уровень | Класс | `_match_signals` действие |
|---|---|---|---|
| `buyer.inn` | party | **M** | **УЖЕ проецируется** → `parties.buyer.inn`. Нет действия. |
| `buyer.kpp` | party | M | **УЖЕ проецируется** → `parties.buyer.kpp`. Нет действия. |
| `containers[].number` | doc | **M** | **ГЭП** — НЕ проецируется (см. §4). Нужна правка проектора parsdocs. |
| `total` | doc | M (totals) | **УЖЕ** покрыт — invoice-проектор читает `total`/`total_with_vat`. Нет действия. |
| `total_with_vat` | doc | M (totals) | **УЖЕ** покрыт. Нет действия. |

---

## 4. Вердикт по `_match_signals` (контракт)

**Единственная реальная дельта контракта в этой сессии:**

> `commercial_invoice.containers[].number` **не доходит** до
> `_match_signals.containers`.

**Причина (verified в коде `src/pipeline/normalize/match-signals.ts`):**
`PROJECTORS.commercial_invoice = PROJECTORS.invoice` (alias), а
invoice-проектор **не вызывает** `collectContainers()`. Generic fallback
тоже не собирает контейнеры. То есть FCL-коммерческий инвойс с
`containers[]` в `extracted` отдаёт SLAI **`_match_signals` без `containers`**
— разрыв линковки commercial_invoice ↔ B/L ↔ packing_list ↔ ГТД по
грузовой единице.

**Что нужно (на стороне parsdocs, НЕ SLAI):** добавить `collectContainers()`
в проектор семейства invoice (или дать `commercial_invoice` собственный
проектор-обёртку, вызывающую invoice-логику + контейнеры). Хелпер
`collectContainers` уже существует и уже используется для B/L/TTN/CMR/Акт —
правка маленькая. Это передаётся `backend` (мы не пишем прод-код в сверке).

**`schema_version` bump 1.0 → 1.1? — НЕТ.**
Ключ `containers: string[]` уже часть контракта 1.0 (B/L/TTN/CMR/Акт его уже
эмитят, SLAI его уже читает — см. `PARSDOCS_REPLY_TO_SLAI_Q15_LC8_2026-06-23`).
Мы лишь **расширяем множество типов**, эмитящих уже существующий ключ. Это
аддитивно и обратно-совместимо в рамках 1.0 (тот же принцип, что в
CONTRACT_TECH_APPENDIX §4.5: добавление — back-compat). SLAI **уже** умеет
читать `_match_signals.containers` — после нашего фикса коммерческий инвойс
просто начнёт его заполнять, кода у SLAI менять не надо.

**Итог по `_match_signals`:**

| Кандидат | Вердикт | schema_version |
|---|---|---|
| `commercial_invoice.containers[].number` | **проецировать** (фикс parsdocs) | без изменений (1.0) |
| `commercial_invoice.buyer.inn/kpp` | уже проецируется | — |
| `commercial_invoice.total/total_with_vat` | уже покрыт | — |
| `price_list.hs_code` (HS-линковка) | **отложить** — нужна отдельная фича + ack SLAI + bump 1.0→1.1 | потребует bump, если возьмём |
| `price_list.*` (brand/model/origin/...) | richer extraction, не match-ключ | — |

---

## 5. Что SLAI уже знает (не дублируем)

Ранее в этой сессии (уже задеплоено и **сообщено SLAI**):

- **Контейнеры в ТТН/CMR/Акт** + `order_refs` — `PARSDOCS_REPLY_TO_SLAI_Q15_LC8_2026-06-23.md`
  (Q15/LC-8). SLAI читает `_match_signals.containers` уже как канонический ключ.
- **B/L контейнер-подстрока ISO-6346** (фикс «MRKU1234567 40HC») —
  `BATCH_REVIEW_2026-06-25.md` P1-2 (`2c51234`). В сигналах уже.
- **ГТД/BL кросс-док match-keys** (`customs_declaration`: container_number,
  seller, total_duties, customs_post, release_date; `bill_of_lading`
  carrier/service_name) и батч аддитивных полей (M1–M5/C1–C2: invoice
  payee/amount_in_words, AKT/CMR/TTN/BL adds, UKD kpp/addresses/currency,
  transfer_note parties, packing_list container, contract_specification,
  ГТД graph44/Incoterms) — **батч-волна 2026-06-25**.
  > ⚠️ **НЕ уверен, что SLAI получил полный список именно этого батча
  > как формальную сверку.** `BATCH_REVIEW_2026-06-25.md` — наш внутренний
  > ТЗ-документ, не адресный reply SLAI. Если SLAI отдельно не уведомляли о
  > ГТД-сигналах (`customs_declaration` проектор эмитит
  > `declaration_numbers` + seller/buyer/totals/date — это в коде есть и
  > подтверждено), стоит включить одну строку в сообщение ниже. **Решение —
  > за человеком** (см. «нужно решение»).

---

## 6. Нужно решение человека перед отправкой SLAI

1. **§2 переотдача «пустых»:** предложить SLAI re-pull самим или мы
   переотдаём webhook по списку `job_id`? (Влияет на формулировку сообщения.)
2. **§3.1 HS-линковка:** спрашивать ли SLAI прямо сейчас, нужен ли им
   `hs_code` как кросс-док match-ключ (а не просто поле карточки)? Если да —
   это `schema_version` 1.0→1.1 и работа на обеих сторонах.
3. **§5 ГТД-батч:** знает ли SLAI про ГТД/BL-сигналы батча 2026-06-25
   формально? Если нет — добавить строку. (Я не нашёл адресного reply SLAI
   по этому батчу — только внутренний `BATCH_REVIEW`.)
