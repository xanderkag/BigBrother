# Tech debt

Список задач, накопленных при scaffold'е (doc-service + inference-service). Структура — по серьёзности и срочности. Когда берёте задачу — отметьте «in progress» и закрывайте PR'ом со ссылкой на пункт.

---

## Закрыто в этой итерации

### Базовые проверки границ
- ✅ **C2** Worker concurrency дефолт = 1, конфигурируется через `WORKER_CONCURRENCY`.
- ✅ **B1** Cap 64 KB на поле `metadata` при `POST /jobs`.
- ✅ **B2** Sanitize имени файла пропускает юникодные буквы и цифры (Cyrillic больше не превращается в `_______`).
- ✅ **I7** Усиленное предупреждение про ПДн и Yandex Vision в `.env.example`.
- ✅ Reject 0-byte uploads на `POST /jobs`.
- ✅ Валидация формата `webhook_url` (только http/https).

### Доменная валидация (новый слой)
- ✅ **Уровень 4** — российские реквизиты:
  - `validateInn` с официальной checksum (10 и 12 цифр, приказ ФНС).
  - `validateKpp` (формат NNNNCCNNN, 9 символов).
  - `validateVehiclePlate` (только 12 разрешённых ГИБДД букв, формат А123ВВ77).
  - `validateCountryCode` (ISO 3166 alpha-2).
  - `validateDate` с диапазоном (после 2010, не далее 30 дней в будущем).
  - `validateMoney` (≥0, конечно, < 1 трлн).
- ✅ **Уровень 5** — согласованность полей:
  - `validateVatConsistency` (vat ≈ total × rate / (100+rate), толерантность 0.5%).
  - `validatePositionsSum` (∑positions.total ≈ total, толерантность 1%).
  - `validatePartiesDiffer` (продавец ≠ покупатель).
  - Для ТТН: масса нетто не больше брутто.
- ✅ Композер `validateExtracted` запускает нужный набор по типу документа.
- ✅ Issues сохраняются в `extracted._issues`, поднимаются в API как `validation_issues: string[]`.
- ✅ После доменной валидации с issues статус автоматически = `needs_review`.
- ✅ PATCH /extracted перевалидирует — корректировка человека убирает issues.

### Операционные пробники
- ✅ **Уровень 7** — `/ready` теперь проверяет: PostgreSQL `SELECT 1`, Redis `PING`, `STORAGE_DIR` writable. Любой провал — 503 со списком в `error`.

### Phase 1 Day 1 — фундамент operational layer (2026-05-11)

- ✅ **C1** Outbox/poller для зависших pending jobs — `src/workers/pending-job-sweeper.ts`. Каждую минуту вычитывает `WHERE status='pending' AND age > grace`, переенки в BullMQ с тем же `jobId` (BullMQ дедупит). Конфиг: `PENDING_SWEEPER_INTERVAL_MS`, `PENDING_SWEEPER_GRACE_SECONDS`.
- ✅ **C4** TTL cleanup uploaded файлов — `src/workers/file-cleanup.ts`. Раз в час чистит файлы по job'ам в финальном статусе старше `FILE_RETENTION_DAYS` (по умолчанию 30). DB-row сохраняется (audit), файл и пустой каталог удаляются, `file_path` NULL'ится.
- ✅ Structured logs с `request_id` через весь pipeline — Fastify `genReqId`, propagation в BullMQ payload, worker создаёт child-логгер с привязкой `request_id`/`job_id`/`bull_id`. Заголовок `X-Request-Id` принимается на вход и возвращается клиенту.
- ✅ Тесты на оба sweeper'а с мок-репо: stale=пусто, multi-row, ошибка enqueue не валит цикл, overlap guard, ошибка unlink не маркирует row deleted.

### Phase 1 Day 2 — operator UI (2026-05-11)

- ✅ Полноценный UI на `/` — htmx-friendly HTML + Tailwind v3 Play CDN + Alpine.js, без build-шага. Login по API-токену в localStorage, dark mode, sidebar layout. Views: jobs list (auto-refresh для in-flight, фильтры, status-badges, confidence bars), job detail (JSON-viewer для extracted, validation_issues панель, edit mode → PATCH с перевалидацией, RAW OCR text в `<details>`), upload (drag-and-drop + optional fields), settings (placeholder).

### Phase 2 Day 1 — ClaudeBackend + Settings (2026-05-11)

- ✅ **ClaudeBackend** в inference-service через `anthropic` SDK. Поддерживает classify / extract / vision-ocr / verify. Lazy-import — stub-образу не нужен.
- ✅ `/v1/providers/status` в inference-service — без leak'а секретов сообщает какие провайдеры настроены, какой активен.
- ✅ `/api/v1/settings` и `/api/v1/providers/status` в doc-service. Settings возвращает sanitized snapshot (без секретов), providers/status проксируется к inference c graceful degradation.
- ✅ Settings UI переделан в живой dashboard: LLM providers с active/configured badges, OCR thresholds, engines state (Yandex с ПДн-warning если включён), storage/sweepers/limits/endpoints/session.

### Phase 2 Day 2 — Idempotency-Key + magic-bytes (2026-05-11)

- ✅ **I1 Idempotency-Key** — новая миграция `002_idempotency.sql` (partial unique index, NULL keys не конфликтуют). `POST /jobs` читает заголовок до парсинга multipart'а; если ключ уже использован → HTTP 200 с `Idempotency-Replayed: 1` и существующим job_id. Race condition (две параллельных POST'ов с одним key) ловится unique violation на INSERT и резолвится в SELECT + удаление дублирующего файла. Валидация ключа: 1-64 символа, `[A-Za-z0-9._-]`.
- ✅ **B5 file magic-bytes validation** — пакет `file-type ^19.6`. После сохранения файла читаются magic bytes; если детектируется не из `ACCEPTED_DOCUMENT_MIMES` (PDF/JPEG/PNG/BMP/TIFF/WebP) — 400 и удаление файла. Если detected mime ≠ declared multipart Content-Type — detected становится authoritative (логируется warning). Защита от exe-под-видом-PDF, расширения vs реальный формат, и подобного.
- ✅ Тесты: `tests/idempotency.spec.ts` (header parsing, unique-violation detector), `tests/magic-bytes.spec.ts` (PDF/PNG/JPEG/BMP/WebP по реальным magic bytes, рейект plaintext/exe, обнаружение mislabelled PDF).

### Phase 3 Day 23 — Operational dashboard (2026-05-12)

Закрыт долг «метрики есть, в UI их не видно». Из тех же критериев,
что и в eval'е, выделили подмножество, которое можно посчитать
ИЗ БД без эталонов (status, latency, LLM-расход) — и сделали
живой operational-дашборд. Accuracy и field-coverage остаются за
golden-set'ом (это правильно — без ground-truth их посчитать
невозможно).

- ✅ `storage/jobs.ts:getOperationalSummary(windowHours, scope)` —
  один SQL-аггрегатор. Перцентили через `percentile_cont WITHIN
  GROUP (ORDER BY …)` без выгрузки строк в Node. Tenant-scope
  применяется автоматически через `getEffectiveScope`. Empty
  projects-scope короткозамыкает в emptySummary, чтобы не делать
  лишний SQL на пустой набор.
- ✅ `routes/operational-metrics.ts`: GET /api/v1/metrics/operational
  с `?window=1h|24h|7d|30d`. zod-схема ответа, авто-фильтр под
  текущего user'а, swagger description с явной отсылкой к eval'у
  для accuracy.
- ✅ UI: новая вкладка «Dashboard» в sidebar (первая, default). 4
  топ-карточки (total / done / needs_review / failed) + bar
  validation issues + 2 карточки latency и LLM-tokens + per-type
  таблица. Window-switcher (1h / 24h / 7d / 30d) с persist в
  localStorage, auto-refresh 30 сек, cleanup на uhod со страницы.
  Бэйджи на rates окрашены по порогам (good / warn / bad) — за 5
  сек видно «горит или ок».
- ✅ Тесты (`tests/operational-summary.spec.ts`): empty-scope
  short-circuit, shape-трансформация полной выборки, total=0 без
  делений на ноль, scope-параметры (org / projects ANY-array) —
  5/5 passed.

Что не закрыто (вне этой итерации):
- Time-series график (сейчас точечная сводка за окно). Нужен
  материализованный rollup по часам, чтобы рисовать sparkline без
  тяжёлых ad-hoc SQL'ей.
- Алёрты на пороги (needs_review > 40% → notify). Сначала нужен
  механизм нотификаций.
- Стоимость в рублях/долларах: токены × прайс. Прайсы лежат
  per-provider, пока не вынесли в config.

### Phase 3 Day 22 — Golden-set eval harness (2026-05-12)

Закрыт долг #1 из списка «до серверного прогона»: появилась цифра
качества пайплайна, которой можно меряться до/после изменения промпта,
модели или цепочки OCR. Без него любые «улучшения» — на глаз.

- ✅ `src/scripts/eval/compare.ts`: компараторы по типам (money,
  percent, date, inn/kpp/account, plate, country, integer, number,
  string). Money tolerance ±0.01, дата — нормализация в ISO, цифры —
  digits-only. Различие missing vs mismatch отдельной вердиктой —
  coverage и accuracy считаются как разные метрики.
- ✅ `src/scripts/eval/schema.ts`: zod-схема golden-set.json. Один
  файл описывает: instance + token + project_id + список фикстур.
  На фикстуру: file, опц. document_type_hint/metadata, expected
  document_type/terminal_status/no_issues/max_total_duration_ms/fields.
- ✅ `src/scripts/eval/run.ts`: runner. POST /jobs → poll → comp.
  Печатает per-fixture verdict с mismatch'ами и aggregate-таблицу:
  classification accuracy, field coverage, field exact-match,
  needs_review/failed/validation issue rate, latency P50/P95,
  LLM tokens P95 in/out, LLM-fallback rate. Опц. JSON-out для CI.
- ✅ `npm run eval` + `--fail-on-mismatch` для CI gating.
- ✅ README: формат golden-set, описание компараторов, пороги для
  деплоя (classification ≥0.95, exact-match ≥0.85, regression-
  guard: падение exact-match >2 п.п. = блокер).
- ✅ `golden-set.example.json` — рабочий пример с тремя фикстурами.
- ✅ `tests/eval-compare.spec.ts`: 36 тестов на все компараторы,
  включая разные surface-форм (1234.56 vs "1 234,56 ₽" vs 1234,56),
  inferKind по path (vat_rate→percent, carrier.inn→inn, plate→plate)
  и tracking missing-vs-mismatch.

Дальнейшее (вне этой итерации):
- Per-document-type aggregation в отчёте (сейчас только overall).
- Сборка golden-set'а из реальных prod-jobs (replay из БД).
- Grafana-панель, читающая report.json после ночного прогона.

### Phase 3 Day 21 — Multi-token: label + expires_at + last_used_at (2026-05-14)

Закрыт UX-долг из фазы 2 multi-tenant'а: каждый user теперь имеет
несколько именованных токенов с опц. сроком действия. Можно выдавать
отдельные под CI / IDE / автоматизации и отзывать по одному без
обнуления остальных.

- ✅ Миграция 010: `personal_access_tokens` с (id, user_id, name,
  token_hash, expires_at, last_used_at, created_at), UNIQUE
  (user_id, name) и UNIQUE-индекс token_hash для быстрого lookup.
- ✅ `storage/tokens.ts`: create/findById/findByHash/listByUser/
  revoke/touchLastUsed/revokeAllForUser + static isExpired. toApi
  маскирует token_hash.
- ✅ Auth-хук: сначала ищем в personal_access_tokens (с проверкой
  expires_at), fallback на legacy users.api_token_hash. Уже выданные
  однотокенные ключи продолжают работать.
- ✅ Routes: GET /users/:id/tokens, POST /users/:id/tokens (name +
  expires_at), DELETE /tokens/:id. ACL: super_admin / org_admin
  своим / user себе.
- ✅ touchLastUsed асинхронный из auth-хука — не блокирует hot-path.
- ✅ Legacy endpoints сохранены без изменений — работают на
  users.api_token_hash. UI пока через них; multi-token UI — отдельно.
- ✅ Тесты: isExpired + toApi маска (нет утечки hash, ISO даты).

Дальнейшее:
- UI в Tenants → Users: list токенов с подписями / экспирацией.
- Sweeper expired tokens.
- Дропнуть users.api_token_hash отдельной миграцией через 2-3 мес.

### Phase 3 Day 20 — metadata sanitization (2026-05-14)

Закрыт security-долг: client-supplied `metadata` теперь фильтруется на
секреты перед записью в БД и эхо-возвратом в webhook.

- ✅ `storage/metadata-sanitizer.ts` — рекурсивный walk с двумя
  стратегиями редакции:
  1. По имени ключа: `password / token / api_key / secret /
     authorization / private_key / access_key / refresh_token /
     client_secret` (case-insensitive) — значение всегда заменяется
     на `[REDACTED: key=<имя>]`.
  2. По префиксу значения: `sk-ant-`, `sk-`, `AKIA[0-9A-Z]{16}`,
     `ya29.`, `ghp_`, `github_pat_`, `pdpat_`, `xox[abp]-`,
     `pk_/rk_(live|test)_` и пр. — `[REDACTED: <reason>]`.
- ✅ MAX_DEPTH=8 защита от циклов / атак-на-глубину.
- ✅ `POST /jobs` применяет sanitize перед `jobsRepo.create`; если
  что-то редакти'ли — warn в лог с количеством редакций (оператор
  видит «вот тут клиент попытался передать секрет»).
- ✅ Числа/boolean/null проходят как есть; нестрого по value-pattern
  (требует ≥20 chars подходящего символьного набора), чтобы не
  закрашивать нормальные строки типа `sk-short`.
- ✅ Тесты: 20+ кейсов via it.each — все имена ключей, все префиксы,
  вложенные объекты, массивы, recursion-limit, edge-cases с null.

Дальнейшее (если понадобится):
- Добавить allowlist через env (для случаев когда клиент ДОЛЖЕН
  слать что-то выглядящее как ключ — например, hash коммита).
- Расширить детекцию: длинные base64 / hex строки без known-префикса.
  Сейчас консервативно — лучше пропустить экзотический секрет, чем
  закрасить обычное значение.

### Phase 3 Day 19 — Rotate master-ключа secrets (2026-05-14)

Закрыт открытый пункт из «secrets at rest» — теперь смена
`SECRETS_ENCRYPTION_KEY` не требует ручного перевода всех ключей
провайдеров заново.

- ✅ `encryptWithKey/decryptWithKey/parseHexKey` — explicit-key
  криптофункции в `storage/secrets.ts`. Обычный hot-path
  `encryptSecret/decryptSecret` теперь тонкие обёртки над ними.
- ✅ `src/scripts/rotate-secrets.ts` + `npm run rotate:secrets`. Аргументы
  `--from <OLD-64hex> --to <NEW-64hex>`, dry-run по умолчанию, `--apply`
  для записи. Атомарная транзакция, rollback при ошибке.
- ✅ Поведение по типам строк:
  - encrypted-под-OLD → перешифровывается под NEW;
  - legacy plaintext → первая попытка шифрования под NEW;
  - не дешифровалось под OLD → abort до любых изменений (защита от
    промежуточно скомпрометированных ключей или неверного OLD).
- ✅ Тесты в `tests/secrets.spec.ts`: round-trip с explicit ключом,
  auth-failure при разных ключах, полный rotate-цикл, parseHexKey
  валидация, legacy plaintext bypass.

Использование при компрометации:
```
openssl rand -hex 32                          # новый ключ
npm run rotate:secrets -- --from <OLD> --to <NEW>          # dry-run
npm run rotate:secrets -- --from <OLD> --to <NEW> --apply  # боевой
# пропишите NEW в env, рестарт api+worker, старый ключ сотрите
```

### Phase 3 Day 18 — Multi-tenant фаза 2: tokens + authz + switcher (2026-05-13)

Закрыт spec multi-tenant. Реальные пользовательские токены, гарды ролей,
переключатель рабочего пространства. Теперь два менеджера в одной
инсталляции реально не видят документы друг друга.

Personal access tokens:
- ✅ `users.api_token_hash` с UNIQUE-индексом (миграция 009).
- ✅ Формат plaintext: `pdpat_<base64url-32-bytes>`. В БД лежит только
  sha-256 хэш. Plaintext возвращается ровно один раз при генерации.
- ✅ `POST /users/:id/token` — выдать/ротировать; `DELETE /users/:id/token` —
  отозвать. Право: super_admin кому угодно, org_admin своим юзерам,
  пользователь — себе.
- ✅ `auth.ts` rewriten: bearerAuthHook принимает `API_KEY` (root → system
  super_admin) ИЛИ personal token (lookup по хэшу). `req.user` —
  полный контекст с row из БД для downstream authz.

Authorization (`authz.ts`):
- ✅ Гард-функции: requireSuperAdmin, requireOrgAdmin, requireOrgAccess,
  requireProjectAccess, requireProjectWrite. Возвращают boolean —
  caller прерывается по false (статус уже отправлен).
- ✅ getEffectiveScope — резолвит auto-фильтр по user'у: super_admin
  видит всё, org_admin — свою орг, manager/viewer — свои проекты.

Routes guards:
- ✅ Jobs:
  - POST /jobs → requireProjectWrite (нужен manager+admin к проекту).
  - GET /jobs/:id → requireProjectAccess (read).
  - PATCH /jobs/:id/extracted, POST /jobs/:id/reprocess → requireProjectWrite.
  - GET /jobs → автоматически фильтрует по scope'у пользователя.
- ✅ Tenants:
  - GET /organizations, /projects, /users — фильтруются по scope'у.
  - POST /organizations → requireSuperAdmin.
  - POST/PUT /projects → requireOrgAdmin своей орг.
  - POST/PUT /users → super_admin или org_admin своей орг
    (org_admin не может создать super_admin'а).
- ✅ Document Types и Provider Settings: write-операции — только super_admin.
  Read остаётся доступным всем аутентифицированным.

UI:
- ✅ Workspace switcher в sidebar — дропдаун доступных проектов.
  Persist в localStorage (`parsdocs.workspace`). При выборе route()
  перерисовывается — jobs list автоматически фильтруется, новые
  job'ы создаются с выбранным project_id. Для одного проекта
  switcher скрыт (нечего переключать).
- ✅ Token management в Tenants → Users: кнопки «⟳ token» и «×» рядом
  с каждым юзером. Plaintext-токен попадает в буфер обмена + alert
  с явным предупреждением «сохраните сейчас, потом не увидите».
- ✅ Колонка «Token» с badge'ом set / no token.

Acceptance criteria из спеки multi-tenant полностью закрыты:
- ✅ Каждый document_job связан с organization_id и project_id.
- ✅ Default org/project для совместимости.
- ✅ История фильтруется по org/project (бэкенд auto-scope + UI switcher).
- ✅ super_admin видит все документы.
- ✅ **Обычный пользователь не видит чужие документы** — теперь enforce'ится.
- ✅ Архитектура позволяет подключать внешних клиентов: создаём org через UI,
  добавляем org_admin'а, выдаём ему токен, дальше он сам управляет своими
  проектами/пользователями.

Открытое (можно отложить, не блокер):
- Audit log в UI не имеет scope-фильтра по org (бэкенд готов).
- document_types и provider_settings всё ещё глобальные. Tenant'ить
  их когда первому клиенту понадобятся свои типы / свой Claude-ключ.
- Login form не показывает «как залогиниться personal token'ом» —
  работает прозрачно (тот же ввод bearer), но UX подсказки нет.
- Tokens не имеют label'а и срока годности — однотокенная модель.
  Когда понадобится «несколько токенов на одного юзера» (CI vs обычный)
  — отдельная таблица personal_access_tokens.

### Phase 3 Day 17 — Multi-tenant фундамент (фаза 1) (2026-05-13)

Заложена структура под обслуживание нескольких клиентов. Минимальный
вариант из спецификации: таблицы + scope на jobs + дефолтный tenant +
базовые API/UI. Реальный per-user auth и enforcement ролей —
отдельные волны, заложено архитектурно.

Структура БД (миграция 008):
- ✅ `organizations` — корневой tenant (type: internal_division /
  external_company / test / system).
- ✅ `projects` — рабочее пространство внутри организации, `settings`
  JSONB резерв под project-level конфиг.
- ✅ `users` — пользователи с глобальной ролью (super_admin / org_admin /
  manager / viewer). Поле `api_token_hash` заложено под personal access
  tokens (NULL пока единый Bearer API_KEY).
- ✅ `user_project_access` — N:M user × project с проектной ролью
  (admin / manager / viewer). UNIQUE по (user, project).
- ✅ `jobs.organization_id`, `jobs.project_id`, `jobs.created_by_user_id` —
  scope-колонки, NOT NULL. Существующие job-ы backfill'ятся к SYSTEM-org/
  Default-проекту через DO-блок в той же миграции.
- ✅ `audit_log.organization_id`, `audit_log.actor_user_id` — nullable,
  чтобы системные операции писались без user-контекста.
- ✅ Seed: System-org, Default-проект, System-user (super_admin) с
  стабильными UUID-константами (см. `tenant-constants.ts`).

Backend:
- ✅ Repos: organizationsRepo / projectsRepo / usersRepo с CRUD'ом и
  toApi масками.
- ✅ Auth: `req.user` контекст заполняется в `bearerAuthHook` — сейчас
  всегда системный super_admin. Под будущие personal tokens / OAuth.
  Экспортированы `SYSTEM_DEFAULT_ORG_ID` / `SYSTEM_DEFAULT_PROJECT_ID`.
- ✅ Routes под `/api/v1/`:
  - GET/POST/PUT `/organizations`, `/organizations/:id`
  - GET/POST/PUT `/projects`, `/projects/:id` (с фильтром `?organization_id`)
  - GET/POST/PUT `/users`, `/users/:id` (с фильтром `?organization_id`)
  - GET/POST/DELETE `/users/access` (grant/revoke role в проекте, upsert по UNIQUE)
- ✅ POST `/jobs`: новые multipart-поля `project_id` и `organization_id`
  (опц.). Если не заданы — фоллбэк на default scope пользователя.
- ✅ GET `/jobs`: query-фильтры `organization_id` и `project_id`. Свободные
  для super_admin'а.

UI:
- ✅ Новый nav-link «Tenants» в sidebar. Страница со тремя таблицами
  (orgs/projects/users) и inline-формами создания. Дропдауны связаны:
  при создании проекта выбор организации из реального списка; при
  создании user'а — то же + дефолт «без организации» для super_admin'ов.
- ✅ В job detail показывается `org ХХХХХХ · proj ХХХХХХ` (короткие
  префиксы id) — видно к какому scope принадлежит документ.

⏸ Открытое (следующие волны, спецификация это допускает):
- **Реальный per-user auth.** Сейчас единый Bearer = system super_admin.
  Personal access tokens (sha256-хэши уже в схеме) + sessions для UI —
  отдельная фича.
- **Enforcement ролей в endpoint'ах.** Сегодня все эндпоинты работают
  как super_admin. Когда придут реальные юзеры — добавим guard'ы:
  org_admin видит только свою org, manager — только проекты из
  user_project_access, viewer — read-only.
- **Workspace switcher в UI.** Сейчас super_admin видит всё одним
  списком. Дропдаун «текущий проект» (с persist в localStorage)
  ограничит фильтры в job list.
- **Tenant'инг document_types и provider_settings.** Сейчас глобальные.
  Когда первый клиент захочет «свои типы» — добавим nullable
  `organization_id` в эти таблицы и UI для override.
- **Audit log scope-фильтры в UI.** Бэкенд готов, в UI пока не
  фильтруется по org.

Acceptance criteria из спецификации:
- ✅ Каждый document_job связан с organization_id и project_id.
- ✅ Default org и project для совместимости со старой логикой.
- ✅ История фильтруется по org/project (бэкенд).
- ✅ super_admin видит все документы.
- ⏸ Обычный пользователь не видит чужие документы — пока всё под
  super_admin (enforcement в следующей волне).
- ✅ Архитектура позволяет позже подключать внешних клиентов без
  переделки.

### Phase 3 Day 16 — LLM call trace в job detail (2026-05-13)

Закрыт последний пробел debug-петли: теперь видно ЧТО реально
отправили в модель и ЧТО модель вернула ДО парсинга. Когда extracted
плохой — оператор открывает job → видит финальный prompt (с подставленной
схемой и текстом) и сырой ответ → сразу понимает: prompt криво подставился,
схема не подошла, модель ответила markdown'ом, OCR-текст обрезался.

Сквозная цепочка:
- inference-service `ExtractRequest.include_debug=true` → backends
  заполняют `ExtractResponse.debug { prompt, raw_response, model, backend }`.
- doc-service `llmExtract` всегда просит debug; пробрасывает в
  `ParseResult.llmCall`; orchestrator складывает в `jobs.last_llm_call`
  (новая jsonb-колонка, миграция 007).
- API `Job.last_llm_call` опционально присутствует в job-ответе.
- UI: collapsed `<details>` секция «LLM call» в job detail — backend/model
  в заголовке, prompt и raw_response в раскрытом виде.

Поведение при reprocess: если на новом прогоне парсер ходил в LLM —
trace обновляется. Если regex справился без fallback'а — trace
очищается (старый мог сбить с толку, его нет в текущем результате).
В failed-ветке processJob trace не трогается, чтобы предыдущий
успешный run был доступен для расследования причин сбоя.

### Phase 3 Day 15 — Reprocess: перепрогнать job без новой OCR (2026-05-13)

Замкнут цикл тюнинга prompt'а. Раньше: поменял `llm_prompt` в админ-UI
→ чтобы проверить эффект, нужно было заново загружать тот же документ
(минута OCR + минута extract). Теперь: кнопка «Перепрогнать» на job'е
вызывает `POST /jobs/:id/reprocess` который берёт сохранённый
`raw_text`, гонит через классификатор+парсер+валидатор с актуальной
конфигурацией типа и обновляет `extracted` / `confidence` /
`validation_issues`. OCR не повторяется — экономия главной части времени.

Защиты:
- 409 для in-flight (pending/processing) — параллельный воркер не должен
  затоптать результаты.
- 400 для jobs без raw_text (OCR упала / job failed раньше extract'а) —
  предлагаем перезагрузить документ.

Полный цикл тюнинга теперь:
  правка prompt'а в UI → resolver кэш сбрасывается → reprocess
  на job'е → 5-15 секунд (LLM-only) → новый extracted рядом с предыдущим.

### Phase 3 Day 14 — Каталог: договоры и приложения (2026-05-13)

Каталог 12 → 15 типов. Добавлен юридический пласт.

- ✅ **`contract`** — Договор (универсальный). Покрывает все подвиды
  (поставки/услуг/подряда/аренды/...) одной схемой. Подвид
  определяется полем `subject_kind` (enum: supply/services/works/
  rent/purchase/agency/license/other). Реквизиты сторон, подписанты
  (representative_name/title/basis), сроки, сумма, условия оплаты.
  Prompt инструктирует не пересказывать положения, форс-мажор и
  ответственность — только реквизиты.
- ✅ **`contract_specification`** — Спецификация / Приложение № N
  к договору. Поля `parent_contract_number` + `parent_contract_date`
  дают связь с родительским договором без отдельной join-таблицы.
  Главное — таблица позиций с ценами, артикулами, НДС.
- ✅ **`contract_addendum`** — Дополнительное соглашение. То же
  parent_contract_number/date. Поле `changes[]` — список конкретных
  модификаций (изменение пункта, замена редакции, новая сумма).
  Поле `addendum_kind` (amendment/termination/extension/price_change/
  renaming/other) для удобной фильтрации.

Тонкости классификатора:
- Слово «Договор» встречается в счетах-фактурах («оплата по Договору
  № 5»). Чтобы не было ложных срабатываний — keywords для `contract`
  требуют **контекст** («ДОГОВОР №», «Предмет (настоящего) Договора»,
  «Подписи Сторон», «Срок действия Договора», или конкретный подвид
  «Договор поставки/услуг/...»). Не просто `\bдоговор\b`.
- Spec vs addendum: «Спецификация № 1 к Договору» и «Дополнительное
  соглашение № 2 к Договору» — разные documenta. Регрессионные тесты
  явно проверяют что они не путаются.

Архитектурно (комментарий в миграции):
- НЕ дробим договор на узкие подтипы (поставки/услуг/...): админ
  через UI создаст подтип сам, если нужно. Generic `contract` +
  `subject_kind` покрывает 80% задач интеграции с ERP.
- НЕ извлекаем юридические положения — это не нужно для учётной
  системы, а в схеме съело бы токены.
- НЕ парсим подписи / печати — отдельная задача computer vision,
  пока не делаем.

Тесты: расширил `extended-types-seed.spec.ts` (теперь читает 2 файла
миграций) + 2 новых регрессионных кейса:
- `contract` keywords не должны срабатывать на голое «Договор» или
  «по Договору» в счёте.
- `contract_specification` и `contract_addendum` ключи не пересекаются.

### Phase 3 Day 13 — CP5: расширение каталога типов документов (2026-05-13)

Каталог вырос с 6 до 12 builtin-типов. Демонстрация что platform-as-product
работает: новые типы добавляются миграцией со seed'ом, без правок
TypeScript-кода. Runtime обработки идёт через `GenericLlmParser`,
который берёт схему / поля / валидаторы из БД через resolver.

Добавлены 6 типов:
- ✅ **`payment_order`** — Платёжное поручение (форма 0401060).
  Плательщик/получатель с ИНН/КПП/счётом/БИК, сумма, назначение.
  Валидаторы: inn_checksum, parties_differ, kpp_format, money_sanity, date_range.
- ✅ **`commercial_invoice`** — Международный коммерческий инвойс.
  Exporter/consignee с countries, позиции с HS-кодами, Incoterms,
  валюта. Билингвальный English/русский prompt. Валидаторы: country_code.
- ✅ **`packing_list`** — Упаковочный лист. Пара к commercial_invoice.
  Места, вес нетто/брутто, объём, габариты. Валидатор weight_nett_le_gross.
- ✅ **`bill_of_lading`** — Коносамент / B/L. Морская/мульти-модальная
  накладная. Shipper/consignee/notify, carrier, vessel/voyage, ports,
  контейнеры по ISO 6346, freight terms.
- ✅ **`customs_declaration`** — ГТД / ДТ (форма 0014001). Декларант/
  отправитель/получатель, графа 31 (товары) с HS-кодами 10 цифр,
  пошлины (1010/2010/5010). Валидаторы: inn_checksum:declarant.inn и др.
- ✅ **`cash_receipt`** — Кассовый чек ККТ (54-ФЗ). Merchant, ФН (16 цифр),
  ФД, ФП, позиции с НДС, способ оплаты. Для авансовых отчётов и розничной
  верификации.

Каждый тип сидится со:
- JSON-схемой (`llm_schema`) — описание каждого поля для LLM;
- ожидаемыми полями (`expected_fields`) — что считать «извлечено» в
  coverage stats;
- ключами классификатора (`classification_keywords`) — regex'ы для
  keyword-классификатора;
- валидаторами (`validators`) — из реестра, с конкретными dot-paths;
- кастомным `llm_prompt` где это даёт прирост качества (5 из 6 типов).

Тест: `tests/extended-types-seed.spec.ts` (30+ кейсов via it.each).
Парсит миграцию и проверяет: JSON-schemas валидны, expected_fields
не пустые, classification_keywords компилируются как regex,
validators имеют известные имена из реестра. Опечатки ловятся до prod.

Что это даёт продуктово:
- Сразу видны в админ-UI после миграции.
- Классификатор подхватывает по ключевым словам автоматически.
- Через UI можно отредактировать prompt/схему любого типа под свои
  документы (builtin-флаг защищает от случайного DELETE, но любое
  поле редактируется).
- Все 12 типов одинаково проходят через generic-парсер и Field
  coverage stats — workflow тюнинга работает на всех.

### Phase 3 Day 12 — Per-type observation: видим что реально извлекается (2026-05-13)

Чтобы во время тестирования на железе клиента можно было сразу видеть
качество обработки по типу документа и понимать что тюнить — добавлены
два аналитических endpoint'а и панели в UI редактора типа.

API:
- ✅ `GET /api/v1/document-types/:slug/jobs?limit=N` — последние N jobs
  этого типа (по умолчанию 50, max 200). Сорт `created_at DESC`.
- ✅ `GET /api/v1/document-types/:slug/stats?days=N` — за последние N
  дней (default 30) возвращает:
  - `total_jobs` — сколько всего обработано;
  - `terminal_breakdown` — раскладка по статусам (done / needs_review / failed);
  - `avg_confidence` — средний overall confidence терминальных;
  - `expected_fields_coverage[]` — для каждого ожидаемого поля доля
    jobs где оно фактически заполнено в extracted. Это и есть
    «соответствие API»: если admin обещает в схеме `seller.inn`, а
    модель извлекает в 60% случаев — нужно тюнить prompt или схему.

Repo (jobsRepo):
- ✅ `listByDocumentType(slug, limit)` — параметризованный SELECT с
  ORDER BY created_at DESC.
- ✅ `getTypeStats(slug, sinceDays)` — single-query агрегация на
  Postgres-стороне (COUNT FILTER), без выгрузки строк в Node.
- ✅ `getFieldCoverage(slug, expectedFields, sinceDays)` — dot-path
  через `jsonb #> '{a,b,c}'` с параметризованным массивом
  пути (защита от инъекций в названии поля). «Непусто» = json value
  не null и не пустая строка `""`.

UI (страница типа документа):
- ✅ Под формой редактора асинхронно подгружаются две панели:
  - **Field coverage** — 4 верхних KPI (total / done % / review % /
    avg confidence) + список ожидаемых полей с прогресс-бар'ом
    покрытия в %. Цвет: ≥80% emerald, ≥50% amber, иначе rose.
    Сразу видно «seller.inn в 73% — надо тюнить».
  - **Последние документы** — таблица последних 20 jobs этого типа
    (status, файл, confidence, issues, created). Клик → job detail.

Тесты:
- ✅ `tests/type-stats.spec.ts` — 9 кейсов на listByDocumentType +
  getTypeStats + getFieldCoverage (структура ответа, защита от SQL
  injection через параметризацию, edge cases: пустой expectedFields,
  total=0, avg_confidence=null).

Workflow тюнинга prompt'а теперь замкнут:
  1. Прогнали документы → видим coverage = 60% по `seller.inn`.
  2. Открыли редактор типа, поменяли `llm_prompt`.
  3. Save → resolver кэш сбрасывается → следующие jobs идут с новым prompt'ом.
  4. Прогнали ещё 10 документов → coverage стало 90%. Профит.

### Phase 3 Day 11 — Готовность к развороту на локальной модели (2026-05-13)

Фаза A из плана «подготовка к боевому развороту»: реальный smoke,
честный health-check, чеклист развёртывания.

- ✅ **`OpenAICompatibleBackend.probe()`** — асинхронный пинг через
  `models.list()` с 5s timeout и 30s TTL-кэшем. Lock против гонок —
  10 параллельных readiness-вызовов = 1 сетевой call. Раньше
  `is_ready()` возвращал true если в env задан model_id, что
  фактически врало о готовности модели.
- ✅ **`/ready`** в inference-service теперь вызывает `probe()` для
  backend'ов, у которых она есть. Возвращает `{ status, backend,
  reason }` — `reason` объясняет ПОЧЕМУ не готов (probe failed:
  ConnectionError; probe timeout 5s; backend.is_ready=false; и т.д.).
  k8s liveness/readiness теперь честные.
- ✅ **`/provider-settings/:id/test`** в doc-service: для kind=llm
  пингаем стандартный `/v1/models` endpoint (поддерживают все:
  Ollama, vLLM, llama.cpp, LM Studio, OpenAI cloud). Раньше дёргали
  `/v1/providers/status`, который есть только у нашего inference-сервиса.
  Нормализация base_url: если задан без `/v1` суффикса — добавляем.
- ✅ **E2E smoke** (`npm run smoke`) обновлён:
  - флаг `--ping-inference` — pre-flight проверка `/ready` перед основным
    прогоном (упасть рано с понятной ошибкой лучше, чем висеть 60s на
    первом extract'е, пока Ollama грузит weights);
  - флаг `--out report.json` — сохранить отчёт в файл;
  - latency раздельно для OCR и post-OCR (классификация + extract +
    валидация);
  - hint — теперь любой slug-формат (раньше strict-enum для шести
    builtin'ов, что было устарелым после CP1);
  - в отчёте отдельная секция `validation` с issues и source конфига
    (db vs fallback) — диагностируем «почему вернулось пусто».
- ✅ **`DEPLOY.md`** — чеклист 30-60 минут от пустой машины до первого
  распознанного документа. Под Linux и WSL2. Требования к железу для
  трёх сценариев (smoke / пилот / прод), все обязательные env-переменные
  с примером генерации, troubleshooting на основные сценарии (probe
  fail, GPU не виден, JSON-mode не поддерживается, высокая латентность).
- ✅ Тесты: `inference-service/tests/test_probe.py` — 6 кейсов (ok,
  TTL-кэш, ConnectionError, timeout, не настроен, concurrent с lock'ом).
- ⏸ Открытое (Фаза B):
  - `docker-compose.vllm.yml` — production GPU compose с vLLM. В DEPLOY.md
    есть placeholder, но реального файла пока нет.
  - **Hardware sizing guide** конкретными цифрами «модель × железо ×
    документов/мин». Сейчас в MODELS.md есть оценки VRAM, но нет
    замеренных throughput'ов.
  - **Бенчмарк-скрипт** `npm run bench:models` — golden-set из 5-10
    типовых документов × все настроенные модели, таблица latency × quality.
  - **Real-life прогон на железе клиента** — DEPLOY.md теоретический,
    нужна валидация на первом пилотном клиенте.

### Phase 3 Day 10 — Audit log retention (2026-05-13)

Закрыт операционный долг: `audit_log` теперь не растёт бесконтрольно.

- ✅ `auditLogRepo.deleteOlderThan(days)` — single-query DELETE по
  интервалу. Защита от негативного аргумента (иначе админ случайно
  снёс бы всю таблицу).
- ✅ `src/workers/audit-log-sweeper.ts` — фоновый sweeper в стиле
  существующих (file-cleanup, pending-job). Re-entrancy guard,
  graceful error handling (БД лежит → лог + продолжаем), `runOnce()`
  для тестов и потенциальной админ-кнопки.
- ✅ Конфиг через env: `AUDIT_LOG_SWEEP_INTERVAL_MS` (дефолт 24ч),
  `AUDIT_LOG_RETENTION_DAYS` (дефолт 365). Под финансовые регуляторные
  требования (5-7 лет хранения) поднимается одной строкой.
- ✅ Регистрация в `worker.ts` рядом с другими sweeper'ами; стопается
  на SIGTERM/SIGINT.
- ✅ `/api/v1/settings` экспонирует новые поля
  `sweepers.audit_log_retention_days` / `audit_log_interval_ms`.
  UI в Settings → Storage & sweepers показывает их строкой
  «audit retention X days (sweep every Yh)».
- ✅ В Audit log странице info-banner объясняет retention и кидает
  ссылку на Settings.
- ✅ `.env.example` обновлён с пояснением «при 1000 правок/день за
  3-5 лет — 5-20 GB».
- ✅ Тесты: `tests/audit-log-sweeper.spec.ts` — 4 кейса (runOnce
  передаёт правильный retention, graceful error, re-entrancy guard,
  stop()). Плюс input-validation на repo-методе.
- ⏸ Открытое:
  - **Партицирование по месяцам** — для очень крупных установок
    DELETE миллионов строк по `at` будет медленным. Альтернатива:
    `audit_log` как partitioned table, DROP PARTITION вместо DELETE.
    Не нужно сейчас, обозначим если столкнёмся.
  - **Архивирование вместо удаления** — для регуляторных кейсов где
    «нельзя удалять, но и держать оперативно тоже»: дамп в S3-like
    cold storage. Делается под клиента.
  - **Аудит самого аудита** — если кто-то «забыл выключить sweeper»,
    деление невидимо. Метрика `audit_log_rows_deleted_total` — TODO.

### Phase 3 Day 9 — Шифрование секретов в БД (2026-05-13)

Закрыт security-блокер: pg_dump / реплика / SQL-injection больше не
открывают плейнтекст API-ключей провайдеров. Стандартное envelope-
шифрование AES-256-GCM, master-ключ в env.

- ✅ `src/storage/secrets.ts` — модуль `encryptSecret/decryptSecret/isEncrypted`.
  AES-256-GCM с 12-байт случайным IV и 16-байт auth tag'ом, упакованным
  в base64 c префиксом `v1:`. Префикс версионный — поменяем алгоритм без
  break'а старых строк.
- ✅ `config.secretsEncryptionKey` — читается из env `SECRETS_ENCRYPTION_KEY`
  (формат: 64-символьная hex-строка). В production пустое значение —
  hard error на старте; в dev — deterministic SHA-256 от константы с
  loud warning'ом (чтобы можно было `docker compose up` без ручной
  настройки на чужой машине).
- ✅ `providerSettingsRepo`:
  - `upsert/patch` теперь шифруют `api_key` перед INSERT/UPDATE;
  - все методы чтения (`list/findById/findDefault/setDefault/delete`)
    проходят через приватный `decryptRow` → downstream code (`DynamicLlmClient`,
    `audit_log`, `toApi`) видит уже plaintext или legacy-значение.
  - `toApi()` не изменился — он и раньше маскировал; API-ответы по-прежнему
    `api_key_masked: '••••XXXX'`.
- ✅ Lazy-миграция: `decryptSecret` принимает И envelope с `v1:`, И сырой
  plaintext (возвращает как есть). После следующего write строка
  автоматически становится encrypted. Старые dev-стенды продолжают
  работать без принудительной миграции.
- ✅ Принудительная миграция: `npm run migrate:secrets` (dry-run по
  умолчанию) и `npm run migrate:secrets -- --apply` для боевого прогона.
  Транзакция, rollback при ошибке.
- ✅ `.env.example` обновлён с инструкцией по генерации ключа (`openssl rand
  -hex 32`) и предупреждением о смене ключа.
- ✅ UI-подсказка над списком провайдеров переписана: раньше говорила
  «Ключи хранятся в БД, в ответах маскируются», теперь — «шифруются
  AES-256-GCM перед записью, расшифровываются master-ключом из env только
  в момент использования».
- ✅ Тесты: `tests/secrets.spec.ts` (15 кейсов) — roundtrip, разные
  envelope при одинаковом plaintext (random IV), unicode/длинные,
  null/empty edge-cases, legacy plaintext без префикса, GCM tamper
  detection, обрезанный envelope, key-rotation поведение.
- ⏸ Открытое:
  - **Rotate-скрипт**: смена master-ключа без потери данных. Сейчас при
    смене все старые envelope'ы становятся нечитаемыми — нужно отдельно
    `npm run rotate:secrets --from=OLD --to=NEW` (раз-два часа работы).
  - **KMS-интеграция**: для prod в крупных компаниях env-key недостаточно —
    нужен AWS KMS / HashiCorp Vault c автомиграцией. Добавим под конкретного
    клиента, когда понадобится.
  - **Другие секреты в БД**: пока шифруем только `provider_settings.api_key`.
    `jobs.metadata` иногда содержит API-токены клиента (хотя по контракту
    не должна) — продумать sanitization.
  - **Webhook HMAC** всё ещё в env. Per-tenant webhook'и потребуют переезда
    в БД и аналогичного шифрования.

### Phase 3 Day 8 — llm_prompt override доходит до модели (2026-05-13)

Закрыт долг «UI обманывает»: в админ-форме типа документа есть поле
«Инструкция для LLM-агента», админ его правит, сохраняет — но runtime
до сегодня **игнорировал** этот текст и использовал встроенный prompt
из `inference-service/prompts/extract.py`. Теперь связка целиком сквозная.

inference-service:
- ✅ `ExtractRequest.prompt_override: str | None` (≤16 KB) — новое поле
  в API. `hint` тоже расширен до `DocumentTypeSlug = str` для пользовательских
  типов.
- ✅ `prompts/extract.build()` принимает `prompt_override`. Two-режимный
  template: `BUILTIN_TEMPLATE` (наши русско-доковые правила) vs
  `OVERRIDE_TEMPLATE` (админская инструкция + общий технический контракт
  ответа). Контракт ответа (валидный JSON с extracted/confidence/issues)
  подмешивается всегда — админ не должен дублировать «верни JSON …».
- ✅ Все четыре backend'а (`stub`, `claude`, `openai_compatible`, `qwen_vl`)
  принимают и пробрасывают `prompt_override` в builder. `ModelBackend.extract()`
  расширен в base.py с backward-compatible default `None`.
- ✅ Route `/v1/extract` форвардит поле из body в backend.

doc-service:
- ✅ `LlmClient.extract({ promptOverride })` — новое поле в интерфейсе.
  HttpLlmClient переводит camelCase → snake_case на сетевой границе
  (`prompt_override` в JSON).
- ✅ `ParserOverride.llmPrompt` — пробрасывается дальше через все
  парсеры: GenericLlmParser, TtnParser, CmrParser, AktParser, и Phase 1
  LLM-fallback (InvoiceParser/UpdParser).
- ✅ `ResolvedTypeConfig.llmPrompt` — теперь возвращается резолвером
  (whitespace-only трактуется как null — защита от пустого Save из UI).
- ✅ Orchestrator передаёт `typeConfig.llmPrompt` в parser.parse() —
  замыкая цепочку DB → resolver → parser → LLM client → inference-service.

UI:
- ✅ Подсказка под textarea «Инструкция для LLM-агента» переписана —
  раньше говорила «будет использоваться когда-нибудь», теперь «активно,
  пробрасывается на каждый /extract, технический контракт добавляется
  автоматически». Не врёт.

Тесты:
- ✅ `inference-service/tests/test_prompt_override.py` — 8 кейсов:
  prompt builder (builtin vs override, whitespace-strip, truncation),
  StubBackend (echo override length в issues), OpenAICompatibleBackend
  (override доходит до OpenAI SDK через mock).
- ✅ `doc-service/tests/prompt-override.spec.ts` — 9 кейсов:
  resolveConfigFromRow (null / present / whitespace), GenericLlmParser
  (passes через), TtnParser (Phase 2), InvoiceParser (Phase 1 fallback
  + skip когда regex confident).

### Phase 3 Day 7 — OpenAI-compat backend для локальных моделей (2026-05-13)

Чтобы не тащить torch внутрь нашего контейнера и не писать новый backend
под каждую модель — добавлен **универсальный** OpenAI-API клиент. Все
популярные локальные inference-серверы (Ollama, vLLM, llama.cpp, LM Studio,
SGLang, TGI) выставляют OpenAI Chat Completions API; теперь parsdocs
работает со всеми ими разом, меняя только `OPENAI_BASE_URL`.

- ✅ `inference_service/backends/openai_compatible.py` — async-клиент через
  официальный `openai>=1.50` SDK. Поддерживает text-only chat,
  vision (data URL image input), `response_format=json_object` с graceful
  fallback'ом для серверов без JSON-mode (старый llama.cpp).
- ✅ `config.py`: новые поля `openai_base_url / openai_model / openai_api_key
  / openai_max_tokens / openai_timeout_seconds`. Поле `backend` расширено
  значениями `openai` (cloud) и `openai_compat` (локальный). `openai`
  раньше падал `RuntimeError("not implemented")` — теперь использует тот
  же класс с пустым base_url (→ api.openai.com).
- ✅ `deps.get_providers_status()` показывает обе ветки — `openai`
  (cloud, по `openai_api_key` + пустой base_url) и `openai_compat`
  (по `base_url+model`). Удобно для UI «Provider Keys».
- ✅ `requirements.txt`: добавлен `openai>=1.50` (~1 MB, без heavy ML).
- ✅ `docker-compose.local-models.yml` — отдельный профиль с Ollama:
  основной контейнер + одноразовый `ollama-bootstrap`, который тянет
  модели из переменной `OLLAMA_PULL` через REST API. По умолчанию
  скачивает `qwen2.5vl:7b`. Раскомментируемая секция GPU passthrough.
- ✅ `inference-service/MODELS.md` — сравнительная таблица 9 моделей
  (Qwen2.5-VL 3B/7B, Llama 3.2 Vision, MiniCPM-V, InternVL3, Granite-Vision,
  Gemma 3, Qwen3, Saiga/Vikhr) с расходом VRAM в fp16/q4 и оценками по
  RU classify/extract/vision. Рекомендации для 4 сценариев: dev /
  prod GPU / air-gapped / самое дешёвое.
- ✅ `tests/test_openai_compat_backend.py` — 9 кейсов на mocked
  AsyncOpenAI: classify передаёт json_mode, extract парсит markdown-
  обёрнутый JSON, vision_ocr шлёт image_url data URL без json_mode,
  graceful fallback при `response_format not supported`, propagate
  для всех других ошибок, is_ready() с пустым model_id = false.
- ✅ README — раздел «Quick Start → С локальной open-source моделью»
  + ссылка на MODELS.md.
- ⏸ Открытое:
  - **Per-job провайдер**: `provider_settings` в doc-service всё ещё не
    пробрасывается в inference-service по запросу — выбор остаётся
    на уровне env `BACKEND=`. Когда понадобится мультитенантность
    «клиент A на Ollama, клиент B на Claude» — нужна доп. API.
  - **vLLM compose-профиль** для prod GPU. Требует CUDA-base image и
    конкретного GPU.
  - **Golden set + benchmark скрипт** — без него «качество» в MODELS.md
    остаётся экспертной оценкой.
  - **Удаление `qwen` backend'а?** Технически дублирует `openai_compat`
    при том же Qwen через Ollama. Оставлен для custom-fine-tune-сценариев,
    но в README указано «лучше openai_compat».

### Phase 3 Day 6 — Runtime читает DB-конфиг end-to-end (2026-05-13)

Раньше админ-UI правил конфиг, но runtime его не подхватывал — классификатор и парсеры были захардкожены под шесть builtin-типов. Теперь пользовательский тип, заведённый через UI, **реально работает** в pipeline'е:

- ✅ **Classifier from DB.** `KeywordClassifier` берёт активные типы через `documentTypeResolver.listActive()` (TTL 60s, инвалидируется на каждый CRUD-write document_types), компилирует `classification_keywords` в RegExp'ы и выбирает лучший матч. Если БД пустая или ничего не совпало — деградирует к hardcoded fallback'у на шесть builtin'ов. Опционально per-type weight через `metadata.classification_weight` (0..1).
- ✅ **GenericLlmParser** для не-builtin slug'ов. Берёт `llm_schema` и `expected_fields` из `ParserOverride` (= DB row через resolver). Если LLM offline — пустой результат без падения.
- ✅ **ParsersFactory.** Builtin slug → типизированный парсер (мемо). Custom slug → `GenericLlmParser` с кэшем по slug. Старый `buildParsers` оставлен для обратной совместимости с тестами.
- ✅ **Тип-сигнатуры расширены.** Введены `BuiltinDocumentType` (= алиас старого `DocumentType`) и `DocumentTypeSlug = string` (что приходит из БД / classifier'а / API). Hot-path и storage переведены на `DocumentTypeSlug`; hardcoded мапы (`DOCUMENT_JSON_SCHEMAS`, parser switch'и) остались на `BuiltinDocumentType`. Type guard `isBuiltinDocumentType()` на границе.
- ✅ **API.** `document_hint` и `document_type` в zod-схемах теперь свободный slug-формат (`^[A-Za-z0-9][A-Za-z0-9_-]*$`, 1-64 символа). Swagger описание обновлено.
- ✅ Тесты:
  - `tests/parser-dispatch.spec.ts` (10 кейсов): isBuiltinDocumentType, ParsersFactory memoization, GenericLlmParser с LLM/без LLM/без override, type-property.
  - `tests/classifier-from-db.spec.ts` (7 кейсов): DB keyword matching, hardcoded fallback при пустой БД, bad-regex tolerance, metadata.classification_weight, mock через `vi.spyOn(documentTypesRepo, 'listActive')`.
  - `tests/classifier.spec.ts` обновлён: добавлен env-сетап (теперь classifier транзитивно тянет config через resolver).
- ⏸ Открытое:
  - **llm_prompt override до inference-service**: админ-настроенный prompt пока остаётся в БД и не пробрасывается per-request. Требует расширения /v1/extract API (доп. поле `prompt_override`).
  - **Per-job confidence weighting**: классификатор-weight из metadata.classification_weight есть в коде, но в UI отдельного поля для него нет — лежит в JSON-textarea metadata.
  - **Validators для custom-типов без записи в БД** возвращают пустой массив (раньше hardcoded fallback покрывал builtin'ы; для custom — нет). Это правильно: custom-тип без DB row некорректен по определению.

### Phase 3 Day 5 — Admin Layer: CRUD + Provider keys + Audit (2026-05-13)

- ✅ **CP4 Admin layer для document_types** — `POST /document-types`, `PATCH /document-types/:slug`, `DELETE /document-types/:slug`. Builtin защищён от DELETE (можно деактивировать через PATCH). Каждый write: → запись в `audit_log` (before/after/diff) → `documentTypeResolver.invalidate(slug)` → следующий job подхватывает изменения без рестарта.
- ✅ **`provider_settings` + `audit_log`** — новая миграция `004`. Provider rows стартуют seed'ом с 6 заглушек (anthropic, openai, qwen-local, stub, tesseract, yandex-vision) с пустыми ключами и единственным «default» — `stub` для LLM и `tesseract` для OCR. Партиальный UNIQUE-индекс гарантирует ровно один default per kind.
- ✅ **CRUD /provider-settings** + endpoint `POST /:id/set-default` (атомарная транзакция) + `POST /:id/test` (HEAD/GET по base_url с замером latency). Секретный `api_key` НИКОГДА не возвращается в API (только маска `••••XXXX` и `has_api_key`). Snapshot'ы в audit_log тоже без plaintext.
- ✅ **`DynamicLlmClient`** — shim над HttpLlmClient/NullLlmClient, в hot-path читает `provider_settings.findDefault('llm')` каждые 30s с TTL-кэшем. При write через UI кэш сразу инвалидируется. orchestrator теперь держит этот шим как singleton — env-keys остаются как fallback.
- ✅ **`GET /audit-log`** с фильтрами `entity`/`entity_id` и пагинацией. Diff-структура `{ field: { from, to } }` собирается на write при помощи `_computeDiffForTesting`.
- ✅ **Editor UI для document_types** (`#document-types/new` + `#document-types/<slug>`): все поля, chip-инпуты для expected_fields/validators/classification_keywords, JSON-textarea для llm_schema с валидацией парса, инструкция для агента (llm_prompt), пороги, кнопки Создать/Сохранить/Удалить.
- ✅ **Providers UI** (`#providers`) — карточки по kind (LLM/OCR), badge'и default/active/key-set, переход в editor с полями base_url/api_key/model + кнопки «Тест связи», «Сделать default», «Очистить ключ».
- ✅ **Audit log UI** (`#audit-log`) — список с фильтром по entity/entity_id, expand-раскладка с diff-таблицей before/after + raw JSON-дамп.
- ✅ Тесты: `tests/audit-diff.spec.ts` (6 кейсов), `tests/provider-settings-api.spec.ts` (4 кейса — нет утечки plaintext-ключа в toApi).
- ⏸ Открытые позиции (см. CP1/CP4/CP6 ниже):
  - secrets at rest: api_key в БД пока plaintext; нужен envelope-шифрование (pgcrypto или KMS-проксирование) перед prod-деплоем под клиента;
  - inference-service всё ещё читает свои ключи из env — UI-настроенный `anthropic.api_key` пока не пробрасывается per-request в /v1/extract (требует расширения protocol'а);
  - audit_log без retention — со временем разрастётся, нужен TTL-sweeper или партиции.

### Phase 3 Day 3 — CP1 продолжение: per-type thresholds + override-протокол парсеров (2026-05-12)

- ✅ **`ResolvedTypeConfig`** + `resolveConfigFromRow` — чистый builder, складывает DB-значения с env/hardcoded fallback'ами и репортит источник (`db` vs `fallback`). Resolver-singleton получил метод `resolveConfig(slug)`.
- ✅ **ParserOverride API**: `DocumentParser.parse(text, override?)`. Override-параметры: `expectedFields`, `regexFallbackThreshold`, `llmSchema`. Все 5 парсеров (Invoice/UPD/TTN/CMR/AKT) подхватывают. Без override — старое поведение (тесты остались зелёными).
- ✅ **Orchestrator резолвит конфиг once per job** и:
  - передаёт override в `parser.parse(...)` — `expected_fields`, `regex_fallback_threshold`, `llm_schema` из БД теперь живые;
  - читает `typeConfig.confidenceThreshold` для решения needs_review (вместо глобального `NEEDS_REVIEW_THRESHOLD`).
- ✅ Тесты: `tests/resolve-config.spec.ts` (null row → fallback, DB row → override, частичный fallback по null-колонкам, immutability массивов), `tests/parsers.spec.ts` дополнен 5 кейсами на override-семантику.
- ⏸ Осталось из CP1: классификатор всё ещё читает захардкоженные keywords; parser_kind в БД не используется для диспатча (`buildParsers` возвращает фиксированный мапинг); llm_prompt override не пробрасывается в inference-service (нужно расширение API).

### Phase 3 Day 2 — Validator Registry + первый runtime-шаг (2026-05-12)

- ✅ **CP3 Validator Registry** — `pipeline/validation/registry.ts`. Парсер строковых спецификаций (`inn_checksum:seller.inn`, `parties_differ:seller.inn,buyer.inn`, `vat_consistency`, ...) с резолюцией в builtin-функции и dot-path-доступом к полям. 9 builtin'ов: inn_checksum, kpp_format, vehicle_plate, country_code, date_range, money_sanity, vat_consistency, parties_differ, weight_nett_le_gross. Unknown specs логируются и пропускаются — не падает пайплайн.
- ✅ **CP1 partial — `DocumentTypeResolver`** (`pipeline/document-type-resolver.ts`). Кэширующий слой над `documentTypesRepo` с TTL 60 секунд и хук `invalidate(slug?)` под будущие PUT/POST. Process-wide singleton.
- ✅ **Validation runtime читает из БД.** Новый `validateExtractedWithResolver` (async): для каждого job'а резолвит DocumentType из БД через resolver, прогоняет его список validators через registry. **Hardcoded composer оставлен как fallback** — если slug'а нет в БД (свежий тест-стенд, runtime до миграции), пайплайн использует прежнюю логику. Подключено в `orchestrator.runDocumentPipeline` и `PATCH /jobs/:id/extracted`.
- ✅ Тесты на registry (15+ кейсов): парсер спецификаций, dot-path resolution, все 9 builtin-валидаторов в позитивных/негативных сценариях, мульти-issue прогон.

### Phase 3 Day 1 — Document Type Registry (foundation, 2026-05-12)

- ✅ **Стратегический pivot:** платформа эволюционирует с «OCR-сервиса с захардкоженными типами» в **configurable document-processing system** с admin layer'ом. Каждый тип документа — first-class конфиг в БД: парсер, prompt, схема, валидаторы, пороги, ключевые слова классификатора.
- ✅ Миграция `20260512000003_document_types.sql`: новая таблица + seed из 6 текущих типов (invoice, factInvoice, UPD, TTN, CMR, AKT) с их фактическими параметрами.
- ✅ Repo `src/storage/document-types.ts` + API `GET /api/v1/document-types{/:slug}` для админ-UI.
- ✅ Сайдбар-секция **Document types**: список с парсером/полями/валидаторами + детальная страница со всей конфигурацией.
- ⏸ Парсеры, классификатор, OCR-пороги пока всё ещё хардкод — следующий шаг CP1.

### Phase 2 Day 3 — Prometheus metrics + migration framework (2026-05-11)

- ✅ **C3 Migration framework** — подключен `node-pg-migrate`. Миграции лежат в `migrations/<timestamp>_<slug>.sql` с явными секциями `-- Up Migration` / `-- Down Migration`. Применённые версии трекаются в таблице `pgmigrations`. Команды: `npm run migrate` (up all), `npm run migrate:down` (rollback 1), `npm run migrate:create <name>` (scaffold). В docker-compose добавлен one-shot сервис `migrate`, от которого зависят `api` и `worker` — схема гарантированно актуальна перед стартом трафика. Убран автозагрузочный mount `/docker-entrypoint-initdb.d`.
- ✅ **I4 `/metrics` endpoints** на обоих сервисах. Public (Prometheus scrape без Bearer); защита — на уровне корп.nginx.
- ✅ doc-service: `prom-client` + default Node-метрики. Кастомные:
  - `docservice_jobs_total{status,document_type}` — терминальный счётчик
  - `docservice_jobs_duration_seconds{document_type,outcome}` — end-to-end histogram
  - `docservice_ocr_engine_duration_seconds{engine,outcome}` — per-engine latency (accepted / rejected / error)
  - `docservice_llm_calls_total{endpoint,outcome}` + `docservice_llm_call_duration_seconds{endpoint}`
  - `docservice_webhook_attempts_total{outcome}` (success / client_error / server_error / network_error)
- ✅ inference-service: `prometheus-client` + middleware который автоматом снимает каждый HTTP-запрос:
  - `inference_requests_total{endpoint,backend,outcome}`
  - `inference_request_duration_seconds{endpoint,backend}` — buckets от 50ms (stub) до 2 минут (Qwen cold)
- ✅ Settings UI получил ссылку на `/metrics` в Endpoints карточке.

---

## 🚧 Инфра — ✅ закрыто 2026-05-15

### ~~D1. nginx server_block для parsedocs.taipit.ru~~ — ✅ настроен коллегой 2026-05-08

DNS `parsedocs.taipit.ru → 10.59.17.54` настроен. Сервис работает на `10.10.13.10:8085`. nginx server_block + TLS — настроены коллегой (не Павлом) ещё 8 мая 2026. Узнали постфактум при попытке написать Павлу.

**Что нужно Павлу:**
```nginx
server_name parsedocs.taipit.ru;
proxy_pass http://10.10.13.10:8085;
client_max_body_size 50m;
proxy_read_timeout 600s;
proxy_http_version 1.1; Upgrade $http_upgrade; Connection $connection_upgrade;
```

**Smoke после:** `curl https://parsedocs.taipit.ru/health` → `{"status":"ok"}`

---

## 🔴 Critical (блочит пилотный запуск)

### ~~C1. Гонка между «создать job» и «положить в очередь»~~ — ✅ закрыто 2026-05-11

Реализован вариант 1 (sweeper-cron). См. «Phase 1 Day 1» в шапке.

---

### ~~C3. Нет нормальной системы миграций~~ — ✅ закрыто 2026-05-11

Подключен `node-pg-migrate`. См. «Phase 2 Day 3» в шапке.

---

### ~~C4. Нет TTL на загруженные файлы~~ — ✅ закрыто 2026-05-11

Реализован file-cleanup sweeper. См. «Phase 1 Day 1» в шапке. Disk-usage в `/ready` пока не добавлен — отдельный мини-таск.

---

## 🟣 Configurable Platform (Document Type Registry roadmap)

Эти пункты — продолжение Phase 3 Day 1 (foundation сделан, см. шапку). Переводят рантайм с захардкоженных значений на чтение из БД, добавляют admin-UI редактор и подготавливают почву под multi-tenant.

### CP1. Runtime читает Document Types из БД ✅ DONE (частично)

**Где:** `doc-service/src/pipeline/orchestrator.ts`, `parsers/index.ts`, `document-type-resolver.ts`

**Реализовано:**
- ✅ `DocumentTypeResolver` (кэш + invalidate hook + `resolveConfig`) — готов.
- ✅ Валидация читает `validators[]` из БД через resolver.
- ✅ Парсеры принимают `ParserOverride` (expected_fields / regex_fallback_threshold / llm_schema) — orchestrator передаёт.
- ✅ `confidence_threshold` и `regex_fallback_threshold` per-type работают.
- ✅ `llm_schema` per-type пробрасывается в /v1/extract.
- ✅ `parser_kind='llm_extract'` в БД → `ParsersFactory.getGeneric()` — orchestrator читает `typeConfig.parserKind` и форсирует GenericLlmParser для builtin-slug'ов. `ResolvedTypeConfig.parserKind` добавлен.

**Все подпункты закрыты:**
- ✅ Классификатор читает keywords из БД (`documentTypeResolver.listActive()` → RegExp-компиляция), hardcoded fallback для пустой БД.
- ✅ `llm_prompt` override — inference-service уже принимает `prompt_override` в `ExtractRequest`; парсеры передают `override?.llmPrompt` → `llmExtract()` → `llm.extract({ promptOverride })` → HTTP snake_case `prompt_override`.

**CP1 ✅ FULLY DONE.**

---

### ~~CP2. Editor UI для Document Types~~ — ✅ закрыто 2026-05-12

`web/app.js`: полный CRUD-editor на `#document-types/:slug`. Поля: slug, display_name, description, is_active, parser_kind (select), confidence_threshold, regex_fallback_threshold, expected_fields (chips), validators (chips), classification_keywords (chips), llm_prompt (textarea), llm_schema (JSON-editor с inline валидацией). Inline bookkeeping (created_at/updated_at). Async-observations панель с stats + recent jobs после сохранения.

---

### ~~CP3. Validator registry~~ — ✅ закрыто 2026-05-12

Реализован `pipeline/validation/registry.ts` (resolver, parseSpec, runValidatorSpecs) + интеграция в `validateExtractedWithResolver`. См. «Phase 3 Day 2» в шапке.

---

### CP4. PUT/POST /document-types + audit log ✅ DONE

**Где:** `src/routes/document-types.ts`, `src/storage/audit-log.ts`

**Реализовано:**
- `POST /document-types` — создание пользовательских типов; builtin защищены
- `PATCH /document-types/:slug` — частичное обновление любого поля конфига
- `DELETE /document-types/:slug` — удаление; builtin заблокированы (только деактивация)
- `GET /document-types/:slug/history` — changelog из `audit_log`: before/after/diff, пагинация (`?limit&offset`)
- Каждый write → `audit_log.append()` с вычисленным diff + `documentTypeResolver.invalidate(slug)`
- `audit_log` хранит `diff: { field: { from, to } }` — уже готовый для UI

**Отдельная история (`document_types_history`)** не нужна — `audit_log` покрывает задачу и уже обслуживает также `provider_settings`.

---

### ~~CP5. Расширение набора document types~~ — ✅ закрыто 2026-05-12

`migrations/20260514000005_extended_document_types.sql` — +6 builtin-типов (все `llm_extract`):
- `payment_order` — Платёжное поручение (форма 0401060); валидаторы inn/kpp/money
- `commercial_invoice` — Международный инвойс (ВЭД); поля exporter/consignee/hs_code/incoterms
- `packing_list` — Упаковочный лист; поля по местам/весу/объёму  
- `bill_of_lading` — Коносамент (B/L); vessel/voyage/containers ISO-6346
- `customs_declaration` — ГТД/ДТ; регномер/декларант/графа-31/пошлины
- `cash_receipt` — Кассовый чек ККТ (54-ФЗ); ФН/ФД/ФП/позиции

Все с `llm_schema` + `expected_fields` + `classification_keywords` + `llm_prompt`. Через UI добавляются без перезапуска кода.

---

### ~~CP6. Quality Review workflow~~ — ✅ закрыто 2026-05-12

- `POST /jobs/:id/approve` — `needs_review → done` без изменения extracted; идемпотентен.
- `jobsRepo.approve()` — SQL UPDATE только если `status='needs_review'`, иначе возвращает текущее.
- `web/app.js`: `#review` view — список needs_review со сводкой extracted полей и one-click «✓ Одобрить»; автопулл 15s; approve удаляет строку из DOM немедленно.
- Кнопка «Одобрить ✓» добавлена в job detail header (показывается только при `status=needs_review`).
- Nav-ссылка «Review» (amber-иконка ⚠) между Jobs и Upload.
- `btn-success` (emerald) добавлен в design tokens index.html.

---

### CP7. Multi-tenant foundation (когда понадобится)

**Где:** schema-wide

**Симптом:** Платформа сейчас single-tenant. Если завтра появится клиент со своими типами/правилами — придётся вводить tenancy с нуля.

**Лечение:** Добавить `tenant_id` в `jobs` и `document_types`. Auth middleware резолвит `tenant_id` из токена. Document types становятся scoped per-tenant (builtin = глобальные, custom = per-tenant). Это **не делать сейчас** — добавить когда появится второй потребитель.

**Оценка:** 1-2 недели после первого реального запроса от не-нашего клиента.

---

## 🟠 Important (укусит при ramp-up)

### ~~I1. Нет идемпотентности на `POST /jobs`~~ — ✅ закрыто 2026-05-11

Реализован header `Idempotency-Key`. См. «Phase 2 Day 2» в шапке.

---

### ~~I2. Нет deadline на ретраи~~ — ✅ закрыто 2026-05-12

Worker проверяет `Date.now() - job.timestamp > JOB_MAX_AGE_SECONDS * 1000` и бросает `UnrecoverableError` (BullMQ не ретраит). `JOB_MAX_AGE_SECONDS=14400` (4 ч), настраивается через env.

---

### ~~I3. `combineConfidence(ocr, 0)` валит хорошо распознанный документ~~ — ✅ закрыто 2026-05-12

`parser=0` теперь трактуется как «LLM недоступен (stub)» → `ocr * 0.85` (мягкий штраф вместо нуля). Геометрическое среднее применяется только при `parser > 0`. Тесты: 3 новых кейса в `tests/quality.spec.ts`.

---

### ~~I4. Нет наблюдаемости~~ — ✅ закрыто 2026-05-11 (частично)

Реализованы `/metrics` endpoints на обоих сервисах. См. «Phase 2 Day 3» в шапке. **Grafana board ещё не настроен** — задача на следующую итерацию (`I4b`).

---

### ~~I4b. Grafana dashboard для собранных метрик~~ — ✅ закрыто 2026-05-12

Создан полный стек мониторинга в `monitoring/`:
- `monitoring/prometheus/prometheus.yml` — 3 scrape jobs (api:3000, worker:3000, inference:8000), 15s interval
- `monitoring/grafana/provisioning/` — datasource uid `prometheus` + file-provider
- `monitoring/grafana/dashboards/parsdocs.json` — 35 KB, 19 data panels в 5 рядах:
  - **Ряд 1:** jobs total / done rate / needs_review rate stats + timeseries jobs/min by status
  - **Ряд 2:** p50/p95/p99 job duration + horizontal bar p95 by document_type
  - **Ряд 3:** OCR p95 by engine + stat panels per engine (pdf-text, tesseract, vision-llm, yandex)
  - **Ряд 4:** LLM calls/min by endpoint+outcome + inference-service duration p95 + error rate
  - **Ряд 5:** webhook success rate + heap used (MB) + eventloop lag p99 (красный порог 100ms)
- `docker-compose.monitoring.yml` — compose override, Prometheus 2.51.0 port 9090, Grafana 10.4.2 port 3001

Запуск: `docker compose -f docker-compose.doc-platform.yml -f docker-compose.monitoring.yml up -d`

---

### ~~I5. Нет rate-limiting~~ — ✅ закрыто 2026-05-12

`@fastify/rate-limit` зарегистрирован в `server.ts`. Лимит per-API-key (fallback на IP). `/health` и `/ready` exempt через `allowList`. Настраивается `RATE_LIMIT_PER_MINUTE` (default 200, 0 = выключено).

---

### I6. Yandex Vision контракт не выверен — 🗄️ deep backlog (2026-05-15)

**Где:** `doc-service/src/pipeline/ocr/yandex.ts:50-66`

**Симптом:** Body shape (`folderId` / `analyze_specs` / `mime_type`) написан по памяти. Гарантированно сломается при первом вызове.

**Почему отложено:**
- В проде Yandex выключен (`YANDEX_VISION_API_KEY=`) — путь кода не задевается
- I8 закрыт: PII-документы (TTN, CMR) и так не попадают в Yandex даже если включить (env-флаг `YANDEX_DISABLE_FOR_PII` + per-job `_disable_external_ocr`)
- Нужен реальный API-ключ Yandex Cloud и тестовый folder для VCR-записи — внешний actor, ждёт бизнес-кейс

**Когда вернуться:** если появится требование обрабатывать через Yandex (например, скан-документы без PII, для которых другие OCR-движки дают плохой результат). Поднимать вместе с I8 — auto-detect PII классификатором (сейчас определяется только по `document_hint`).

**Лечение:** `curl` к Yandex API с одним документом, сверить request/response, поправить shape. Желательно — добавить Yandex API в integration-тесты с записанным VCR-ответом.

**Оценка:** 2 часа на сверку + 2 часа на VCR-моки + получение API-ключа от Yandex Cloud.

---

### ~~I8. PII opt-out для Yandex~~ — ✅ закрыто 2026-05-15

Реализованы оба варианта:
- **Per-job:** `metadata._disable_external_ocr=true` → router выкидывает Yandex для этого job'а (см. `src/pipeline/router.ts:ChainOptions.disableExternalOcr`).
- **Глобальный:** `YANDEX_DISABLE_FOR_PII=true` (env) + `PII_DOCUMENT_TYPES = {'TTN', 'CMR'}` (hardcoded). Yandex выкидывается если document_hint/type входит в множество, без участия клиента.

`orchestrator.ts:runOcrChain` пробрасывает оба флага через `selectOcrChain` опции. Документировано в `.env.example`.

**Не сделано (отдельный пункт):** автоопределение PII-документов классификатором — TTN/CMR детектится только по `document_hint` от клиента. Если hint не указан и классификатор сработает позже OCR, Yandex успеет получить данные. Принимаем это ограничение: для real-prod через UI всегда указывать тип через `document_hint` или загружать через типизированный route.

---

## 🟣 Phase work (ТЗ от 2026-05-14)

### ~~Phase A — расширенные поля + унификация items[]~~ — ✅ закрыто 2026-05-15

См. коммит `549c23e`. 18 полей канонического shape строки (line_no, code, barcode, hs_code, country_of_origin, единицы, веса, разбивка НДС per-line, currency). Header расширен: vat_summary[], currency, exchange_rate, flags, shipper/consignee отдельно от seller/buyer. `normalize-extracted.ts` обеспечивает backward-compat. Миграция `0015` поднимает DB-seeded типы под канон с domain-специфичными полями.

### ~~Phase B — MultiPassLlmParser~~ — ✅ закрыто 2026-05-15

`pipeline/parsers/multipass-llm.ts`. Pass 1: header на head+tail. Pass 2: items батчами ~12KB параллелизм 3. Активация: явно через `parser_kind=llm_extract_multipass` или auto при `rawText > MULTIPASS_AUTO_BYTES` (default 30KB). Миграция `0014` расширяет enum CHECK constraint. UI editor показывает 4-ю опцию.

### ~~Phase C — UI таблица позиций~~ — ✅ закрыто 2026-05-15

`renderItemsTableInto` в `web/app.js`. 8 основных столбцов + раскрытие 10+ доп. полей. Поиск (name + code + barcode, debounce 200ms), сортировка по любому столбцу, пагинация client-side 50 строк/стр, CSV-export RFC 4180. Встроен в job detail и Test Lab inline preview.

### ~~Phase D — per-line валидаторы~~ — ✅ закрыто 2026-05-15

5 builtin'ов в `pipeline/validation/registry.ts`: `items_total_sum`, `items_vat_rates`, `items_unit_known`, `items_line_consistency`, `items_hs_code_format`. Агрегируют ошибки по строкам (не 500 issues).

### ~~Phase E1 — batch exactSearch~~ — ✅ закрыто 2026-05-15

`runItemMatching` собирает все code+name документа в один SELECT через `&&` оператор по GIN. На 500-позиционном документе: 1 запрос вместо 1000.

### ~~Phase E2 — fuzzy match через pg_trgm~~ — ✅ закрыто 2026-05-15

`listEntriesRepo.fuzzySearch()` использует `similarity(display_name, query) >= threshold` + GIN-индекс `gin_trgm_ops` (создан в миграции `0011`). В `runItemMatching` запускается как fallback после exact-провала (name length ≥ 3, threshold из `cfg.fuzzy_threshold ?? 0.3`). `match_method='fuzzy_name'`, `match_score` = реальный similarity.

### Phase F — доп. типы документов (отложено)

Доверенность М-2/М-2а, путевой лист 4-С/4-П, МХ-1/МХ-3, заявка на перевозку, складской ордер М-11, инвойс-проформа. Реализуются через UI Document Types когда появится конкретный бизнес-запрос — не блочит prod-deploy с текущими 15 типами.

---

## 🚛 SLAI integration debt (ТЗ от 2026-05-16, ждём ответ разработчика SLAI)

См. `Desktop/parsdocs-validation-bench/SLAI_QUESTIONS.md` (мы → SLAI),
`SLAI_ANSWERS.md` (SLAI → нам), `SLAI_OUR_REPLY.md` (мы → SLAI обратно
с решениями по [ПРОДУКТ] меткам и ответами на 6 встречных вопросов).

### ~~F1. Identifier normalizers (ИНН + госномер)~~ — ✅ закрыто 2026-05-16

**Что:** `src/pipeline/normalize/identifiers.ts` — `normalizeInn`,
`normalizePlate`, `damerauLevenshtein`. Подключено в `orchestrator.ts`
после parser, до validation. Результаты складываются в
`_normalized_fields: { 'seller.inn': '...', 'vehicle.plate': '...' }` —
явный канал для интеграторов которым нужны exact-match значения.

16 тестов проходят. Bench v2 на новом корпусе показал что ИНН-нормализация
работает корректно — 80% seller_inn_match (без неё было бы ниже из-за
форматирования «ИНН: 7728-168-971»).

См. коммит `373834f`.

---

### F2. Confidence per-field — обещали SLAI через 7 дней

**Где:** orchestrator + extract-prompt.

**Симптом:** сейчас один общий `confidence` на job. SLAI matcher не знает
что `vehicle.plate=0.95` (надёжно), а `total_with_vat=0.40` (модель угадала).
Без этого матчинг по слабому полю даст ложные привязки.

**Лечение:**
1. Извлекать confidence из LLM-ответа (требовать в schema per-field
   uncertainty)
2. Калибровать через ground-truth bench (если модель говорит 0.9 а
   реально правильно в 60% — корректировать вниз)
3. Для regex-парсеров — вычислять по «primary regex или fallback»

**Контракт API:**
```json
{
  "extracted": { ... },
  "confidence": 0.86,
  "_field_confidence": {
    "vehicle.plate": 0.95,
    "seller.inn": 0.91,
    "total_with_vat": 0.40,
    "items[*].name": 0.80
  }
}
```

**Срок:** 5-7 дней работы. Закрываем как часть MVP интеграции с SLAI.

---

### F3. SLAI webhook receiver + service-token

**Где:** новый `routes/slai-callbacks.ts` + `auth/named-keys.ts` уже есть.

**Что нужно:**
1. `POST /api/v1/parsdocs/webhook` receiver (на стороне SLAI — мы его
   не пишем, но согласовываем формат)
2. HMAC-подпись на наших исходящих webhook (есть в коде —
   `WEBHOOK_HMAC_SECRET`)
3. Service-token для SLAI side в нашей `API_KEYS_JSON` с именем `slai`
4. OpenAPI v1 spec для webhook-payload — `doc-service/docs/openapi/v1.yaml`

**Срок:** 1-2 дня.

---

### F4. PII redaction (`?redact_pii=true`)

**Где:** new helper `src/pipeline/redact-pii.ts`.

**Симптом:** SLAI просит pre-redact ФИО водителей, паспорта,
вод.удостоверения перед использованием для обучения моделей и тестов.

**Что редактируем:**
- `vehicle.driver` (ФИО)
- `vehicle.driver_phone`
- `seller.contact_person` / `buyer.contact_person`
- Паспортные данные если найдены в свободном тексте
- Серии/номера водительских прав

**НЕ редактируем:**
- ИНН юрлиц и ИП (по 14-ФЗ публичная информация)
- Названия компаний и адреса юрлиц
- Госномера ТС (идентификатор объекта, не персона)

**Контракт:** `POST /api/v1/jobs?redact_pii=true` → в response поля
заменены на `[REDACTED]`.

**Срок:** 3-5 дней. Закрываем до получения 30-50 anonymized PDF от SLAI.

---

### F5. Multi-document PDF (`documents: Array<>`)

**Где:** orchestrator + API response shape (v2 breaking).

**Симптом:** если в PDF два разных документа (1 стр — счёт, 2-3 стр —
ТТН), модель угадывает доминирующий тип и теряет второй. SLAI хочет
два отдельных Document'а в БД.

**Лечение:**
1. Доработка preprocess: page-level classification перед extract
2. Обновление API contract — поле `documents: Array<ExtractedDocument>`
   вместо одного `extracted`
3. Version bump до v2 (старый формат v1 параллельно ≥ 6 мес)
4. Tests на split

**Срок:** 14 дней после MVP интеграции. Workaround до этого: SLAI
backend делит PDF по страницам и шлёт 2 отдельных job'а.

---

### ~~F6. category_hint через keyword-mapper~~ — ✅ закрыто 2026-05-16

**Где:** `src/pipeline/normalize/categories.ts` (17 категорий + ~250
ключевых слов на русском) + tests в `tests/normalize-totals-categories.spec.ts`.

**Что сделано:**
- 17 категорий синхронизированы с SLAI_OUR_REPLY.md (4.5): `food`,
  `beverage`, `pharma`, `textile`, `chemical`, `fuel`, `metal`,
  `construction`, `electrical`, `automotive`, `wood`, `agro`,
  `consumer_goods`, `packaging`, `service_transport`, `service_loading`,
  `other`
- Подключено в `orchestrator.ts` после `recomputeTotalsFromItems`
- Уважает существующий `category_hint != 'other'` от LLM (не перетирает)
- Перетирает только `other` либо отсутствующие значения
- Идемпотентно

**Тонкие моменты решены в keyword-листах:**
- `шин` → `' шин'/'шина '` чтобы не матчить «Простоквашино»
- `зерно` → `зерновые культур` чтобы не матчить «Кофе зерновой»
- `масло сливочное` vs `масло моторное` — обе категории
- IT-железо (сервер, картридж, кабель) → `electrical`

**После hist от SLAI** (обещали 3-5 дней) — скорректировать список под
их реальные категории. Это 1 час работы — поменять `KEYWORDS` map.

Тестов: 22 (categorizeName на ~20 примерах + applyCategoryHints на 5
сценариях + recomputeTotals на 7 сценариях).

См. коммит будет в этом push.

---

### F13. Webhook receiver для SLAI continuous category sync — open

**Где:** новый `src/routes/integrations/slai-sync.ts` + storage layer.

**Контекст:** SLAI рекомендует не разовый hist (F6/Q3), а continuous
bidirectional sync — TypeORM lifecycle hooks → debounced webhook к нам.
См. их `SLAI_NOTE_2026-05-16_CATEGORY_SYNC.md` и наш ответ
`doc-service/docs/PARSDOCS_CATEGORY_SYNC_REPLY.md`.

**Что делаем:**
1. `POST /api/v1/integrations/slai/sync/nomenclature` — events receiver
   с HMAC verify (`SLAI_TO_PARSDOCS_HMAC_SECRET`), header `X-SLAI-Version: v1`
2. `POST /api/v1/integrations/slai/sync/nomenclature/snapshot` — daily
   full reconcile
3. Миграция `slai_category_map` (id, name, our_hint, active, updated_at)
4. Redis-cache lookup `slai_category:{id}` с TTL 24ч
5. `sync_inbox` table с UNIQUE на event_id (идемпотентность)
6. Background sweeper читает inbox → applies to lookup
7. Snapshot reconciler (cron 04:00 UTC)
8. Интеграция: `applyCategoryHints` в orchestrator читает lookup-table
9. Unit-тесты

**Срок:** 5-7 дней работы. **Зависит от:**
- HMAC secret обмен (нужен `SLAI_TO_PARSDOCS_HMAC_SECRET`)
- Подтверждение SLAI что наши 7 ответов в `PARSDOCS_CATEGORY_SYNC_REPLY.md`
  устраивают

---

### ~~F7. total_with_vat: пересчёт из items~~ — ✅ закрыто 2026-05-16

**Где:** `src/pipeline/normalize/totals.ts` + подключено в orchestrator
после `normalizeExtractedFields`, до `applyCategoryHints`.

**Поведение:**
- Считает `sum(items[].total_with_vat || items[].total || qty*price*(1+vat/100))`
- Если оригинал `total_with_vat` отсутствует — заполняет вычисленным
- Если расхождение ≥ 1 руб — заменяет + пишет
  `_totals_recomputed: { from: 'items_sum', deltas: { total_with_vat: ... } }`
- Если расхождение < 1 руб — не трогает (LLM попал)
- `total_without_vat` и `vat_amount` НЕ трогаем (риск сломать что LLM
  правильно ставил)

Парсит строковые числа с пробелами/запятой («1 000,50» → 1000.5), что
часто прилетает от LLM/regex.

Тестов: 7 в `tests/normalize-totals-categories.spec.ts` (LLM ошибся /
LLM попал / LLM забыл / строковые числа / пустой items / пересчёт из
qty×price / идемпотентность).

См. коммит будет в этом push.

## 🟡 Architectural (думать сейчас, делать потом)

### A1. inference-service синхронный

**Симптом:** Каждый `POST /v1/extract` блокирует FastAPI worker. Под нагрузкой запросы стоят в backlog'е.

**Лечение:** Очередь поверх Redis (тот же `ai-platform`), как у doc-service. Альтернатива — vLLM с continuous batching.

**Оценка:** 2 дня + миграция Qwen-backend на vLLM.

---

### A2. Storage abstraction half-done

**Симптом:** `FileStorage` интерфейс есть, реализация одна (LocalFs). Горизонтальное масштабирование worker'ов невозможно (они должны делиться диском).

**Лечение:** `S3FileStorage` через `@aws-sdk/client-s3` (совместим с MinIO). Конфиг-селектор `STORAGE_BACKEND=local|s3`.

**Оценка:** день.

---

### ~~A3. Single API key~~ — ✅ закрыто 2026-05-12 (вариант 1)

`API_KEYS_JSON='{"key":"client-name"}'` — named keys с caller-тегом в `AuthUser`. Auth middleware перебирает все named keys через constant-time compare, затем падает на root `API_KEY`. `caller` пишется в лог. DB-backed токены (вариант 2) — отдельный проект когда понадобится.

---

### ~~A4. Webhook deliveries не воскрешаются~~ — ✅ закрыто 2026-05-12

Реализована ручная повторная доставка:
- `jobsRepo.resetWebhookAttempts(id)` — сбрасывает `webhook_attempts`, `webhook_delivered_at`, `webhook_last_error`
- `POST /jobs/:id/redeliver-webhook` — 400 если нет `webhook_url`, 409 если job in-flight, иначе сбрасывает счётчик и вызывает `deliverWebhook()` fire-and-forget, возвращает 202 + актуальный снимок job'а
- `src/workers/webhook-sweeper.ts` — автоматический sweeper по образцу pending-job-sweeper. Каждые 15 мин ищет jobs с `webhook_delivered_at IS NULL AND webhook_last_error IS NOT NULL AND webhook_attempts < hardLimit`. Вызывает `deliverWebhook()` fire-and-forget без сброса счётчика — попытки накапливаются (5 → 10 → 15). При `hardLimit=15` — 3 волны по 5, потом только ручная кнопка.
- Config: `WEBHOOK_SWEEPER_INTERVAL_MS` (15 мин), `WEBHOOK_SWEEPER_GRACE_MINUTES` (60 мин), `WEBHOOK_SWEEPER_HARD_LIMIT` (15).
- `jobsRepo.listStaleWebhooks()` — SQL с `make_interval(mins => $2)` и `ORDER BY updated_at ASC`.
- Зарегистрирован в `worker.ts` рядом с остальными sweeper'ами, стопается на SIGTERM.

---

### ~~A5. Двойная растеризация PDF~~ — ✅ закрыто 2026-05-12

- `OcrInput` расширен полем `rasterizedPages?: string[]`
- `orchestrator.ts:runOcrChain()` — предрастеризует PDF один раз (`mkdtemp → pdftoppm -r 200`) когда в chain > 1 движка. При ошибке pdftoppm — graceful fallback (каждый движок растеризует сам). Cleanup в `finally`.
- `TesseractEngine` — выделен приватный `processPages(pageFiles, started)`. `runOnPdf()` проверяет `input.rasterizedPages` и использует их напрямую; если нет — собственная растеризация (fallback для standalone/тестов).
- `VisionLlmEngine` — аналогично.
- Экономия: 1 pdftoppm (≈5–15 сек на 10-страничном скане) на каждом job где tesseract не набрал threshold.

---

### ~~A6. Stub-классификатор продублирован~~ — ✅ закрыто 2026-05-12

- `shared/classifier-rules.json` — единый источник 7 builtin-правил в корне репо. Добавить новое правило нужно только здесь.
- `keywords.ts` — читает JSON через `readFileSync` с runtime path resolution (`dist/pipeline/classifier/ → ../../../../shared/`). Fallback к hardcoded при ошибке чтения (Docker без mount).
- `stub.py` — загружает через `_load_classifier_rules()`: 1) `CLASSIFIER_RULES_PATH` env, 2) `Path(__file__).parents[4] / 'shared' / …` (работает в dev/CI), 3) hardcoded fallback.
- Docker для inference-service: ✅ закрыто 2026-05-15. Использован runtime-volume mount вместо COPY (build context inference-service не видит `../shared`):
  - `inference-service/docker-compose.yml`: `volumes: - ../shared:/app/shared:ro`
  - `environment: CLASSIFIER_RULES_PATH=/app/shared/classifier-rules.json`
  - Преимущество: hot-reload правил без rebuild образа.
- Docker для doc-service: ✅ закрыто 2026-05-15. Тот же runtime-volume mount в `api` и `worker`:
  - `doc-service/docker-compose.yml`: `volumes: - ../shared:/app/shared:ro` для обоих сервисов.
  - `keywords.ts` уже резолвит путь как `/app/shared/classifier-rules.json` (через `dist/pipeline/classifier/ → ../../../../shared/`).
  - До этого фикса в Docker doc-service молча падал на hardcoded fallback, что могло разъехаться с Python после правки правил в shared/.

---

## 🟢 Latent code-level

### ~~B5. Уровень 6 — реальная проверка типа файла (magic bytes)~~ — ✅ закрыто 2026-05-11

Реализована через пакет `file-type`. См. «Phase 2 Day 2» в шапке.

---

### ~~B3. `DROP TRIGGER + CREATE TRIGGER` в миграциях~~ — ✅ закрыто 2026-05-15

Миграция `0016_fix_trigger_ddl.sql` переписывает функцию и trigger через `CREATE OR REPLACE` (Postgres 14+). Идемпотентна, не блочит запись на момент DDL — REPLACE атомарно меняет определение.

---

### ~~B4. `metadata = JSON.stringify(null)` vs `null`~~ — ✅ закрыто 2026-05-15

В `jobsRepo.create()` к параметру `$7` (metadata) добавлен явный cast `$7::jsonb`. Pg-driver больше не может передать text NULL вместо jsonb NULL — защита на случай будущих triggers/expressions на metadata.

---

## 🧪 Test gaps

| Что | Текущее покрытие | Приоритет |
|---|---|---|
| `processJob` (DB, webhook delivery, error path) | 0 | high |
| HTTP routes / handler integration (полный круг multipart upload → enqueue → response) | 0 (только auth) | high |
| `localFileStorage.saveStream` (path traversal, sanitize, 0-byte) | 0 | medium |
| `HttpLlmClient` (network errors, timeouts, malformed responses) | 0 | medium |
| `YandexVisionEngine` с записанным VCR | 0 | low (вместе с I6) |
| Smoke runner — что хотя бы запускается без ошибок | 0 | medium |

**Подход:**
- Для HTTP routes — Fastify `inject()` с моками `jobsRepo` и `docQueue`.
- Для `processJob` — testcontainers с реальным Postgres + Redis (медленно, но реалистично) или vi.mock на репо.
- Для file storage — temp dir + проверки на скверные имена файлов (`../../etc/passwd`, `аaa.pdf` с zero-width chars и т.п.).

**Оценка:** 1-2 дня на closing high-priority строк.

---

## Структура категорий

- **🔴 Critical** — блочит запуск на пилоте. Делать первым.
- **🟠 Important** — система работает, но при росте нагрузки или количества клиентов начнёт болеть.
- **🟡 Architectural** — стоит подумать сейчас, спланировать в roadmap, реализовать в следующих фазах.
- **🟢 Latent** — мелкие баги, которые рано или поздно выстрелят.
- **🧪 Test gaps** — отдельная категория, не привязанная к серьёзности.
