# parsdocs → SLAI: sandbox развёрнут, ждём ваш age public key + S1 envelope

**Дата:** 2026-05-31
**От:** parsdocs
**Кому:** SLAI dev / Aleksandr Liapustin
**Связано:** `PARSDOCS_REPLY_TO_SLAI_FOLLOWUP_2026-05-29.md`, `SLAI_SECRETS_INBOX.md` (наш inbox в git)

---

## TL;DR

✅ parsdocs Asha поднят до коммита **`a920e80`** (десять новых коммитов: EXT-LINE, OpenAPI extend, capabilities `{name, since}`, BYO_LLM, file_url, hybrid-routing).
✅ Sandbox-тенант создан (`organization_id: 9a3cb9d3-…`), персональный токен сгенерирован.
✅ Наш age public key опубликован в `SLAI_SECRETS_INBOX.md`.

**От вас нужны 2 вещи:**
1. **Ваш age public key** — чтобы мы зашифровали под него токен sandbox (S2) и положили PR в ваш inbox.
2. **S1 envelope** (`PARSDOCS_WEBHOOK_SECRET` под наш age key) — чтобы наш webhook receiver мог auth'ятся к вам.

После этого пилот WW-23 можно запускать.

---

## 1. Состояние Asha сейчас

| Параметр | Значение |
|----------|----------|
| Host (внутри сети) | `https://vanga.sls24.ru` |
| API endpoint | `https://vanga.sls24.ru/api/v1/jobs` |
| Health | `/health`, `/ready`, `/version`, `/capabilities` (public) |
| Commit deployed | `a920e80` (`/version` = `0.2.0+a920e80`) |
| LLM backend | `stub` (правило хоста — без cloud LLM пока не настроен Red Shield VPN-прокси). Это значит классификация и базовые поля extract'ятся, но строковая LLM-extraction вернёт пустую структуру. Для тестов формата контракта и end-to-end webhook'ов — достаточно. Реальная extract-точность будет после prod-LLM. |
| `BYO_LLM_ENABLED` | `true` — передавайте `X-LLM-*` headers (наш `BACKEND=stub` тогда обходится, и парсдок будет использовать ваши credentials) |
| `FILE_URL_INGEST_ENABLED` | `true` — можно `POST /jobs {file_url}` вместо multipart |
| `HYBRID_ROUTING_ENABLED` | off по умолчанию (включим когда понадобится vision-fallback) |
| ASR | работает (`voice-asr`, faster-whisper), `ASR_ENABLED=true` |
| `/capabilities` | возвращает 26 типов + 11 line fields + 4 doc fields в формате `{name, since}` |

---

## 2. Sandbox-тенант (для ваших contract-test'ов)

```
organization_id : 9a3cb9d3-e997-4669-a822-f8294f0dfed3
user_id         : fc9f3f6e-876e-4b07-aef6-7a85d48af698
token_name      : slai-sandbox-bot
token expires   : ~2026-08-29 (90 дней)
webhook_url     : https://api.demo.sls24.ru/api/v1/parsdocs/webhook (zapisan)
output mode     : webhook
```

**Bearer token (plaintext)** — передаётся envelope-encrypted под ваш age public key в блок S2 нашего `SLAI_SECRETS_INBOX.md`. Как только пришлёте свой public key — зашифруем и положим PR.

**Параметры тенанта (FOLLOWUP §AC9):**
- ✅ Separate organization (option 1) — изолирован от любых других тенантов
- ⚠️ Retention 7d / rate-limit 60 req/min — на схеме сейчас глобальные ENV-параметры хоста (`FILE_RETENTION_DAYS`, `RATE_LIMIT_PER_MINUTE`), per-tenant ещё не реализованы (миграция TODO). На dedicated Asha-хосте можно выставить хостовые значения; на проде понадобится per-tenant миграция. На пилоте — не блокер.

---

## 3. Наш age public key (для шифрования S1 webhook secret)

```
age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq
```

(сгенерирован age v1.2.1, 2026-05-31, на машине владельца parsdocs)

**Как зашифровать ваш webhook secret под него:**

```bash
# на вашей машине, после установки age:
echo "PARSDOCS_WEBHOOK_SECRET=$(openssl rand -hex 32)" > /tmp/s1.txt
age -r age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq \
    -a /tmp/s1.txt > /tmp/s1.age.txt
shred -u /tmp/s1.txt
cat /tmp/s1.age.txt
```

Содержимое `s1.age.txt` (многострочный `-----BEGIN AGE ENCRYPTED FILE-----`) — кладёте в наш `SLAI_SECRETS_INBOX.md` блок **S1** через PR в `xanderkag/BigBrother`. Мы расшифруем своим приватником и положим в `provider_settings` хоста Asha.

---

## 4. Контракт — что parsdocs шлёт вам

### Webhook на ваш `https://api.demo.sls24.ru/api/v1/parsdocs/webhook`

**Headers (все три — копии одного HMAC):**
- `X-Extractor-Signature: sha256=<hmac>` — preferred для нового `ExtractorGateway`
- `X-Parsdocs-Signature: sha256=<hmac>` — back-compat
- `X-DocService-Signature: sha256=<hmac>` — legacy
- `X-Extractor-Job-Id` / `X-Parsdocs-Job-Id` / `X-DocService-Job-Id` — UUID
- `X-Extractor-Attempt` / `X-Parsdocs-Attempt` / `X-DocService-Attempt` — counter

HMAC = `hmac_sha256(PARSDOCS_WEBHOOK_SECRET, raw_body)`. Verify через constant-time compare.

**Body schema** — `doc-service/docs/openapi/v1.yaml` (zерkalится у вас как `xanderkag/SLAI/docs/PARSDOCS_QUEUE.md`-related). Главное:
- `items[]` — позиции с **11 транспортными сигналами** (vehicle_plate, order_ref, route_from, route_to, trip_date, container_no, bl_no, cmr_no, ttn_no, declaration_no, driver_name)
- Document-level fallback — `period_from/to`, `contract_no/date`
- parsdocs **НЕ нормализует** значения (вы canonicalize'те у себя)

### Что вы шлёте parsdocs

```http
POST https://vanga.sls24.ru/api/v1/jobs
Authorization: Bearer <sandbox-token>
Content-Type: multipart/form-data

file=<PDF>
metadata={"_byo_llm": ...}
```

Либо (EXT-D):
```http
POST .../api/v1/jobs
file_url=https://your-storage.../path/doc.pdf&file_sha256=<hex>
```

Опциональные `X-LLM-*` headers если хотите чтобы parsdocs использовал ваш LLM key:
- `X-LLM-Provider: anthropic|openai|openai_compat`
- `X-LLM-Api-Key: <ваш ключ>`
- `X-LLM-Model: claude-sonnet-4-5` (опц)
- `X-LLM-Base-Url: <опц для openai_compat>`

Ключ зашифруется envelope на нашей стороне до записи в БД, redact в логах, decrypt в hot-path воркера, передаст в inference. Никогда не пишется в audit/events/webhook payload.

### Polling fallback

```http
GET https://vanga.sls24.ru/api/v1/jobs/<job_id>
Authorization: Bearer <sandbox-token>
```

Возвращает то же body что webhook, удобно если webhook receiver временно down.

---

## 5. Что от вас нужно (action items)

| # | Что | ETA | Канал |
|---|-----|-----|-------|
| 1 | **Ваш age public key** для шифрования S2 sandbox-токена | сегодня | PR в наш `SLAI_SECRETS_INBOX.md` §Recipient public key SLAI-side (либо просто строка в Telegram) |
| 2 | **S1 envelope** — `PARSDOCS_WEBHOOK_SECRET` зашифрованный под наш age public key | 2026-05-30 (по FOLLOWUP §Q4 ETA) | PR в наш `SLAI_SECRETS_INBOX.md` блок S1 |
| 3 | **Golden dataset** — 13 PDF + 13 .gt.json (Q9 + EXT-LINE AC) | 2026-06-02..04 | PR в `doc-service/test-fixtures/slai-golden/` (структура в README того же каталога) |
| 4 | **Confirm: пилот WW-23 (старт 2026-06-02) — actual?** | по факту action item 1+2 | INTEGRATION_QUEUE Q5 |

После 1-2 — sandbox полностью operational и можно слать первые тестовые upload'ы. После 3 — прогон `npm run eval:golden` даст AC §B.4 цифры.

---

## 6. Известные ограничения пилота (для прозрачности)

1. **LLM = `stub`** на Asha — пока Red Shield VPN-прокси не настроен, реальная extraction через cloud LLM невозможна напрямую. С `X-LLM-*` headers (BYO LLM) можно обойти: ваш ключ → inference подставляет per-request → реальный LLM call. **Это основной режим пилота.**
2. **Per-tenant rate-limit / retention** — пока на уровне хоста. На Asha хостовые значения подходят под sandbox-сценарий, но в проде понадобится миграция организации с extra-параметрами. Не блокер пилота.
3. **Hybrid-routing off** — text-only по умолчанию. Включим когда поймём что vision реально нужен для какой-то категории документов (после первых прогонов golden).
4. **Latency vision** — 186-820с (vs SLA 90с). Это известная проблема, ждём vLLM на GPU-сервере. Для пилота: используем text-only, замеряем где упирается.

---

## Контакты

- **parsdocs technical owner:** Aleksandr Liapustin — `a.liapustin@mod-soft.ru` / `liapustin@gmail.com`
- **Канал для секретов:** PR в `xanderkag/BigBrother/SLAI_SECRETS_INBOX.md`
- **Канал для технических вопросов:** PR/issue в `xanderkag/BigBrother/doc-service/docs/INTEGRATION_QUEUE.md`
