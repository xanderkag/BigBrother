# Runbook: переотдача 30 «пустых» инвойсов для SLAI

**Основание:** Q-REDELIVER-1 (INTEGRATION_QUEUE.md). SLAI reply 2026-07-08 §B.
**Где выполнять:** **Asha** (staging-хост SLAI-интеграции), НЕ kb-docker —
боевой корпус SLAI живёт там. kb-docker (корп-прод) не имеет SLAI-tenant'ов.
**Кто выполняет:** оператор parsdocs с доступом к Asha.

---

## 0. TL;DR

Инвойсы, которые до батча 2026-06-30 отдавали **пустое** извлечение
(8192-токен cap), переобработаны с qwen3.6:27b. Прежние `_match_signals`
были пустыми (только `schema_version`). SLAI просит **переотдать webhook
по списку job_id** — приём у них идемпотентный, дублей не создаст.

Выполняется через уже существующий эндпоинт:
`POST /api/v1/jobs/:id/redeliver-webhook?force=true` (см.
`src/routes/jobs.ts:1211`).

---

## 1. Собрать список 30 job_id

На Asha, коннектимся к БД:

```bash
ssh asha
docker exec parsdocs-postgres-1 psql -U docservice -d docservice
```

Кандидаты — commercial_invoice/invoice-джобы, у которых:
- webhook уже был доставлен ранее (`webhook_delivered_at IS NOT NULL`);
- обновлены после 2026-06-30 (переобработаны в батче);
- имеют реальное извлечение сейчас (не пустое `extracted`).

```sql
-- ВАЖНО: подкрутить under-condition под реальный корпус Asha.
-- Точных критериев «был пустым до батча» из БД задним числом не восстановить,
-- поэтому сужаемся по (тип × окно × наличие webhook_delivered_at).
SELECT
  j.id,
  j.file_name,
  j.document_type,
  j.confidence,
  j.webhook_delivered_at,
  j.updated_at,
  jsonb_array_length(COALESCE(j.extracted->'items', '[]'::jsonb)) AS items_count
FROM jobs j
WHERE j.status = 'done'
  AND j.document_type IN ('commercial_invoice', 'invoice')
  AND j.webhook_url IS NOT NULL
  AND j.webhook_delivered_at IS NOT NULL
  AND j.updated_at BETWEEN '2026-06-25' AND '2026-07-05'
  -- Признак «переобработан» — items[] непустой и в meta нет empty-marker
  AND jsonb_array_length(COALESCE(j.extracted->'items', '[]'::jsonb)) > 0
ORDER BY j.updated_at DESC
LIMIT 40;
```

Ожидание: ~30 строк. Пробежаться глазами по `file_name` — убедиться, что это
именно ВЭД-инвойсы (без mixup с UPD и SF). Сохранить `job_id`-ы в файл
`/tmp/redeliver_ids.txt`, по одному id на строку.

**Альтернативно (если знаешь батч-маркер в metadata):**
```sql
SELECT j.id FROM jobs j
WHERE j.metadata->>'source' = 'reprocess-2026-06-30-batch';
```

---

## 2. Прогреть один job (dry-run на самом свежем)

```bash
API_KEY=$(grep '^API_KEY=' ~/parsdocs/doc-service/.env | cut -d= -f2)
JOB_ID=<первый id из списка>

curl -s -X POST \
  "http://localhost:8085/api/v1/jobs/${JOB_ID}/redeliver-webhook?force=true" \
  -H "Authorization: Bearer ${API_KEY}"
```

Ожидание: HTTP 202 + JSON job'а с обновлённым `webhook_attempts=0` и
`webhook_delivered_at=null`. В логах worker'а — new attempt, ответ SLAI 200/201.

Проверить лог:
```bash
docker logs parsdocs-worker-1 --tail 50 | grep -i webhook
```

Если SLAI ответил 4xx/5xx — **остановиться**, разобрать причину. Скорее всего
`webhook_hmac_secret` расходится (пере-провижн, разные окружения).

---

## 3. Batch-переотдача

Когда smoke прошёл:

```bash
API_KEY=$(grep '^API_KEY=' ~/parsdocs/doc-service/.env | cut -d= -f2)

while read -r JOB_ID; do
  echo "→ redelivering ${JOB_ID}"
  curl -sf -X POST \
    "http://localhost:8085/api/v1/jobs/${JOB_ID}/redeliver-webhook?force=true" \
    -H "Authorization: Bearer ${API_KEY}" \
    -o /tmp/redeliver_${JOB_ID}.json \
    && echo "  ok" \
    || echo "  FAILED"
  sleep 0.5   # избежать rate-limit, у нас 200/min по умолчанию
done < /tmp/redeliver_ids.txt
```

---

## 4. Проверка

```sql
-- Все переотданные должны иметь свежий webhook_delivered_at (< 10 минут назад)
SELECT id, webhook_delivered_at, webhook_attempts, webhook_last_status
FROM jobs
WHERE id = ANY(ARRAY[...30 UUIDs...]::uuid[])
ORDER BY webhook_delivered_at DESC;
```

Все должны быть `webhook_last_status = 200` или `201`, `webhook_attempts >= 1`,
`webhook_delivered_at` в пределах последних минут.

---

## 5. Отписать SLAI

В чат:
> Переотдал 30 пустых инвойсов webhook'ом по списку job_id (Q-REDELIVER-1).
> Все ответы 2xx, ретраев нет. Если увидите дубли — маловероятно (у вас
> идемпотентно), но пингуйте если что.

Пометить Q-REDELIVER-1 → RESOLVED в `INTEGRATION_QUEUE.md`.

---

## 6. Если что-то пошло не так

- **HTTP 4xx от SLAI на HMAC:** пересверить `webhook_hmac_secret` в
  `organization_settings` (S1 secret для slai-sandbox / отдельный для
  slai-negabarit после Q-NEG-SECRET-1).
- **HTTP 5xx:** SLAI-side, retry через тот же эндпоинт (webhook-sweeper
  сам поднимет).
- **404 job not found:** ID неправильный (пере-сверить с DB).
- **409 job has no webhook_url:** org-fallback не сработал → проверить
  `organization_settings.webhook_url` для tenant'а.

---

_Runbook составлен 2026-07-08 по ответу SLAI на сверку 07.07 (§B).
Механизм: существующий эндпоинт `POST /jobs/:id/redeliver-webhook?force=true`
из `src/routes/jobs.ts:1211`._
