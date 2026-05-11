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

### CP1. Runtime читает Document Types из БД (in progress)

**Где:** `doc-service/src/pipeline/orchestrator.ts`, `parsers/index.ts`, `classifier/keywords.ts`, `validation/index.ts`, `types/document-json-schemas.ts`

**Симптом:** Сейчас pipeline использует захардкоженные значения. Конфиг в БД — informational only.

**Прогресс:**
- ✅ `DocumentTypeResolver` (кэш + invalidate hook + `resolveConfig`) — готов.
- ✅ Валидация читает `validators[]` из БД через resolver — готово. Hardcoded composer оставлен как fallback.
- ✅ Парсеры принимают `ParserOverride` с `expected_fields`/`regex_fallback_threshold`/`llm_schema` — orchestrator передаёт.
- ✅ `confidence_threshold` per-type работает — orchestrator берёт из resolved config (fallback на env).
- ✅ `regex_fallback_threshold` per-type работает — пробрасывается в Phase 1 парсеры через override.
- ✅ `llm_schema` per-type работает — пробрасывается в /v1/extract.
- ⏸ Классификатор всё ещё читает захардкоженные keywords (хотя seed в БД совпадает).
- ⏸ `parser_kind` поле есть, но не диспатчит парсера — определяет TS-импорты в `buildParsers`.
- ⏸ `llm_prompt` override не пробрасывается в inference-service (нужно расширение `/v1/extract` API чтобы принимать prompt override).

**Лечение оставшегося:** (а) классификатор → async-метод с резолюцией keywords из БД (агрегация по всем активным типам); (b) `parser_kind` диспатч — если в БД написано `llm_extract` для бывшего regex-типа, парсер должен использовать LLM-only; (c) llm_prompt override — расширение API inference-service.

**Оценка:** 1 день на оставшееся.

---

### CP2. Editor UI для Document Types

**Где:** `doc-service/web/`

**Симптом:** UI сейчас read-only. Чтобы добавить новый тип / поправить промпт — лезть в SQL.

**Лечение:** Форма редактирования (markdown-style для prompt, JSON-editor для schema, list-builder для validators/keywords). Кнопка «Тестировать» — гонит выбранный документ через draft-конфигурацию, показывает результат до сохранения.

**Оценка:** 3-4 дня.

---

### ~~CP3. Validator registry~~ — ✅ закрыто 2026-05-12

Реализован `pipeline/validation/registry.ts` (resolver, parseSpec, runValidatorSpecs) + интеграция в `validateExtractedWithResolver`. См. «Phase 3 Day 2» в шапке.

---

### CP4. PUT/POST /document-types + audit log

**Где:** новые API + миграция

**Симптом:** Конфигурация в БД read-only через API. Изменения только через SQL.

**Лечение:** PUT для существующих, POST для новых типов (с slug-validation). Каждое изменение → запись в `document_types_history` (кто/когда/что поменял + diff). Подготовит почву под role-based access (admin vs operator).

**Оценка:** 2 дня (включая history-таблицу + UI changelog).

---

### CP5. Расширение набора document types

**Где:** `migrations/...` + опционально через API после CP4

**Симптом:** Сейчас только 6 типов. По roadmap нужно: commercial invoice, packing list, AWB, B/L, контракты, customs, этикеты, доверенности, сертификаты, внутренние формы.

**Лечение:** После CP1-CP4 каждый новый тип = миграция со seed-вставкой (или админ через UI). Параллельно — определить JSON schemas для каждого, написать LLM-промпты, валидаторы.

**Оценка:** ~день на тип (включая prompt-инжиниринг и проверку на образцах).

---

### CP6. Quality Review workflow

**Где:** `web/` + новые роуты

**Симптом:** Сейчас `needs_review` задачи висят в общем списке job'ов. Нет отдельного «оператор-режима» где видны только они с быстрым approve/edit.

**Лечение:** Новый view `/review` — очередь needs_review с side-by-side: preview документа + редактор extracted + batch-кнопки (approve / reject / re-process). Накапливать diff between OCR-result и финальный — будет training data.

**Оценка:** 2-3 дня.

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

### I2. Нет deadline на ретраи

**Где:** `doc-service/src/queue.ts:21-25` (BullMQ defaults)

**Симптом:** При длительном падении внешнего сервиса (LLM, Yandex) job либо сдаётся слишком быстро (3 attempts × backoff), либо может тянуть retry-цепочку часами без естественной остановки.

**Лечение:** В worker'е перед обработкой проверять `now() - job.created_at > MAX_AGE` → markFailed.

**Оценка:** 2 часа.

---

### I3. `combineConfidence(ocr, 0)` валит хорошо распознанный документ

**Где:** `doc-service/src/pipeline/quality.ts:55`

**Симптом:** Геометрическое среднее. Если LLM недоступен и Phase 2 парсер вернул `confidence: 0`, итоговая = 0 → `needs_review` даже на идеальном OCR.

**Лечение (требует продуктового решения):**
- Вариант A: оставить как есть, явно задокументировать «без LLM ТТН/CMR/АКТ всегда needs_review».
- Вариант B: разделить на два поля API: `ocr_confidence` и `extraction_confidence`. Клиент сам решает.

**Оценка:** 1 час кода + продуктовое обсуждение.

---

### ~~I4. Нет наблюдаемости~~ — ✅ закрыто 2026-05-11 (частично)

Реализованы `/metrics` endpoints на обоих сервисах. См. «Phase 2 Day 3» в шапке. **Grafana board ещё не настроен** — задача на следующую итерацию (`I4b`).

---

### I4b. Grafana dashboard для собранных метрик

**Где:** отдельный артефакт (JSON dashboard + provisioning), вероятно в `monitoring/`

**Симптом:** Метрики собираются (`/metrics` на обоих сервисах отдают данные), но дашборд для оператора ещё не построен. Чтобы увидеть KPI «% needs_review», «median OCR latency by engine», «LLM error rate» нужно либо ходить на raw `/metrics`, либо ручками сложить запрос в Prometheus.

**Лечение:** JSON dashboard для Grafana с панелями:
- Jobs throughput (rate of `docservice_jobs_total` by status)
- OCR latency p50/p95/p99 per engine
- LLM call success rate + latency by endpoint
- Webhook delivery success rate
- Queue depth (нужен ещё один gauge — sample BullMQ `getJobCounts()` периодически)
- Inference-service: requests/sec by backend, latency p95

**Оценка:** день на дашборд + provisioning через docker-compose. Можно отложить до момента когда метрики начнут реально нужны (после первого продакшен-инцидента или жалобы на скорость).

---

### I5. Нет rate-limiting

**Где:** `doc-service/src/server.ts`

**Симптом:** Любой клиент с валидным `API_KEY` может забить очередь и съесть диск за минуту.

**Лечение:** `@fastify/rate-limit` плагин, лимиты per-IP и per-API-key.

**Оценка:** 2 часа.

---

### I6. Yandex Vision контракт не выверен

**Где:** `doc-service/src/pipeline/ocr/yandex.ts:50-66`

**Симптом:** Body shape (`folderId` / `analyze_specs` / `mime_type`) написан по памяти. Гарантированно сломается при первом вызове.

**Лечение:** `curl` к Yandex API с одним документом, сверить request/response, поправить shape. Желательно — добавить Yandex API в integration-тесты с записанным VCR-ответом.

**Оценка:** 2 часа на сверку + 2 часа на VCR-моки.

---

### I8. PII opt-out для Yandex не реализован

**Где:** `doc-service/src/pipeline/ocr/yandex.ts:18-22`

**Симптом:** TTN с фотографией паспорта водителя могут уехать в Yandex Cloud. Регуляторный риск (152-ФЗ).

**Лечение:**
1. Поле `disable_external_ocr: true` в `metadata` → router пропускает Yandex для этого job'а.
2. ИЛИ глобальный флаг `YANDEX_DISABLE_FOR_PII=true` + классификатор помечает PII-документы (TTN, CMR с водительскими данными).
3. Пока не сделано — **выключать Yandex полностью** (env пустой, документировано в `.env.example`).

**Оценка:** 4 часа на вариант 1, день на вариант 2.

---

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

### A3. Single API key

**Симптом:** Нет аудита «кто загружал», нет ротации без даунтайма.

**Лечение:**
1. Multi-key через env: `API_KEYS_JSON='{"<key>":"<client_name>"}'`. Имя клиента → `jobs.metadata.caller`.
2. DB-backed токены с CRUD-API + ротацией — отдельный мини-проект.

**Оценка:** 3 часа на вариант 1, неделя на вариант 2.

---

### A4. Webhook deliveries не воскрешаются

**Симптом:** Если webhook сдох на 5-й попытке — кнопок «доставить ещё раз» нет.

**Лечение:** Ручка `POST /jobs/:id/redeliver-webhook` + sweeper для добивки старше N часов.

**Оценка:** 3 часа.

---

### A5. Двойная растеризация PDF

**Где:** `doc-service/src/pipeline/ocr/tesseract.ts`, `vision-llm.ts`

**Симптом:** Tesseract и vision-llm независимо вызывают `pdftoppm` для одного и того же PDF.

**Лечение:** Кешировать растеризованные PNG'и в tmpdir per-job, переиспользовать между движками. Передавать через контекст оркестратора.

**Оценка:** 3 часа.

---

### A6. Stub-классификатор продублирован

**Где:** `inference-service/src/inference_service/backends/stub.py:25-33` копирует regex'ы из `doc-service/src/pipeline/classifier/keywords.ts:5-14`.

**Симптом:** Сейчас совпадают. Через год разойдутся незаметно.

**Лечение:** Общий `classifier-rules.json` (или YAML) в shared dir, читается обоими сервисами.

**Оценка:** 2 часа.

---

## 🟢 Latent code-level

### ~~B5. Уровень 6 — реальная проверка типа файла (magic bytes)~~ — ✅ закрыто 2026-05-11

Реализована через пакет `file-type`. См. «Phase 2 Day 2» в шапке.

---

### B3. `DROP TRIGGER + CREATE TRIGGER` в миграциях

**Где:** `doc-service/migrations/001_init.sql:55-60`

**Симптом:** Идемпотентно при повторном прогоне, но в проде на горячей таблице блочит запись на момент DDL.

**Лечение:** В будущей миграции — `CREATE TRIGGER IF NOT EXISTS` (Postgres 14+) или `CREATE OR REPLACE TRIGGER` (Postgres 14.0 не поддерживает, надо проверить).

**Оценка:** 30 минут.

---

### B4. `metadata = JSON.stringify(null)` vs `null`

**Где:** `doc-service/src/storage/jobs.ts:create`

**Симптом:** Минор. Pg-driver может передать `text NULL` вместо `jsonb NULL`. На JSONB-колонке скорее всего справится, но защита через явный `$7::jsonb` не помешает.

**Лечение:** `INSERT INTO jobs (..., metadata) VALUES (..., $7::jsonb)`.

**Оценка:** 10 минут (одна строка в SQL).

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
