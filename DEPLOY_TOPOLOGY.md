# Deploy Topology — parsdocs

> **TL;DR:** parsdocs может крутиться одновременно на нескольких хостах.
> Хосты независимы (свои `.env`, БД, состояние). Не смешивать concerns
> между ними — это два разных параллельных деплоя одного кода.

---

## Активные deploy-таргеты

### 1. `asha` — staging / demo (личный)

| Параметр | Значение |
|----------|----------|
| Хост | `135.106.158.143` (Selectel cloud, личный) |
| Назначение | staging, demo, эксперименты, **SLAI пилот** |
| Источник кода | GitHub-зеркало `xanderkag/BigBrother` |
| Домен | `vanga.sls24.ru` |
| Контейнеры parsdocs | `app-api-1` (3000), `app-worker-1`, `app-inference-1`, `app-postgres-1`, `app-redis-1` — сеть `ai-platform` |
| Inference backend | `stub` по умолчанию (LLM выключен — правило: реальные корп-данные не пускаются на этот хост) |
| LLM в перспективе | через VPN-прокси (Red Shield) к Anthropic/OpenAI — для синтетики и пилота |
| ASR | `voice-asr` (faster-whisper small), `ASR_ENABLED=true`, `ASR_BASE_URL=http://voice-asr:8000/v1` — работает |
| Соседи на хосте | SLAI (`api.sls24.ru`, `app.sls24.ru`, `slai.sls24.ru`), AICRM, Bahus — каждый в своём compose, наружу только nginx 80/443, проксирование по hostname контейнера через сеть `proxy` |
| SSH | через VPN split-tunnel (LaunchDaemon у владельца применяет route автоматически — отдельные команды не нужны) |
| Порт 8085 | **НЕ используется** (это корп-схема другого деплоя, см. ниже) |

**SLAI пилот стартует ЗДЕСЬ.** parsdocs Asha ↔ slai-api на одном хосте через
docker-сеть → быстрый итерационный цикл без корп-деплоя.

### 2. `kb-docker` — corp prod (отдельный track)

| Параметр | Значение |
|----------|----------|
| Хост | внутри корп-сети (`10.10.13.10`) |
| Назначение | corp prod parsdocs |
| Источник кода | отдельный canonical git (НЕ GitHub) |
| Домен | внутренний |
| Порт | 8085 |
| Inference backend | локальный openai_compat (корп-правило: реальные корп-данные только локально) |
| Связь с Asha | **никакой** — два независимых deploy-а одного кода |

**parsdocs тут — отдельный корп-track, не связан с SLAI пилотом.** Свои
секреты, свой `.env`, своя БД, свой operator. **Не путать с Asha.**

---

## Правила работы с топологией

1. **GitHub = источник правды по коду.** Что в `main` — то канон. На каждом
   хосте может быть отстающая копия (`git log --oneline` на хосте покажет
   commit hash). Деплой = `git pull && docker compose up -d --build`.

2. **Параллельные deploy'ы независимы.** Pull на Asha не трогает kb-docker.
   Если меняется поведение (миграция, breaking ENV) — деплоиться на оба
   хоста явно, в нужный момент.

3. **Секреты не пересекаются.** `SECRETS_ENCRYPTION_KEY`, `API_KEY`, ключи
   LLM-провайдеров — у каждого хоста СВОИ. На Asha не должно быть корп-
   секретов, на kb-docker не должно быть личных Anthropic-ключей пользователя.

4. **SLAI пилот = на Asha.** Демо-домен `api.demo.sls24.ru` (callback),
   `app.sls24.ru` (UI SLAI) — всё на Asha. parsdocs Asha там же → удобно.

5. **Доступ агенту (Claude):** SSH к Asha — разово, по явному разрешению
   владельца. К kb-docker — не запрашиваем, корп-track.

---

## Что НЕ топология (а отдельные темы)

- ТАЙПИТ-специфичные ограничения (152-ФЗ, Yandex, корп-нагрузка) — это про
  kb-docker корп-track, **не про parsdocs-проект в целом**. Не вшивать в
  общий код / общие документы.
- LaunchDaemon split-tunnel у владельца — личная конфигурация машины
  владельца, не репо-уровневая вещь.
- vLLM-сервер 96 ГБ VRAM — отдельный inference-хост, не deploy parsdocs'а
  (parsdocs ходит на него по сети как на любой OpenAI-compatible).

---

## История

- 2026-05-29: документ создан после консолидации топологии (parsdocs Asha
  ≠ kb-docker; SLAI на Asha; LLM backend=stub на Asha по правилу personal-
  host'а). До этого в `CLAUDE.md` была вшита kb-docker-specific
  конфигурация — чистил.
