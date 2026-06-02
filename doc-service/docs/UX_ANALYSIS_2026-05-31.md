# UX-аналитика интерфейса parsdocs — слишком много «инженерного» наружу

**Дата:** 2026-05-31
**Контекст:** после деплоя и попытки вставить Claude key, user обнаружил несколько UX-граблей. «Интеграция с SLAI — боль, мы всё ещё бодаемся. Зачем у нас столько технических вещей выведено в интерфейс?»

**Цель:** свести любую частую задачу к **3 действиям** (вставил → сохранил → нажал тестировать). Скрыть всё что инженерное под `Advanced`. Дать понятные ярлыки вместо `parser_kind`, `confidence_threshold`, `extra (JSONB)`.

---

## Боли, замеченные в этой сессии

### B1. Edit Anthropic — 8 полей, из которых 5 не нужны

Что user видит сейчас при «Изменить → Anthropic Claude»:

```
ID:            anthropic         ← inженерный slug, нельзя поменять — зачем показывать?
Тип:           LLM ▼             ← всегда LLM для Anthropic, не выбор
Название:      Anthropic Claude  ← это можно
Описание:      Hosted Anthropic API. Лучшее качество для...
Base URL:      https://api.anthropic.com  ← дефолт всегда такой, зачем спрашивать?
API key:       ••••••••AQAA      ← это нужно
Модель:        claude-sonnet-4-5 ← это можно, но хочется dropdown а не текст
☑ Активен                       ← да
Extra:         {} или null...    ← инженерное, в 99% не нужно
[Удалить] [Отмена] [Сохранить]
```

**Что реально надо пользователю:** вставить API key, выбрать модель, нажать Save.

**Что показано:** 8 полей, 3 из которых immutable/default, 1 — JSON-textarea для «extra», 1 — описание которое заранее известно.

### B2. 6+ мест где «можно ошибиться»

| Место | Зачем | Реально пользователю надо? |
|-------|-------|----------------------------|
| `/ui/providers` API key | LLM-вызовы | ✅ да |
| `/ui/providers` Base URL | переопределение | ❌ не для Anthropic/OpenAI, всегда дефолт |
| `/ui/providers` Extra JSONB | provider-specific config | ❌ инженерное |
| `/ui/providers` Тип (LLM/OCR) | категоризация | ❌ зависит от выбора провайдера, не свободный выбор |
| `inference-service/.env` `ANTHROPIC_API_KEY` | fallback | ❌ MTI-3 убирает; сейчас путает |
| `inference-service/.env` `BACKEND=stub/claude/...` | runtime backend | ❌ должно выводиться из is_default в /providers, не отдельный ENV |
| `metadata._byo_llm` / `X-LLM-*` headers | per-request override | ⚠️ нужно для SLAI, но это API-level, не UI |
| `metadata._force_provider_id` | dev override | ❌ только для test-lab, не для нормального flow |

### B3. «Не понятно что произойдёт после Save»

- Нажал Save в Providers — что? Перезапустится inference? Подхватится сразу? Через TTL 30s? Нужно ли потом ещё ставить «Активен»? Что значит «default»?
- Нет inline feedback'а: «✅ ключ принят, тест прошёл 3ms» рядом с Save.
- Нет visual indicator «этот провайдер сейчас работает» — есть колонка `Статус: active`, но что значит «active» для пользователя? Что он включён в БД, или что им реально пользуются?

### B4. Нет «happy path» wizard'а

Чтобы подключить Claude как основной — нужно пройти **5 экранов** и понять архитектуру:

1. UI Providers → Edit Anthropic → ввести key → Save
2. Тот же экран → поставить is_default=true (где? — отдельный action?)
3. Понять что `inference-service/.env BACKEND=stub` → переключить на `claude`
4. SSH к серверу → отредактировать `.env`
5. `docker compose restart inference`

Это **5 шагов** и **3 разные системы** (UI / SSH / Docker). Должна быть **одна кнопка «Сделать основным»** в Providers, которая делает всё.

### B5. Технические концепции наружу

User видит:
- `parser_kind: builtin:invoice_regex` — что это?
- `confidence_threshold: 0.700` — для чего? Когда срабатывает?
- `llm_schema: {...}` JSONB — кому это нужно?
- `is_default` vs `is_active` — два чекбокса со схожим смыслом
- `kind: llm` vs `type: LLM` — два поля с одинаковым значением

Это всё инженерное, должно быть **спрятано в Advanced** или **выведено более понятно**.

---

## Принципы упрощения (предложение)

1. **Простой режим по умолчанию.** Видны только: имя, статус (работает/нет), API key, модель, кнопки Test/Save.
2. **Advanced — отдельный toggle.** Под ним: base URL, extra, parser_kind, thresholds, schemas.
3. **Wizard'ы для частых задач.** «Подключить Claude как основной LLM» = одна кнопка, которая делает все 5 шагов.
4. **Inline feedback.** После Save — сразу зелёная галка «✅ работает» или красная «❌ key invalid». Не модалка.
5. **Сценарные ярлыки.** Вместо `parser_kind` — «Как извлекать?» с тремя кнопками (regex / LLM / multi-pass) с подсказками что когда выбирать.
6. **Симметрия с реальностью.** Если на хосте BACKEND=stub, в UI Providers возле Anthropic должно быть **жёлтое предупреждение**: «ключ сохранён, но inference запущен в режиме stub — Claude не будет вызываться. Сделать основным → ».

---

## Конкретный план редизайна (3 эпика UX)

### UX-1: Simple/Advanced toggle для Providers

**Размер:** 1-2 дня UI

**Simple mode** (по умолчанию):
```
Anthropic Claude                                [✅ работает]
─────────────────────────────────────────────────────────
API key:    [•••••AQAA              ] [👁 Показать]
Модель:     [claude-sonnet-4-5 ▼   ] sonnet / opus / haiku
            
[ Тест ]   [ Сохранить ]   [ Сделать основным ]
            
                                  ⓘ показать технические настройки
```

**Advanced mode** (по toggle):
- Добавляются: ID, тип, base URL, extra JSON, descriptions, парсер-настройки

### UX-2: One-click «Сделать основным» wizard

**Размер:** 1 день backend + 1 день UI

Кнопка в Providers → запускает sequence:

1. UPDATE `provider_settings` SET is_default=true, is_active=true для выбранного
2. UPDATE `provider_settings` SET is_default=false, is_active=false для всех остальных того же kind
3. POST `/api/v1/admin/inference/reload` — попросить inference-service переключить BACKEND через runtime API (вместо ENV)
4. Прогнать тест-запрос: `/v1/classify` с фейковым текстом → если 200 → ✅; если 401/5xx → ❌ + rollback

Между шагами — спиннер «Переключаю на Claude...» → финальный toast «✅ Claude теперь основной LLM».

**Требует:** новый endpoint в inference-service для runtime smene backend (сейчас только через ENV + рестарт). MTI-3 (unify key storage) — частично перекрывает.

### UX-3: Статусные ленты вместо магии

**Размер:** ½ дня UI

На главной странице (Dashboard или Top-bar) добавить **System Health** строку:

```
🟢 parsdocs работает • LLM: Claude (anthropic) • OCR: Tesseract • Inference: ready
🟡 LLM не настроен — открыть /providers
🔴 Inference недоступен — проверьте контейнер app-inference-1
```

Каждое статус-сообщение — кликабельная ссылка на нужный экран. Пользователь сразу видит **что сломано** и **куда идти чинить**.

Источник данных: `/capabilities` уже отдаёт enablement-флаги; добавить `currentLlmProvider`, `currentOcrEngine`, `inferenceReady`. Полить в Dashboard через React Query.

---

## Связь с MTI

| Эпик | Перекрытие с UX | Когда делать |
|------|------------------|--------------|
| **MTI-3** unify key storage | UX-1 «Simple mode» имеет смысл только после MTI-3 — иначе ключ всё равно в .env лежит | MTI-3 первым (как и было) |
| **MTI-2** model preset bundles | UX-1 dropdown модели = именно pack из MTI-2 | MTI-2 → UX-1 |
| **MTI-1** multi-instance management | UX-3 System Health расширяется до per-consumer статусов | MTI-1 → UX-3 |

То есть:
1. **MTI-3** (1-2 дня) — backend, никакого UI
2. **UX-1 Simple/Advanced** (1-2 дня) — UI поверх MTI-3
3. **MTI-2** (2-3 дня) + **UX-2 Wizard** (2 дня) — pack моделей + one-click
4. **UX-3** + **MTI-1** (2-3 недели вместе) — multi-instance UI с health

---

## Чего НЕ делаем (явный YAGNI)

- Полный no-code wizard «создать провайдера с нуля» — для Anthropic/OpenAI и так дефолты стандартные, custom-провайдеров не больше 1-2 в год
- AI-помощник в UI — overkill
- Тёмная/светлая тема настройки — есть system default, не приоритет
- Локализация UI на английский — пользователь и так знает русский; SLAI команда тоже русскоязычная

---

## Acceptance — критерий простоты

Главный сценарий: **«подключить Claude»** должен делаться за **3 действия и 30 секунд**:

1. Открыть `/ui/providers`, кликнуть Anthropic
2. Вставить API key (или paste)
3. Нажать «Сохранить и сделать основным» → дождаться зелёной галки

Без SSH, без .env, без рестартов. Без объяснений «что такое default vs active». Если это не достигнуто — UX-1 + UX-2 + MTI-3 не зачтены.

---

## Открытые вопросы

1. **Где живут пользовательские preferences?** (Simple/Advanced toggle сохраняется per-user или per-browser?)
2. **Что делать с уже существующими advanced полями** (parser_kind, llm_schema)? Скрыть в Advanced — кто будет их редактировать когда нужно? Только super_admin?
3. **Wizard «Сделать основным» при переключении провайдера** — нужно ли подтверждение «вы уверены»? (риск — обнулить работающую конфигурацию)
4. **«System Health» строка vs скрытый чекап** — лента сверху всех страниц или только Dashboard?

---

## История

- 2026-05-31: написано после деплоя a920e80 и user-фидбэка «зачем 8 полей,
  нет happy path, путаюсь куда вставлять ключ». Три эпика UX-1/2/3 +
  привязка к MTI-1/2/3 для sequencing.
