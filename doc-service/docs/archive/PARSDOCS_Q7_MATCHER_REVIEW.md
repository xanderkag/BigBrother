# parsedocs Q7: review SLAI matcher / HMAC / target_entity_hint (2026-05-17)

> Ответ на пункт #2 «Что от вас просим» из `SLAI_REPLY_v2.md`.
> Сравниваем реализацию SLAI (как описана текстом в их v2 reply) с нашим
> видением из `SLAI_OUR_REPLY.md`.

**SLAI-backend репо приватное**, исходники напрямую прочитать не смогли.
Review сделан по описаниям в `SLAI_REPLY_v2.md` (раздел Q2 «Что мы
реализовали из вашей реплики»). Если есть расхождение между текстовым
описанием и фактическим кодом — пингуйте.

---

## TL;DR

**Принципиально устраивает.** В описанном виде их matcher:
- ✅ Использует правильные сигналы (vehicle.plate как primary, ИНН как secondary)
- ✅ Threshold-логика более тонкая чем наша (двойное условие HIGH + ratio ≥ 2×)
- ✅ Правильная терминология (shipper / consignee / carrier вместо плоского seller/buyer)
- ✅ HMAC verify timing-safe (best practice, нам как раз надо такое подключить в F13)
- ✅ `target_entity_hint` auto-detect через vehicle.plate — соответствует нашему предложению

**Что хотим уточнить (~3 нюанса):**
1. Учитывается ли `vehicle.driver` (ФИО водителя) в скоринге
2. Учитывается ли `doc.number` против `transportation.reference` (или `transfer.documents[].number`)
3. Учитывается ли совпадение `route.from_city` / `route.to_city`

Это **детали для tuning**, не блокер. На MVP пилоте увидим какие сигналы
реально работают и подкрутим веса вместе.

---

## Поэлементное сравнение

### Scoring weights

| Сигнал | parsedocs предложение | SLAI реализация | Оценка |
|---|---|---|---|
| `vehicle.plate` exact match (на Transfer) | +50 (35% веса) | **+50** | ✅ совпало |
| `carrier.inn` любая сторона | +20 (14%) | **+30** | ⚠️ SLAI выше — **обоснованно** (carrier важнее для логистики) |
| `shipper.inn` | +15 (10%) | **+25** | ⚠️ SLAI выше — **обоснованно** для отгрузки |
| `consignee.inn` / `buyer.inn` | +10 (7%) | **+25** | ⚠️ SLAI выше — окей |
| `date` ±7-14 дней | +5-10 | **+15** (±7d) | ⚠️ SLAI выше — окей, узкое окно лучше |
| `total_with_vat` ±5% | +5-10 | **+10** | ✅ почти совпало |
| `not closed/archive` | (не было) | **+5** | ✅ хорошее улучшение — отсекает старые завершённые |
| `vehicle.driver` (ФИО) | +15 в нашем плане | **?** | 🟡 не упомянуто в SLAI описании |
| `doc.number` vs `reference` | +15 в нашем плане | **?** | 🟡 не упомянуто (возможно через `reference $like`) |
| `route.from_city / to_city` | +5/+5 | **?** | 🟡 не упомянуто |

**Вердикт по весам:** SLAI распределение более выверенное чем наше первое
предположение. Они правильно сместили вес с buyer.inn на carrier/shipper —
для логистики это естественно. Не блокер.

### Threshold + auto-pick

| | parsedocs | SLAI |
|---|---|---|
| Auto-attach | score ≥ 85 | **score ≥ 70 AND top.score ≥ 2× second.score** |
| Manual select | 30 ≤ score < 85 | 40 ≤ score < 70 |
| Show «не нашли» | < 30 | < 40 |

**Вердикт:** **SLAI лучше**. Их «2× ratio» защищает от false-attach когда
два кандидата равноценны (например, водитель ездит на одной машине у
двух перевозчиков). Наш plain threshold 85 мог бы привязать не к тому,
если у обоих кандидатов score 88 и 86. SLAI требует разрыв — если top
не в 2× больше второго, отдаёт на manual select.

**Рекомендация для нас:** при будущей реализации matcher на нашей стороне
(если когда-нибудь понадобится — сейчас он у SLAI) — взять их подход
двойного условия.

### target_entity_hint

| | parsedocs (SLAI_OUR_REPLY.md раздел про multimodal) | SLAI |
|---|---|---|
| Что значит `Transfer` | документ с `vehicle.plate` → на плечо мультимодаля | то же |
| Что значит `Transportation` | счёт/УПД/АКТ без транспорт-полей | то же |
| `null` | неоднозначно | то же |
| Auto-detect | мы рекомендовали SLAI matcher'у самостоятельно угадывать | **SLAI делает auto-detect через `vehicle.plate`**, наш explicit hint опционален |

**Вердикт:** ✅ Сошлись. Наш `target_entity_hint` в JSON — приятный bonus,
но SLAI и без него правильно решит через структуру extracted.

### HMAC verify (timing-safe)

Их реализация — `crypto.timingSafeEqual` или эквивалент. Это **best practice**
для сравнения секретов: обычное `===` уязвимо к timing attack (можно
посимвольно подобрать HMAC через измерение времени неудачных попыток).

**Наш статус:**
- **Outbound** (мы → SLAI) — `createHmac('sha256', secret).update(body).digest('hex')` в `webhooks/deliver.ts`. Подписываем правильно
- **Inbound** (SLAI → нам) — endpoint ещё не написан (это F13). **Обязательно использовать `crypto.timingSafeEqual`** при имплементации

Дополним TECH_DEBT.md F13 явным требованием timing-safe verify.

### Document.metadata schema

SLAI пишут в `Document.metadata` следующее при привязке от AI:
```ts
{
  source: 'parsdocs-ai',
  attached_by_ai_at: ISO,
  attached_by_user_id: number,
  external_job_id: string,
  confidence_score: number,
  matched_fields: string[],     // ← какие поля совпали со scoring
  extracted: { /* полный JSON от нас */ }
}
```

**Вердикт:** ✅ Адекватно. `matched_fields` — отличная идея для audit
(можно ретроспективно посмотреть: «привязалось потому что совпала
vehicle.plate + carrier.inn, остальные сигналы не сработали»).

---

## Что от нас по этому review

1. **Q7 → RESOLVED** в `INTEGRATION_QUEUE.md`. Принципиальное согласие
   зафиксировано.

2. **3 уточнения** в SLAI (не блокеры):
   - Используется ли `vehicle.driver` ФИО в scoring? Если да — с каким
     весом? Если нет — добавлять?
   - Учитывается ли `doc.number` против `transportation.reference` /
     `transfer.documents[].number`?
   - Учитывается ли route (`from_city` / `to_city`) match?

3. **F13 + явное требование timing-safe verify** — добавляем в задачу.

4. **На пилоте** — собираем статистику по `matched_fields`: какие сигналы
   реально работают, какие шум. Через 2 недели тюним веса вместе с SLAI.

---

## История переписки

| Файл | От кого | Когда |
|---|---|---|
| `SLAI_QUESTIONS.md` | parsedocs | 2026-05-16 |
| `SLAI_ANSWERS.md` | SLAI | 2026-05-16 |
| `SLAI_OUR_REPLY.md` | parsedocs | 2026-05-16 |
| `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md` | SLAI | 2026-05-16 |
| `OPEN_QUESTIONS.md` → `INTEGRATION_QUEUE.md` (git) | parsedocs | 2026-05-16 |
| `SLAI_REPLY_v2.md` | SLAI | 2026-05-16 |
| `PARSDOCS_CATEGORY_SYNC_REPLY.md` | parsedocs | 2026-05-16 |
| **`PARSDOCS_Q7_MATCHER_REVIEW.md`** (этот файл) | **parsedocs** | **2026-05-17** |
