# parsdocs → DevOps Asha: что задеплоили, что мониторить

**Дата:** 2026-05-31
**Хост:** asha (135.106.158.143, Selectel)
**Кому:** владелец/DevOps Asha
**Связано:** `DEPLOY_TOPOLOGY.md` (в репо `xanderkag/BigBrother`)

---

## TL;DR

Сегодня обновил parsdocs на Asha: `cdbd8d6` → `a920e80` (10 коммитов). Включил 2 новых ENV-флага и создал sandbox-тенант для SLAI пилота WW-23. Сервис healthy, ничего не сломано.

**От вас в принципе ничего не нужно** — это staging-update, прошёл штатно. Ниже — что именно поменялось, чтобы было понятно при мониторинге / траблшутинге.

---

## 1. Что задеплоено

| Параметр | Значение |
|----------|----------|
| Project (compose) | `app` (`/opt/projects/bigbrother/app/`) |
| Commit | `a920e80` (был `cdbd8d6`, 4 дня назад) |
| `/version` | `0.2.0+a920e80` |
| `/ready` | `{"status":"ready"}` (postgres + redis + storage_dir доступны) |
| Контейнеры | `app-api-1`, `app-worker-1`, `app-inference-1`, `app-postgres-1`, `app-redis-1` — все Up |
| Migrate | exit 0 (применилось всё накопленное, ничего не упало) |
| Образ | пересобран `doc-service:latest` (api+worker+migrate один image) |

**Команды что выполнял (если будете повторять или делать rollback):**

```bash
cd /opt/projects/bigbrother/app
git pull origin main                                # cdbd8d6 → a920e80
docker compose -f docker-compose.doc-platform.yml build api worker migrate
docker compose -f docker-compose.doc-platform.yml up -d
docker inspect app-migrate-1 --format '{{.State.ExitCode}}'   # должно быть 0
curl -s http://localhost:3000/version                          # проверка коммита
curl -s http://localhost:3000/ready                            # проверка зависимостей
```

**Rollback (если что):**

```bash
cd /opt/projects/bigbrother/app
git reset --hard cdbd8d6                                       # старый commit
docker compose -f docker-compose.doc-platform.yml build api worker migrate
docker compose -f docker-compose.doc-platform.yml up -d
```

---

## 2. Что включил в `.env`

Добавлены в `/opt/projects/bigbrother/app/doc-service/.env`:

```
BYO_LLM_ENABLED=true
FILE_URL_INGEST_ENABLED=true
```

Оба — opt-in флаги для новых фичей (без них новые endpoints возвращают `400 DISABLED`). На Asha разрешено — staging-хост, для SLAI пилота.

**Что эти флаги делают:**
- `BYO_LLM_ENABLED=true` — позволяет клиенту в `POST /jobs` указать свои LLM credentials через `X-LLM-Provider/Api-Key/Model/Base-Url` headers. Ключ шифруется в `metadata._inline_llm_creds` через `SECRETS_ENCRYPTION_KEY` envelope, в логи/события не попадает.
- `FILE_URL_INGEST_ENABLED=true` — позволяет вместо multipart upload передать `file_url` в форме. Сервис скачает с проверкой SSRF (private-IP блок, no-redirect, hard byte-cap mid-stream).

**На рестарт устойчиво** (compose `env_file: .env` подхватывает на каждом start'е). Будет работать после любого `up -d --build`.

---

## 3. Создан sandbox-тенант в БД parsdocs

```
organization_id : 9a3cb9d3-e997-4669-a822-f8294f0dfed3
user_id         : fc9f3f6e-876e-4b07-aef6-7a85d48af698
display_name    : slai-sandbox-bot
role            : org_admin
token expires   : ~2026-08-29 (90 дней)
webhook_url     : https://api.demo.sls24.ru/api/v1/parsdocs/webhook
output mode     : webhook
```

**Изменения в БД** (`app-postgres-1`):
- +1 строка в `organizations` (type='test')
- +1 строка в `projects` (default project)
- +1 строка в `users` (role='org_admin')
- +1 строка в `personal_access_tokens` (hashed, plaintext выдан владельцу один раз)
- +1 строка в `organization_settings` (mode='extract', output='webhook')

Plaintext токен в БД не хранится — только `token_hash` (sha256). Для ротации — `tsx src/scripts/provision-sandbox.ts --name slai-sandbox` (см. `package.json`), но сейчас идёт `name unique check` — нужен `DELETE` сначала.

**Если когда-то понадобится снести sandbox:**

```sql
DELETE FROM organization_settings WHERE organization_id = '9a3cb9d3-e997-4669-a822-f8294f0dfed3';
DELETE FROM personal_access_tokens WHERE user_id = 'fc9f3f6e-876e-4b07-aef6-7a85d48af698';
DELETE FROM users WHERE id = 'fc9f3f6e-876e-4b07-aef6-7a85d48af698';
DELETE FROM projects WHERE organization_id = '9a3cb9d3-e997-4669-a822-f8294f0dfed3';
DELETE FROM organizations WHERE id = '9a3cb9d3-e997-4669-a822-f8294f0dfed3';
```

---

## 4. Что мониторить (новое)

| Что смотреть | Куда |
|--------------|------|
| `app-api-1` логи | `docker logs app-api-1 --tail 100` |
| `app-worker-1` логи | `docker logs app-worker-1 --tail 100` |
| Webhook'и от parsdocs к SLAI | поиск `webhook delivered` / `webhook failed` в api-logs |
| BYO-LLM использование | метрика `extractor_llm_credentials_supplied_total{provider="anthropic"}` (Prometheus, если поднят) |
| LLM-ошибки от провайдера | метрика `extractor_llm_provider_errors_total{code="llm_auth_failed|llm_rate_limited|..."}` |
| `/capabilities` snapshot | `curl localhost:3000/capabilities` — должно содержать `supportedLineFields[]` с 11 элементами |

**Health-чек endpoint для cron / uptime-monitor:**

```bash
# Liveness
curl -fsS http://localhost:3000/health  # → {"status":"ok"} или fail
# Readiness (проверяет postgres+redis+storage)
curl -fsS http://localhost:3000/ready   # → ready / not_ready+error
# Version drift detection
curl -fsS http://localhost:3000/version | jq -r .commitShort  # ожидаем a920e80 пока не выкатим новое
```

---

## 5. FYI — соседние сервисы

При проверке `docker compose ls` заметил что **`slai-api` в Restarting** (restart count 15). Не parsdocs (это другая команда), но если хочется — `docker logs slai-api --tail 50` скажет почему. Если SLAI ещё в работе — может быть нормально (миграции / переконфиг).

Также **`voice-asr` помечен unhealthy** в docker — но parsdocs к нему ещё не подключён (ASR-route в inference готов, но `ASR_BASE_URL` пока ASR-инстансом не настроен в нашем `.env`). Если нужно подключить — `inference-service/.env`:
```
ASR_BASE_URL=http://voice-asr:8000/v1
ASR_MODEL=Systran/faster-whisper-small
```

---

## 6. Что НЕ менял

- Не трогал `API_KEY` / `ALLOW_NO_AUTH` / `SECRETS_ENCRYPTION_KEY` в `.env` — уже были настроены ранее
- Не трогал `BACKEND=stub` в `inference-service/.env` — это правило хоста (нет cloud LLM пока), BYO-LLM обходит ограничение per-request
- Не трогал nginx/proxy/TLS — выставление наружу parsdocs API не менял
- Не трогал `voice-asr`, `slai-*`, `aicrm-*`, `bakhus-*` — это другие сервисы
- Не открывал новых портов наружу

---

## 7. Что от вас желательно (не блокер)

1. **Backup БД** — если у вас есть регулярный pg_dump для `app-postgres-1`, sandbox-тенант (5 новых строк) попадёт в следующий dump автоматически. Если нет — можно ручной dump перед пилотом WW-23 (старт 2026-06-02).
2. **Disk free** — `df -h /var/lib/docker` показать (sandbox прогоны будут писать файлы в `STORAGE_DIR`). Сейчас FILE_RETENTION_DAYS=30 (по умолчанию), при флуде PDF может разрастаться.
3. **VPN-прокси Red Shield** — когда настроите, скажите чтобы прописал `HTTP_PROXY` для inference-service. Тогда смогу включить cloud LLM по умолчанию (без BYO).

---

## Контакты

- **parsdocs maintainer:** Aleksandr Liapustin — `a.liapustin@mod-soft.ru`
- **Канал статусов:** `xanderkag/BigBrother/STATUS.md` + `ROADMAP.md` (в git)
- **Канал интеграционных вопросов:** `xanderkag/BigBrother/doc-service/docs/INTEGRATION_QUEUE.md`
