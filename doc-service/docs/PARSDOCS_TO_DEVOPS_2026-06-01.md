# parsdocs → DevOps Asha: status update (revision 2026-06-01)

**Дата:** 2026-06-01
**Заменяет:** `PARSDOCS_TO_DEVOPS_2026-05-31_ASHA_DEPLOY.md`
**Хост:** asha (135.106.158.143)
**Кому:** владелец/DevOps Asha

---

## TL;DR

Состояние Asha **штатное**. 31.05 был deploy `cdbd8d6` → `a920e80` (12 коммитов). 31.05 вечером — cleanup провайдеров в БД (7 фантомных `local-*` удалены). 01.06 ничего нового на сервере не менялось.

От вас — **по-прежнему ничего не нужно сделать прямо сейчас** (за исключением желательного: backup БД + df monitor — см. ниже).

---

## 1. Состояние

| Параметр | Значение |
|----------|----------|
| Domain | `vanga.sls24.ru` (HTTP 200, HTTPS работает) |
| Project (compose) | `app` (`/opt/projects/bigbrother/app/`) |
| Commit deployed | `a920e80` (на момент 31.05 вечера) — `/version` показывает `0.2.0+a920e80` |
| Контейнеры parsdocs | `app-api-1`, `app-worker-1`, `app-inference-1`, `app-postgres-1`, `app-redis-1` — все Up |
| `/ready` | `{"status":"ready"}` |
| Inference | `BACKEND=stub` (не менялось, правило хоста) |
| ASR | `voice-asr` (faster-whisper-cpu) — Up (unhealthy метка не критична, ASR_ENABLED=true) |

---

## 2. Изменения 31.05 (для журнала)

### Deploy 31.05 ~16:00

```
cd /opt/projects/bigbrother/app
git pull origin main           # cdbd8d6 → a920e80
docker compose -f docker-compose.doc-platform.yml build api worker migrate
docker compose -f docker-compose.doc-platform.yml up -d
```

Migrate exit 0, всё штатно.

### .env additions (доплнено 31.05)

В `/opt/projects/bigbrother/app/doc-service/.env`:

```
BYO_LLM_ENABLED=true
FILE_URL_INGEST_ENABLED=true
```

Это включает 2 новые фичи для SLAI пилота (см. ТЗ в репо). Опт-ин флаги.

### БД cleanup 31.05 ~22:00

Удалены 7 фантомных провайдеров из `provider_settings`:
- `local-gemma3-12b`, `local-gemma3-27b`, `local-minicpm-v`, `local-mistral-small-31`, `local-phi4`, `local-tpro-32b`, `local-yandexgpt-lite`

Они были seed'нуты под другую конфигурацию (kb-docker), на Asha без Ollama они только путали UI Providers. Осталось 6 реальных: `anthropic`, `openai`, `qwen-local`, `stub`, `tesseract`, `yandex-vision`.

### БД sandbox-tenant создан 31.05

```
organizations    : 1 строка  (slai-sandbox, type='test')
projects         : 1 строка  (default)
users            : 1 строка  (slai-sandbox-bot, role='org_admin')
personal_access_tokens : 1 строка (hashed, expires +90d)
organization_settings  : 1 строка (output='webhook')
```

`organization_id: 9a3cb9d3-e997-4669-a822-f8294f0dfed3`

---

## 3. Что мониторить

| Что | Команда |
|-----|---------|
| Liveness | `curl -fsS https://vanga.sls24.ru/health` |
| Readiness | `curl -fsS https://vanga.sls24.ru/ready` |
| Version drift | `curl -fsS https://vanga.sls24.ru/version \| jq -r .commitShort` — ожидаем `a920e80` пока не выкатим новое |
| API логи | `docker logs app-api-1 --tail 100` |
| Worker логи | `docker logs app-worker-1 --tail 100` |
| Outbound webhook'и | grep `webhook delivered` / `webhook failed` в api-logs |
| Disk usage | `df -h /var/lib/docker` + `du -sh /opt/projects/bigbrother/app/data` (`STORAGE_DIR`) |

---

## 4. FYI — соседние сервисы (не наше, но видно)

На последней проверке 31.05:
- `slai-api` — Restarting (restart count 15). Если у SLAI команды это in-progress переконфиг — нормально. Если нет — `docker logs slai-api --tail 50`.
- `voice-asr` — Up (unhealthy). Health-check сервера срабатывает с задержкой, но реально отвечает. Парсдок к нему не подключён напрямую сейчас (`ASR_BASE_URL` в `inference-service/.env` пуст).

---

## 5. Что желательно (low priority)

| Что | Когда |
|-----|-------|
| **Backup `app-postgres-1`** (если регулярного нет) | до 2026-06-02 (старт SLAI пилота WW-23) |
| **Disk free monitor** | сейчас 80GB, бэклог за неделю прогрева может съесть 5-10GB |
| **Red Shield VPN-прокси для inference** | когда настроите, прислать `HTTP_PROXY` URL — пропишу в `inference-service/.env` чтобы Anthropic работал без BYO headers (см. MTI-3 в репо) |

---

## 6. Roadmap событий парсдока на ближайшие дни (FYI)

| Дата | Что |
|------|-----|
| 2026-06-02 (понедельник) | WW-23 пилот старт. SLAI шлёт первые webhook'и через sandbox-токен |
| 2026-06-02..04 | Получение S1 envelope от SLAI → положу webhook secret в БД parsdocs |
| 2026-06-02..04 | Получение golden dataset от SLAI → прогон `npm run eval:golden` |
| **Возможна потребность в SSH к Asha** | один-два раза в течение этой недели (положить secret в БД, запустить eval). Обычные read-only мониторинговые команды |

---

## 7. Что НЕ менял

- `API_KEY`, `API_KEYS_JSON`, `SECRETS_ENCRYPTION_KEY`, `ALLOW_NO_AUTH` — не трогал
- `BACKEND=stub` в `inference-service/.env` — оставил (правило хоста)
- nginx/proxy/TLS — не трогал
- Соседние сервисы (slai-*, aicrm-*, bakhus-*) — не трогал
- Никаких новых портов наружу

---

## Контакты

- **parsdocs maintainer:** Aleksandr Liapustin — `a.liapustin@mod-soft.ru`
- **Канал status:** `xanderkag/BigBrother/STATUS.md` + `ROADMAP.md` в git
- **Канал интеграционных вопросов:** `xanderkag/BigBrother/doc-service/docs/INTEGRATION_QUEUE.md`
