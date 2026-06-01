# parsdocs → SLAI: sandbox операционен, статус и action items (revision 2026-06-01)

**Дата:** 2026-06-01
**Заменяет:** `PARSDOCS_TO_SLAI_2026-05-31_SANDBOX_READY.md` (учитывает изменения 31.05 вечером + 01.06 утром)
**От:** parsdocs
**Кому:** SLAI dev / Aleksandr Liapustin
**Связано:** `PARSDOCS_REPLY_TO_SLAI_FOLLOWUP_2026-05-29.md`, `SLAI_SECRETS_INBOX.md`, `MTI_TZ_2026-05-31.md`, `UX_ANALYSIS_2026-05-31.md`

---

## TL;DR

✅ parsdocs Asha поднят до коммита **`95cf5df`** (12 коммитов с 29.05: EXT-LINE, OpenAPI extend, capabilities `{name, since}`, BYO_LLM, file_url, hybrid-routing, MTI/UX ТЗ).
✅ Sandbox-тенант создан (`organization_id: 9a3cb9d3-…`), токен сгенерирован — ждёт ваш age public key для envelope.
✅ Наш age public key опубликован в `SLAI_SECRETS_INBOX.md`: `age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq`
✅ Провайдеры в БД почищены — оставлены только реальные (anthropic, openai, qwen-local, stub, tesseract, yandex-vision). 7 фантомных `local-*` удалены.

**От вас 2 вещи + 1 confirm:**
1. **Ваш age public key** — чтобы зашифровать токен sandbox (S2)
2. **S1 envelope** (`PARSDOCS_WEBHOOK_SECRET` под наш age key) — для webhook auth
3. **Confirm WW-23 пилот старт 2026-06-02 ещё актуален?**

---

## 1. Состояние Asha сейчас (2026-06-01)

| Параметр | Значение |
|----------|----------|
| Домен / UI | `https://vanga.sls24.ru/ui/` |
| API endpoint | `https://vanga.sls24.ru/api/v1/jobs` |
| Health (public) | `/health`, `/ready`, `/version`, `/capabilities` |
| Commit deployed | `95cf5df` (0.2.0+95cf5df или a920e80 — зависит от пересборки) |
| LLM backend | `stub` (правило хоста). **Реальный LLM работает только через BYO путь** (см. ограничение MTI-3 ниже) |
| `BYO_LLM_ENABLED` | `true` — ваш `X-LLM-Api-Key` header реально вызывает Anthropic |
| `FILE_URL_INGEST_ENABLED` | `true` — поддерживаем `POST /jobs {file_url}` |
| `HYBRID_ROUTING_ENABLED` | off (включим если потребуется vision-fallback) |
| ASR | работает (`voice-asr` faster-whisper), `ASR_ENABLED=true` |
| `/capabilities` | 26 типов + 11 line fields + 4 doc fields, формат `{name, since}` |

---

## 2. Sandbox-тенант (для contract-test'ов)

```
organization_id : 9a3cb9d3-e997-4669-a822-f8294f0dfed3
user_id         : fc9f3f6e-876e-4b07-aef6-7a85d48af698
token_name      : slai-sandbox-bot
token expires   : 2026-08-29 (90 дней)
role            : org_admin
webhook_url     : https://api.demo.sls24.ru/api/v1/parsdocs/webhook
output mode     : webhook
```

**Bearer token** ждёт ваш age public key для envelope.

**Параметры (FOLLOWUP §AC9 принято):**
- ✅ Separate organization
- ⚠️ Retention/rate-limit на хостовом уровне (per-tenant в БД пока нет — MTI-1 это починит). Сейчас не блокер пилота

---

## 3. Известное ограничение MTI-3 — куда ключ Anthropic реально доходит

> **Это новое — выявлено 31.05 вечером, важно для пилота.**

Архитектурно ключи LLM сейчас лежат в **3 разных местах**:

| # | Где | Используется когда |
|---|-----|---------------------|
| 1 | `provider_settings.api_key` (UI Providers, БД) | inter-service auth doc→inference (legacy) |
| 2 | `inference-service/.env::ANTHROPIC_API_KEY` | если `BACKEND=claude` (у нас stub) |
| 3 | **`X-LLM-Api-Key` header per-request (BYO)** | **сейчас единственный реально работающий путь** |

**Что это значит для пилота:**

- Вставить ключ Anthropic в UI Providers — НЕ запустит Claude (это inter-service auth, не Anthropic call). Это **архитектурный bug**, ТЗ MTI-3 описывает фикс (1-2 дня).
- **Единственный работающий путь сейчас: SLAI шлёт `X-LLM-Api-Key` в каждом запросе.** Это правильно и для будущего (multi-consumer, разные ключи у разных клиентов).

Если SLAI хочет fall-back на статичный Anthropic ключ (без `X-LLM-*` headers) — нужно дождаться MTI-3 (1-2 дня после WW-23 пилот-старта). На пилоте обходим через BYO header — оно уже работает.

---

## 4. Наш age public key (для S1 envelope)

```
age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq
```

Сгенерирован age v1.2.1 на машине владельца parsdocs.

**Как зашифровать ваш webhook secret:**

```bash
echo "PARSDOCS_WEBHOOK_SECRET=$(openssl rand -hex 32)" > /tmp/s1.txt
age -r age1xn6dalaepv98wve3a7te2pkyhzp8jawwkt9f4df4t3zw4e84tgkqed5wcq \
    -a /tmp/s1.txt > /tmp/s1.age.txt
shred -u /tmp/s1.txt
cat /tmp/s1.age.txt
```

Содержимое `s1.age.txt` → PR в `xanderkag/BigBrother/SLAI_SECRETS_INBOX.md` блок S1.

---

## 5. Контракт

### Вы → parsdocs

```http
POST https://vanga.sls24.ru/api/v1/jobs
Authorization: Bearer <sandbox-token>
X-LLM-Provider: anthropic           ← required для реального LLM сейчас
X-LLM-Api-Key: <ваш Anthropic key>
X-LLM-Model: claude-sonnet-4-5      ← опционально (default есть)
Content-Type: multipart/form-data

file=<PDF>
```

Либо file_url:
```http
POST /api/v1/jobs?file_url=https://your-storage.../doc.pdf&file_sha256=<hex>
Authorization: Bearer <sandbox-token>
X-LLM-Api-Key: <ваш key>
...
```

### parsdocs → ваш webhook

```http
POST https://api.demo.sls24.ru/api/v1/parsdocs/webhook
X-Extractor-Signature: sha256=<hmac>   ← preferred, новый ExtractorGateway
X-Parsdocs-Signature: sha256=<hmac>    ← back-compat
X-DocService-Signature: sha256=<hmac>  ← legacy
X-Extractor-Job-Id / X-Extractor-Attempt
Content-Type: application/json

{job_id, status, extracted: {items[], period_from/to, contract_no/date, ...}, ...}
```

HMAC = `hmac_sha256(PARSDOCS_WEBHOOK_SECRET, raw_body)` — secret из S1.

### Polling fallback

```http
GET https://vanga.sls24.ru/api/v1/jobs/<job_id>
Authorization: Bearer <sandbox-token>
```

---

## 6. Что от вас нужно (action items, обновлено)

| # | Что | ETA | Канал |
|---|-----|-----|-------|
| 1 | **Ваш age public key** | сегодня (2026-06-01) | PR в `SLAI_SECRETS_INBOX.md` либо строка в Telegram |
| 2 | **S1 envelope** webhook secret под наш age key | 2026-06-01..02 | PR в `SLAI_SECRETS_INBOX.md` S1 |
| 3 | **Golden dataset** 13 PDF + .gt.json | 2026-06-02..04 | PR в `doc-service/test-fixtures/slai-golden/` |
| 4 | **Confirm WW-23 пилот старт 2026-06-02** | сегодня | INTEGRATION_QUEUE Q5 либо чат |

---

## 7. Известные ограничения (всё что повлияет на пилот)

1. **LLM = `stub`** на хосте → только BYO путь работает (MTI-3 чинит, после пилота).
2. **Per-tenant rate-limit/retention** — пока глобальные (MTI-1 чинит).
3. **Hybrid-routing off** — text-only по умолчанию.
4. **Latency vision** 186-820с (vs SLA 90с) — vLLM на GPU-сервере поможет позже.
5. **Цепочка ключа Anthropic** — UI Providers ключ не доходит до Claude (MTI-3). Workaround: BYO headers.

Эти 5 пунктов **не блокируют WW-23 пилот** через BYO путь. После пилота сделаем MTI-3 → UI Providers тоже заработает.

---

## 8. Что нового в коде с 29.05 (12 коммитов, для контекста)

| Commit | Что |
|--------|-----|
| `42adffc` | EXT-LINE — 10 транспортных полей в items[] |
| `bc72046` | OpenAPI v1.yaml extend под EXT-LINE |
| `a920e80` | age install/encrypt docs в SECRETS_INBOX |
| `d379010` | Asha pilot live, sandbox provisioned |
| `bfa9353` | Ready-to-send сообщения |
| `ad39087` | Canonical domain → vanga.sls24.ru |
| `5e4a43c` | MTI-1/2 ТЗ (multi-instance + model bundles) |
| `06b6a25` | MTI-3 (unify key storage) |
| `95cf5df` | UX-1/2/3 ТЗ (Simple toggle, wizard, health bar) |

---

## Контакты

- **parsdocs owner:** Aleksandr Liapustin — `a.liapustin@mod-soft.ru` / `liapustin@gmail.com`
- **Канал секретов:** PR в `xanderkag/BigBrother/SLAI_SECRETS_INBOX.md`
- **Канал технических вопросов:** PR/issue в `xanderkag/BigBrother/doc-service/docs/INTEGRATION_QUEUE.md`
