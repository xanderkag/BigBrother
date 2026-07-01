# Tech debt

> 📍 **Живая доска задач — [`ROADMAP.md`](./ROADMAP.md)** (что делаем сейчас/дальше/перспектива).
> Этот файл — детальная история и инженерные заметки по конкретным долгам.

Список задач, накопленных при scaffold'е (doc-service + inference-service). Структура — по серьёзности и срочности. Когда берёте задачу — отметьте «in progress» и закрывайте PR'ом со ссылкой на пункт.

---

> **Закрытые долги** см. в [`TECH_DEBT_ARCHIVE.md`](./TECH_DEBT_ARCHIVE.md). Этот файл содержит только open + active секции.

## Активные

- **LLM-CLASSIFIER (2026-07-01) — production LLM-классификатор на КАЖДОМ доке (qwen3.6:27b).** Раньше тип определял только keyword+filename классификатор; теперь на каждом доке после OCR прогоняется LLM-классификатор поверх него. Схема (проверена probe: ~1s/док warm, 14/15 на неоднозначных, честный `unknown` на out-of-catalog): (1) keyword-prior остаётся PRIOR+FALLBACK; (2) `classifier/catalog.ts` строит динамический каталог `slug — description` из `document_types` (per-org bucket, TTL 60s, инвалидация через `documentTypeResolver.registerInvalidationHook`); (3) `classifier/llm-classifier.ts` `LlmDocClassifier` шлёт system=«выбери ОДИН slug или unknown»+catalog / user=имя+prior-подсказка+первые 2500 chars в `/v1/classify` (catalog-режим), `reasoning_effort:"none"`, temp=0, max_tokens=30, timeout 18s. Решение: валидный slug из каталога → method=llm; `unknown`+prior-неуверен → флаг `unknown` (тип null, НЕ выдумываем); `unknown`+prior-уверен(≥0.5) → prior (method=fallback); LLM упал/timeout/невалидный slug → keyword-prior (method=keyword/filename). **Никогда не роняет док из-за классификатора.** Метаданные пишутся в `jobs.classification` (jsonb, миграция `20260701000002`): `{type, confidence, method, duration_ms, llm_said, keyword_said, candidates, unknown}` — питает UI job detail (zod `Job.classification`, live-swagger). Инференс: `/v1/classify` расширен опц. `catalog`/`file_name`/`keyword_hint`/`max_tokens`; `ClassifyResponse.type` ослаблен `Literal[6]`→`str|None` (backwards-compat); catalog-путь только в `openai_compatible` (голый slug plaintext, `_extract_slug`), прочие backends игнорят (fall back). Интегрировано в orchestrator + reprocess-route. v1 webhook-контракт НЕ тронут (`classification` — только внутренний job-API, не payload). Тесты `doc-service/tests/llm-classifier.spec.ts` (10). Открытые хвосты:
  - **confidence LLM-выбора синтетический.** Голый slug не несёт числа → `1.0`/`0.9` (согласие с prior / расхождение). Информационно для UI; needs_review-порог считается отдельно по OCR+parser confidence.
  - ~~**`candidates[]` = один prior-победитель.**~~ **[РЕШЕНО 2026-07-01, refactor #2]** `KeywordClassifier` теперь строит ранжированную score-map (`ClassificationResult.ranked` — все сматчившиеся типы winner-first, `ranked[0]`=победитель, score в [0,1] outbound-clamp); `LlmDocClassifier.buildCandidates` берёт из неё реальные top-3 (победитель + 2 runners-up) в `candidates[]`. Решение (выбранный `document_type`) БАЙТ-ИДЕНТИЧНО прежнему — `ranked`/`candidates[]` чисто производные метаданные, логика `bestScore`/`pickWithFilename`/title-boost не тронута. Гвардировано тестами (`classifier.spec.ts` +4: decision-unchanged + ranked≥2/3 + winner=ranked[0]; `llm-classifier.spec.ts` +2: candidates enriched + fallback single-entry). `classification` — только внутренний job-API/UI, не в webhook (v1 контракт не тронут). Также в этом рефакторе: dedup persist-wiring → `persistClassification(jobId, meta, log)` в orchestrator, общий для воркера и reprocess-route.
  - **не-openai_compat backends без catalog.** claude/qwen_vl/stub игнорят catalog → doc-service fall back на keyword. На проде дефолт = openai_compat (qwen3.6), боевого влияния нет; для облачного Claude-пилота classify будет keyword-only пока не добавим catalog-путь в claude.py.
  - **PRIOR_CONFIDENT_THRESHOLD=0.5 / timeout=18s / textChars=2500 захардкожены** в `llm-classifier.ts` (не env/DB). Подобраны под probe.
  - **classify делит admission-семафор inference с extract'ом.** Быстрый classify (~1s) может ждать за extract'ом (30-40s) в семафоре, но timeout-guard (18s)+fallback на keyword держат очередь живой (classify не залипает навсегда).

- **FILENAME-SIGNAL + DOC (2026-07-01) — имя файла как weighted-сигнал классификации + legacy .doc.** Боевой батч: имя буквально содержит тип (`Act_*`, `ТТН_*`, `VAT_invoice_*`, `988726MBL.xls`), но классификатор скорил только keyword'ы в тексте и промахивался. Реализовано: (1) `classifier/filename-signal.ts` — marker-map имя→slug (case-insensitive по basename без расширения; порядок значим: VAT<invoice, weighing<act, proforma/commercial<invoice; НЕТ маркера для `PWR` — легитимно неоднозначен). (2) `KeywordClassifier` теперь скорит per-type map с `titleBoosted`-флагом; filename применяется как booster/tie-breaker: **флип запрещён если контент-победитель title-boosted** (definitive-заголовок в первых 500 chars = сильный сигнал) — это защищает `Заявка_ИСТ-ВЕСТ.pdf` (заголовок «Приложение к Договору» → contract_specification, title-boosted, остаётся, несмотря на «Заявка» в имени). Флип разрешён когда контент слабый/по ссылке в теле/отсутствует (ТТН — OCR не поймал «накладную»; VAT_invoice — customs-ключ по ДТ-ссылке; Act — SWIFT в акте). `FILENAME_SIGNAL_WEIGHT=5.5` (standalone, бьёт invoice-5.0 но не contract_spec-7.5), `FILENAME_AGREE_BOOST=1.0` (аддитивно при корроборации). (3) Миграция `20260701000001` — чинит баг regex AKT `(?:^|\W)акт(?:\W|$)\s+(оказанных)` (двойное поедание единственного пробела → «АКТ ОКАЗАННЫХ» не матчился, акты уходили в wire_transfer/customs) + поднимает вес definitive-заголовков AKT→3.0, factInvoice→6.0 (title-boost бьёт ссылку на ДТ). (4) `DocEngine` (`ocr/doc.ts`) — legacy .doc (x-cfb + `.doc` extension) через `catdoc` (Debian-пакет в Dockerfile). Разведён с XlsxEngine по extension (оба видят x-cfb). Тесты: `classifier.spec.ts` (+8 filename), `ocr-doc.spec.ts` (4), `ocr-xlsx.spec.ts` (+1 x-cfb-disambiguation). Открытые хвосты:
  - **`Заявка_ИСТ-ВЕСТ__финал.pdf` семантика.** Классифицирован contract_specification (0.82-0.9) — «ПОРУЧЕНИЕ (ЗАЯВКА) ЭКСПЕДИТОРУ ... Приложение к Договору». Имя говорит «Заявка» → transport_request. Возможно transport_request корректнее, но не в scope и content-heading явно «Приложение к Договору». Оставлен как есть (filename не флипает title-boosted). Если владелец решит что это transport_request — нужен product-decision + образец.
  - **filename-сигнал в multi-doc не прокидывается.** `multidoc/runner.ts` классифицирует per-page; имя файла относится ко всему файлу и биасило бы каждую страницу. Осознанно не прокинуто (single-doc фокус). Если понадобится — прокидывать только когда файл однодокументный.
  - **`FILENAME_SIGNAL_WEIGHT`/`AGREE_BOOST` захардкожены.** Подобраны под наблюдаемое распределение весов (5-8 у специфичных типов). При добавлении типов с очень высоким весом ссылки в теле — пересмотреть. Не вынесены в env/DB.
  - **catdoc-only .doc.** Нет `antiword`-fallback в Docker (код пробует antiword если catdoc упал, но пакет не ставится). `.docx`-конвертация / зашифрованные .doc не поддержаны.

- **OCR-VISION-DECOUPLE (2026-06-30, ЗАДЕПЛОЕНО на прод) — vision-OCR сканов отвязан от extraction-дефолта.** Бокс 10.10.33.10 удалил `qwen2.5vl:7b` (старый `OPENAI_MODEL`). Выяснилось, что vision-OCR (`VisionLlmEngine`) шёл НЕ на `OPENAI_MODEL`, а на модель **default LLM-провайдера** (`local-qwen3-6-27b` → `qwen3.6:27b`), потому что `HttpLlmClient` всегда кладёт `model` дефолт-провайдера в body — override всегда побеждал env-fallback. То есть OCR гонялся на text-модели (vision=false), а не на vision-capable. Фикс: `DynamicLlmClient.withVisionProvider()` резолвит OCR-vision-провайдера (`OCR_VISION_PROVIDER_ID`, иначе `findActiveVision()`) и скоупит OCR-вызов через `withForceProvider`; `VisionLlmEngine` оборачивает каждый `visionOcr` в этот скоуп (constructor-param `visionScope`, fail-soft — без него прямой вызов). Прод: создана строка `local-qwen3-vl-32b` (model `qwen3-vl:32b`, vision=true, active), `OCR_VISION_PROVIDER_ID=local-qwen3-vl-32b`, `OPENAI_MODEL=qwen3-vl:32b` (fallback тоже vision). Дефолт extraction `local-qwen3-6-27b` (qwen3.6:27b) НЕ тронут. Мёртвый `local-qwen3-32b` (qwen3:32b) → `is_active=false` (не удалён). E2E-валидация (synthetic degraded scan): tesseract conf=0 → vision-llm conf=0.75 ~4.4s OCR на qwen3-vl:32b 200 OK → done + webhook 201. Тест `doc-service/tests/vision-llm-scope.spec.ts` (2). Открытые хвосты:
  - **qwen3-vl:32b vs minicpm-v как OCR-fallback.** 32B vision медленнее старой 7B. На прогретой мелкой картинке ~0.7-4.4s, но реальные многостраничные сканы будут дороже per-page. Если боевой OCR станет >2-3 мин/скан — рассмотреть minicpm-v как лёгкий fallback (флаг, пока НЕ переключено).
  - **`OCR_VISION_PROVIDER_ID` — задокументирован в `.env.example` (2026-07-01).** Добавлен в `doc-service/.env.example` с комментарием (селектит provider_settings-строку для vision-OCR сканов; пусто → findActiveVision). `config.ts` `hybridRouting.ocrVisionProviderId` уже имел описательный JSDoc. UI-тоггл — позже (frontend).

- **FAST-QWEN (2026-06-30, ЗАДЕПЛОЕНО на прод) — `reasoning_effort` подавляет thinking у qwen3.6:27b.** Прод-дефолт `local-qwen3-6-27b` (qwen3.6 — reasoning-модель) тратил ~110-150s/doc на hidden reasoning (уходило в `reasoning`-поле OpenAI-ответа, НЕ в content; usage.completion_tokens=24 при wall 120s+). Probe на нашем пути (doc-service → inference openai-compat → Ollama 0.24 @ 10.10.33.10): OpenAI-compat `reasoning_effort:"none"` подавляет reasoning, JSON остаётся в `message.content` (20.5s→0.5s на trivial-промпте); нативный Ollama `think:false` через `/v1` **игнорируется** (остаётся медленным) — поэтому knob именно `reasoning_effort`, не `think`. Плумбинг config-driven scoped-per-provider: `provider_settings.extra.reasoning_effort` → `HttpLlmClient` кладёт `reasoning_effort` в body classify/extract/verify → inference `*Request`-схемы принимают, routes форвардят, `openai_compatible._complete_with_usage` шлёт через `extra_body` с soft-fallback (`_looks_like_reasoning_effort_not_supported`). Не-reasoning модели (phi4 и пр.) `extra` ключа не имеют → param=None, kwargs нетронуты (проверено probe'ом: phi4 принимает `reasoning_effort:none` no-op). DB-row выставлен `{"reasoning_effort":"none"}`. Тест-батч (reprocess, 5 типов): AKT 128→16s, UPD 151→28s, BL 137→29s, customs 150→40s, invoice 117→36s (LLM-call duration); confidence не регресснул (4 из 5 ВЫРОС). Тесты `doc-service/tests/reasoning-effort.spec.ts` (6). Открытые хвосты:
  - **Реал-доки 15-40s, не 7s (как в бенче #36).** Бенч мерил на коротких golden-доках; реальные имеют 5000-10000-токенные промпты + 1500-2100 output-токенов — это честная генерация без reasoning (~50 tok/s на 27B), не overhead. Дальнейшее ускорение — короче промпт / меньше output / квантизация, не reasoning.
  - **customs_declaration: wall 105s при LLM-call 40s.** ~65s — пост-обработка пайплайна (XML/cross-doc match-keys/enrich), НЕ LLM. Ортогонально этому изменению; профилировать customs-pipeline отдельно.
  - **`reasoning_effort` — задокументирован в admin-CRUD/openapi (2026-07-01).** `extra` в CRUD уже был passthrough `z.record(z.unknown())` — create/patch принимали, get/list возвращали round-trip. Добавлено: `.describe()` на `extra` (Zod→swagger) + допустимые значения `"none"|"low"|"medium"|"high"` в описаниях POST/PATCH; round-trip-тесты (`provider-settings-api.spec.ts`) доказывают, что `reasoning_effort` переживает write/read нетронутым и НЕ шифруется (`encryptExtraSecrets` его не трогает — не в SECRET_EXTRA_KEYS). UI-тоггл — позже (frontend).

- **EXT-CORRESPONDENCE — класс «претензии / деловые письма» не покрыт + договоры (выявлено на боевом батче 2026-06-25, owner-decision: в техдолг).** На реальном пласте (18 доков) почти всё разложилось по существующим типам, но три не вписались:
  - `d93a2030` — **претензия**, ушла в `wire_transfer_application` (классификатор платёжки ложно сработал на SWIFT/банк-реквизитах при ОТСУТСТВИИ настоящих платёжных маркеров «заявление на перевод»/«платёжное поручение»).
  - `aa551d6e` + `a5fcf0f2` — структурно **не опознаны** (батч вырос до 34, теперь ДВА таких). Прозондированы 2026-06-25 на контракт-структурные маркеры (`именуемый в дальнейшем`, `предмет договора`, `реквизиты сторон`, `обязуется`, `ответственность сторон`, `о нижеследующем`, `срок действия`, `неотъемлемой частью`) — **ВСЕ нули у обоих** → это НЕ стандартные договоры, только *упоминают* «договор». a5fcf0f2 вдобавок имеет транспортные маркеры (накладная/коносамент) + «исх.№/уведомление». Скорее сопроводительные письма/уведомления к отгрузке. **Безопасного код-фикса нет** — нужен реальный обезличенный образец, чтобы понять что это и по какому ЗАГОЛОВКУ ловить.
  - `contract` (P1-1): тип есть (17 структурных ключей + llm_schema), но реальный договор не сматчил ни один (стем «договорА» без «ДОГОВОР №»/«Предмет договора»). NB: aa551d6e/a5fcf0f2 — НЕ он (структуры договора в них нет, см. зонд выше).

  Что сделать (когда накопятся примеры): (1) тип `claim`/претензия (заявитель/должник/основание-договор/сумма требования/срок/неустойка); (2) опц. общий `letter`/деловое письмо (исх.№/от/кому/тема/ссылка/суть); (3) подтянуть `wire_transfer_application`, чтобы требовал настоящий платёжный маркер, а не только SWIFT; (4) расширить classifier `contract` под реальный заголовок. ⚠️ **Классиф по ЗАГОЛОВКУ (анкер `^претензия`/`^договор`), НЕ по body-mention** — иначе счета/акты со ссылкой «по Договору №X»/«выставим претензию» улетят в новый тип. **Блокер: нужны 1-2 обезличенных образца** (претензия / договор / aa551d6e) — designing schema/keywords вслепую = риск ложных срабатываний на корпусе. См. [`doc-service/docs/BATCH_REVIEW_2026-06-25.md`](./doc-service/docs/BATCH_REVIEW_2026-06-25.md).

- **PD-CONTRACT-1 §2.1 — `extracted._match_signals` (build, в normalize pipeline).** Канонический FLAT-проекшн кросс-типовых match-ключей для SLAI matcher: `containers[]`, `bl_number`/`cmr_number`/`ttn_number`/`awb_number`, `declaration_numbers[]`, `order_refs[]`, `vehicle{plate,trailer}`, `parties{role→{name,inn?,kpp?}}`, `dates{document,shipped_on_board}`, `totals{amount,currency,vat}`, `_confidence{}`. Present-only (ключ только при наличии значения), `schema_version:"1.0"` всегда. Модуль `src/pipeline/normalize/match-signals.ts` (declarative `PROJECTORS` + generic fallback), вызывается из `runPostExtractNormalization` последним шагом → попадает в персист + webhook payload (внутри `extracted`). v1-совместимо (additive reserved-ключ). Тесты `tests/match-signals.spec.ts` (17). Открытые хвосты:
  - **order_refs зависит от SLAI Q2.** Сейчас маппится только из реально существующих schema-полей (`invoice.order_ref`, `items[].order_ref`). Для большинства типов отдельного «order/PO/Заказ №» поля в схеме нет → `order_refs` отсутствует (НЕ выдумываем). Полноценный order-ref extraction требует добавления поля в schema/prompt — это SLAI Q2, вне scope этого кода.
  - **`awb_number` / `dates.shipped_on_board` пока не эмитятся.** Канонические ключи зарезервированы в контракте/типе, но ни одна live-схема не отдаёт AWB (нет air_waybill типа) и `shipped_on_board` (BL_SCHEMA не извлекает дату «shipped on board»). Появятся автоматически когда соответствующие поля заведут в схемы — projector уже их читает (`ex.shipped_on_board`), маппинг для AWB добавить при появлении типа.
  - ~~**Двойная BL-схема.**~~ ✅ РЕШЕНО 2026-07-01. `bill_of_lading` исторически имел DB-снимок (`bl_number`, `containers[].container_number`) и текущую TS `BL_SCHEMA` (`number`, `containers[].number`); миграция `20260604000001` обнулила DB-снимок. Legacy-ветка чтения `bl_number`/nested `bl.number` **удалена** из BL-проектора после доказательства мёртвости: (1) прод `document_types.bill_of_lading.llm_schema IS NULL`, 0 схем эмитят `bl_number`, 0 схем нестят `container_number` в `containers[].items`; (2) 0 из 231 прод-job'ов несут `bl_number`/`containers[].container_number`/nested `bl` в `extracted` (все 29 BL-job'ов — на current-format `number`/`containers[].number`, `_match_signals.bl_number` заполнен из него); (3) ни extraction (`BL_SCHEMA`/`CONTAINERS`), ни normalize (`container-recovery` пишет `{number}`) не пишут legacy-ключи. Behavior-preserving — ветка ни на одном live-документе не срабатывала. `collectContainers` (shared, читает array-item `container_number` для устойчивости к разнобою) **НЕ тронут** — это не BL-снимок, а общая логика всех container-типов.
  - **`_confidence` источник — `extracted._field_confidence`.** §2.3 confidence для канонических ключей берётся из LLM field-confidence map (присутствует в extracted на шаге normalize, до того как webhook-delivery его поднимет наверх). Если LLM не прислала confidence → `_confidence` отсутствует. Калибровка (checksum-snap ИНН) применяется позже в `processFieldConfidence` к top-level `_field_confidence`, но НЕ к `_match_signals._confidence` — там сырые LLM-значения. Если SLAI нужны калиброванные — прокинуть калиброванный map в `buildMatchSignals` (сейчас вызывается до калибровки).

- **Audit follow-ups (2026-05-27) — задокументированы, не фикшены в этом заходе.** H1 (startup cross-validation byo+no-key / asr+no-url), M1 (0..1 bounds на confidence-knob'ах), L1 (capability-флаги в `/capabilities`) — закрыты. Остаток:
  - **H2 — BYO + hybrid-vision precedence.** Inline BYO-creds (`withInlineCredentials`, ALS) приоритетнее hybrid-routing'а: когда оба включены и приходит `X-LLM-*` на text-job, hybrid может выбрать `extract_mode='image'` (route_reason), но фактически extract идёт через inline text-провайдер consumer'а → reported mode расходится с реально использованным провайдером. **Product-решение**: либо задокументировать precedence в контракте (inline creds выигрывают, mode — informational), либо hybrid пропускает routing когда inline-creds присутствуют. Не код-фикс в одиночку — нужна договорённость с SLAI по семантике `extract_mode`.
  - **M2 — `url-fetch.ts capStreamBytes` игнорирует backpressure.** Стрим буферизуется до `maxBytes` без flow-control (нет pause/resume по высокой ватерлинии) — на большом файле с быстрым источником peak-RSS = весь буфер. Hard-ceiling защищает от unbounded, но память аллоцируется агрессивно. Переписать с пропер flow-control (pause при достижении порога чанка, resume после слива) позже.
  - **M3 — forced-provider fallthrough без observability.** При плохом `_force_provider_id` (несуществующий id / non-llm kind / отсутствует base_url) роутинг молча падает на default-провайдер — ни лога, ни метрики. Нужен logger или counter (`extractor_forced_provider_fallthrough_total{reason}`) чтобы отлавливать misconfig consumer'а. Сейчас диагностируется только по факту «extract пошёл не туда».
  - **M4 — enrich cache TTL зафиксирован на первом вызове + process-global.** DaData enrich-кэш по ИНН: TTL берётся из config один раз и кэш живёт в process-памяти (не per-tenant, не shared между worker-процессами при горизонтали). При горизонтальном scale-out каждый воркер греет свой кэш; смена `DADATA_CACHE_TTL_MS` требует рестарта. Низкий приоритет (данные ЕГРЮЛ меняются редко).

- **EXT-D (Q12) — file_url ingest (build, не задеплоено).** `POST /api/v1/jobs` принимает multipart-поля `file_url` (+ опц. `file_sha256`) как альтернативу `file`-парту — снимает 50MB multipart-bottleneck на больших фрахт-доках (SLAI pre-upload'ит в свой blob, шлёт нам ссылку). При `file_url` хэндлер скачивает документ server-side и далее идёт идентичный pipeline (magic-bytes, SHA-dedup, job create). Гейт — `FILE_URL_INGEST_ENABLED` (default false, fail-closed → `FILE_URL_DISABLED`). SSRF-защита в `src/pipeline/ingest/url-fetch.ts`: только http(s); host резолвится и блокируется если private/loopback/link-local/metadata/ULA/CGNAT (10.x, 127.x, 169.254.169.254, 172.16/12, 192.168, 100.64/10, ::1, fe80, fc00/7, ::ffff:v4-mapped) — ДО любого сетевого запроса; блок если ХОТЬ ОДИН A-record приватный; redirects не следуются (undici default; 3xx→`FILE_URL_FETCH_FAILED`); hard byte-ceiling enforced mid-stream (Content-Length не доверяем→`FILE_URL_TOO_LARGE`); timeout; опц. allowlist `FILE_URL_ALLOWED_HOSTS` (CSV); `file_sha256` mismatch→`FILE_URL_SHA_MISMATCH`. Ошибки наружу без internal-деталей (host-only в логах). Тесты `tests/file-url-ingest.spec.ts` (27, network/dns замоканы). Webhook v1-контракт не тронут. Открытые хвосты:
  - **DNS-rebind residual.** Проверяем резолв ДО запроса, но undici подключается по hostname заново (нет pin-to-resolved-IP при connect). TOCTOU-окно для DNS-rebind остаётся узким, но не нулевым. Полное закрытие — кастомный dispatcher/connector с lookup-pinning. Низкий приоритет: усилено allowlist'ом + private-IP блоком на обоих концах.
  - **Деплой fail-closed.** `FILE_URL_INGEST_ENABLED=false` по умолчанию; включение + прод `API_KEY` — на пользователе.

- **EXT-B (Q11) — BYO LLM credentials per request (build, не задеплоено).** Consumer (SLAI) передаёт свой LLM-провайдер/ключ/модель через заголовки `X-LLM-Provider` / `X-LLM-Api-Key` / `X-LLM-Model` / `X-LLM-Base-Url` на `POST /jobs`; THIS job идёт через эти creds вместо default `provider_settings`. Гейт — `BYO_LLM_ENABLED` (default false, fail-closed). Механизм: route шифрует creds secrets-envelope'ом и кладёт в `metadata._inline_llm_creds` (в БД/Redis — только непрозрачный ciphertext, plaintext-ключ никуда не пишется); worker (`orchestrator.processJob`) расшифровывает в hot-path и оборачивает обработку в `dynamicLlm.withInlineCredentials` (AsyncLocalStorage, приоритетнее `_force_provider_id`). Reserved-ключ вычищается из GET /jobs, webhook, redeliver. Метрики: `extractor_llm_credentials_supplied_total{provider}`, `extractor_llm_provider_errors_total{provider,code}` (code — грубый редактированный класс, не текст ошибки). Открытые хвосты:
  - **Header-only docs.** `X-LLM-*` описаны только в Swagger (route читает их из `req.headers`, не через zod-схему). При смене REST-контракта учесть это вручную.
  - **provider не роутится в inference.** Сейчас `provider` из заголовка идёт только в метрику-лейбл; ad-hoc `HttpLlmClient` шлёт `baseUrl`+`apiKey`+`model`. Если consumer'у нужен явный backend-select (не через base_url/model) — добавить проброс `provider` в тело `/v1/*`.
  - **Деплой fail-closed.** `BYO_LLM_ENABLED=false` по умолчанию; включение + прод `API_KEY`/`SECRETS_ENCRYPTION_KEY` — на пользователе. Webhook v1-контракт не менялся.

- **item A — extraction-from-image (build, не задеплоено).** Vision-модель извлекает структурированные поля напрямую из изображения первой страницы через реальный pipeline (`/v1/extract` + `image_base64`). Routing: `provider_settings.vision=true` (миграция `20260528000001`) ИЛИ `metadata._extract_from_image=true`. Открытые хвосты:
  - **Single-page only (v1).** В extract уходит только первая страница (raster `-f 1 -l 1`). Многостраничные сканы → шапка с image, items[] (multipass Pass 2) — text-only. Multi-page image-extract — отдельный заход.
  - **Seed vision-флага.** Миграция включает `vision=true` для `local-mistral-small-31` / `local-minicpm-v` + (на будущее) `local-qwen-vl-7b` / `local-qwen25-vl` / `local-llama32-vision` / `claude` / `anthropic`. Часть id ещё не заведена в `provider_settings` — UPDATE по ним no-op; завести vision-слот Qwen2.5-VL отдельно, когда модель будет в ollama.
  - **Деплой fail-closed.** Включение требует прод `API_KEY` (guard). Деплой — на пользователе.

- **Hybrid extraction routing (SLAI #3, build, не задеплоено).** Самый большой рычаг по latency-блокеру. После OCR+classify, перед extract, роутер (`src/pipeline/hybrid-router.ts`) выбирает PATH per-job: чистый text-PDF → быстрый text-провайдер (phi4, в SLA, без картинки); скан / низкая OCR-уверенность / image-вход / per-type `prefer_vision` → designated vision-провайдер (Qwen-VL) + картинка первой страницы (через `dynamicLlm.withForceProvider` ALS). `decideExtractPath()` — чистая функция; приоритет reason'ов: `forced_text` > `forced_image` > `prefer_vision` > `scan_engine` (tesseract/vision-llm/yandex или image-вход) > `low_ocr_conf` (< `HYBRID_VISION_CONF_THRESHOLD`, default 0.7) > `short_text` (< 80 симв/стр) > `clean_text`. Vision-провайдер резолвится `HYBRID_VISION_PROVIDER_ID` (явный id) или автоподбором активной vision-строки (`providerSettingsRepo.findActiveVision()`). Гейт — `HYBRID_ROUTING_ENABLED` (default false → поведение в точности как сегодня, item A `provider.vision`/`metadata._extract_from_image` работают как раньше). Per-job override: `metadata._extract_from_text=true` форсит text, `_extract_from_image=true` форсит vision. Per-type — `document_types.prefer_vision` (миграция `20260528000002`). `extract_mode`+`route_reason` пишутся в pipeline step (job detail). Тесты `tests/hybrid-routing.spec.ts` (21). Webhook v1 не тронут. Открытые хвосты:
  - **route_reason vs extract_mode на fail-soft.** Когда vision запрошен, но провайдер/картинка недоступны — откат на text: `route_reason` остаётся «почему хотели vision» (например `scan_engine`), а `extract_mode='text'`. Это сознательно (видно намерение vs факт), но для дашборда нужно читать оба поля, не только reason.
  - **Single-page (наследует item A).** Vision-путь шлёт только первую страницу. Многостраничный скан → шапка по картинке, items[] (multipass) text-only.
  - **prefer_vision не в openapi/UI.** Колонка `document_types.prefer_vision` отдаётся в admin CRUD response/create/patch (zod), но не описана в `docs/openapi/v1.yaml` (там DocumentType — это outbound webhook-slug, не admin-registry). UI-тоггл — за `frontend`.
  - **Деплой fail-closed.** `HYBRID_ROUTING_ENABLED=false` по умолчанию; включение + завести vision-слот (Qwen2.5-VL) в `provider_settings` с `vision=true` — на пользователе.

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
- ✅ **CP1 закрыт полностью** (проверено 2026-05-24): классификатор читает `classification_keywords`/веса из `document_types` (`classifier/keywords.ts:95-136`, hardcoded — только fallback пустой БД); parser_kind диспатчит парсер из БД (`orchestrator.ts:808-830`, CHECK-констрейнт на колонке); `llm_prompt` override доходит до inference-service (закрыто Phase 3 Day 8). Эта строка раньше была устаревшей.

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
- ✅ Парсеры/классификатор/пороги стали DB-driven в Day 2-3 (CP1 закрыт — см. отметку 2026-05-24 в Day 3).

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

## 🟠 Important (укусит при ramp-up)

> **CP7, I6, Phase F** перенесены в `TECH_DEBT_ARCHIVE.md` → раздел «Deferred backlog (snapshot 2026-05-19)». Триггеры возврата записаны там.

### EXT-1. tax_invoice / счёт-фактура уходит в regex-only, LLM не вызывается — 🟠 OPEN (2026-05-25)

Real-doc bench 2026-05-25 (`eval/real/qwenvl-real-v1-2026-05-25.json`):
для `tax_invoice` (doc 03/04) `raw_response` пустой, `total_duration_ms`
10-12 мс → парсер вернул regex-результат и **не дошёл до LLM-fallback**.
Следствие: `number` приходит из regex с cell-bleed (`260422/012от22`),
а seller/buyer ИНН вообще не извлекаются (regex для счёт-фактуры их не
ищет). Это **конфиг DB document_types**, не код: либо
`regex_fallback_threshold` слишком низкий (regex проходит планку и LLM
скипается), либо у типа нет привязки к llm_extract parser_kind. Чинить в
проде через `document_types` row для tax_invoice (поднять
`confidence_threshold` / `regex_fallback_threshold` или перевести на
`llm_extract`). Code-fix не требуется. Передать product/qa для правки
конфигурации перед ре-бенчем.

### UI-2. Mobile-responsive React UI — ✅ закрыто 2026-05-20

Card-mode для таблиц на `<md` (JobsList / Tenants / DocumentTypes /
ReferenceLists; AuditLog уже был карточным), прогрессивное скрытие
вторичных колонок на lg/xl, top-bar/search/dropdown без overflow,
touch-targets ≥40px. Desktop (≥md) не изменился. Чисто
презентационно, без правок логики. Commit `cf7d008`.

---

## 🎨 Frontend backlog — «данные есть, экрана нет» (2026-05-20)

Бэкенд-изменения последних дней положили в данные то, что UI пока не
показывает. Берём потихоньку, в порядке ценности.

### UI-3. Multi-doc PDF результаты в JobDetail/Review — ✅ закрыто 2026-05-20 (`f5172cb`)

MultiDocView в JobDetail: таб-strip (primary editable tab 0 + read-only
таб на сегмент, каждый с document_type+TierBadge / page_range /
ConfidenceBar / extracted + field_confidence). `_multidoc_documents`
вычищается из primary-панели. Чип «N документов» в Review. Остаток
(минор): доминирующий doc может дублироваться как primary-таб и как
свой сегмент — допустимо в первом cut.

### UI-4. classify_only-aware рендеринг — ✅ закрыто 2026-05-20 (`f5172cb`)

Сигнал — pipeline-шаг `parse:skipped`. Баннер «только классификация» +
карточка type/confidence вместо пустой панели; Edit отключён; чип
«classify-only» в Review.

### UI-5. Webhook delivery статус — ✅ закрыто 2026-05-20

Панель «Доставка вебхука» в JobDetail (доставлено / ожидает / ошибка + последняя
ошибка + кол-во попыток + target URL) и компактный чип (✓/✗/•) в списке работ
(desktop-строка и mobile-карточка). Render-only — данные уже на `Job`
(`webhook_attempts/_delivered_at/_last_error/_url`). Pull-mode (нет webhook_url)
→ ничего не рисуем. Фильтр «недоставленные» для админа — отложен (выносим в UI-7
как срез либо отдельным мелким пунктом, если попросят).

### UI-6. Inline per-field confidence подсветка — ✅ закрыто 2026-05-20

`ExtractedDataPanel` получил опц. `fieldConfidence` → каждое top-level поле
красится по порогам ConfidenceBar (≥0.85 emerald/без фона · 0.6–0.85 amber ·
<0.6 rose) + тонкий ConfidenceBar с % под значением. Поля без записи в карте —
без регрессии. Вложенные party-поля по dotted-ключам (`seller.inn`). Провязано
во все три вызова JobDetail (single + multidoc primary + segment). Issue-amber
сохраняет приоритет над confidence-цветом.

**Хвост (минор, опц.):** standalone `FieldConfidenceCard` оставлена (даёт полный
сорт-список всех ключей, в т.ч. нес-displayed) — но у неё legacy-пороги 0.9/0.7
и нет dark-mode. Если захотим одну шкалу на странице — выровнять под ConfidenceBar.

### UI-7. Dashboard-срезы по tier / engine — ✅ закрыто 2026-05-23 (consumer отложен)

`getOperationalSummary` получил `by_engine` (GROUP BY ocr_engine, `_none` для
пустого) и `by_tier` (LEFT JOIN document_types, GROUP BY tier, `_untyped` для
несматченных) — через DRY-хелпер `groupBreakdown`, тот же window+scope. Dashboard
рисует две новые таблицы (`BreakdownTable`): «По OCR-движку» и «По зрелости типа»
(TierBadge + колонка «% проверки» — видно, тянет ли experimental needs_review
вниз). Пустые срезы скрыты.

**Отложено:** consumer-срез (`by_organization`) — без super_admin вырождается в
1 строку; вернёмся при мульти-tenant проде (см. ROADMAP «заморожено»-логика).

---

## 🟢 Test harness / quality gate

### Vitest env harness + surfaced bugs — ✅ закрыто 2026-05-20

`config.ts` вызывает `loadConfig()` на module-eval, и ~19 spec-файлов
падали на collection из-за отсутствия env (ESM hoist'ит import'ы выше
inline `process.env.X ??=`). Починено `vitest.config.ts` +
`vitest.setup.ts` (setupFiles стабит env через `??=`, real CI
оверрайдит; pool:forks). Collection-фейлы 19→0, открылось ~148 ранее
несобираемых тестов.

Это вскрыло реальные баги (были замаскированы), все починены (commit
`c9fb10e`):
- `findInn` резал 12-значный ИНН (ИП) до 10.
- VAT-извлечение брало ставку/подытог вместо суммы НДС.
- `validateDate` пропускал календарно-невалидные даты (2026-02-30).
- Классификатор не матчил голую кириллицу (`\b` в JS не работает с
  кириллицей) — «АКТ/счёт/УПД/ТТН» молча не классифицировались.

Suite зелёный: 50 файлов, 619 passed, 1 pre-existing skip.

**Остаточный долг:** часть тестов (`pipeline-integration`) мокают БД;
полноценный integration-прогон против live Postgres/Redis — отдельный
`test:integration` (не сделан, не блокер).

---

## 🚛 SLAI integration debt (ТЗ от 2026-05-16, ждём ответ разработчика SLAI)

См. `Desktop/parsdocs-validation-bench/SLAI_QUESTIONS.md` (мы → SLAI),
`SLAI_ANSWERS.md` (SLAI → нам), `SLAI_OUR_REPLY.md` (мы → SLAI обратно
с решениями по [ПРОДУКТ] меткам и ответами на 6 встречных вопросов).

### F3. SLAI webhook receiver + service-token — 🟡 item 4 закрыто 2026-05-19, остаток заблокирован Q4/Q5

**Где:** новый `routes/slai-callbacks.ts` + `auth/named-keys.ts` уже есть.

**Чек-лист:**
1. ⏸️ `POST /api/v1/parsdocs/webhook` receiver (на стороне SLAI —
   мы его не пишем, но согласовываем формат). Заблокирован Q4 (нужен
   service-token) + Q5 (продакт SLAI должен подтвердить ETA).
2. ✅ HMAC-подпись на наших исходящих webhook — есть в коде
   (`WEBHOOK_HMAC_SECRET`, `x-parsdocs-signature`), zero-trust verify
   на стороне SLAI задокументирован в `docs/openapi/v1.yaml`.
3. ⏸️ Service-token для SLAI side в нашей `API_KEYS_JSON` с именем
   `slai` — генерируется по факту, когда продакт SLAI скажет «деплоим»
   (см. INTEGRATION_QUEUE Q4).
4. ✅ **OpenAPI v1 spec для webhook-payload** —
   `doc-service/docs/openapi/v1.yaml` (закрыто 2026-05-19). OpenAPI
   3.1, 13 схем (WebhookPayload + 4 типизированных Extracted + Party +
   GenericExtracted + ExtractedDocumentEntry + JobStatus/DocumentType/
   OcrEngine enums), 4 примера (single-doc done / needs_review /
   multi-doc bundle / failed), 6 параметров (HMAC headers + legacy
   x-docservice-*). Описаны delivery semantics, idempotency, retry,
   versioning (v1 → v2), outbound slug aliasing, redact_pii, reserved
   `_issues`/`_field_confidence`/`documents` ключи.

**Срок остатка:** 0.5 дня после разблокировки Q4/Q5.

---

### F5. Multi-document PDF (`documents: Array<>`) — ✅ закрыто 2026-05-19 (xlsx + PDF text-layer + tesseract scan)

**Сделано (skeleton):**

1. `src/pipeline/multidoc/types.ts`:
   - `PageClassification` — результат классификации одной страницы
     (page, document_type, confidence, text_preview)
   - `DocumentSegment` — последовательность страниц одного типа
     (document_type, page_from, page_to, confidence, combined_text)
   - `ExtractedDocumentEntry` — финальный entry для webhook payload
   - `formatPageRange()` helper («1» / «2-4»)

2. `src/pipeline/multidoc/splitter.ts`:
   - `splitPagesIntoSegments(pages, texts, opts)` — greedy consecutive
     grouping. Параметры:
     * `minConfidenceForNewSegment` (default 0.4) — низкоуверенные
       страницы присоединяются к предыдущему сегменту
     * `minTextLengthForClassification` (default 100 chars) — пустые
       страницы тоже присоединяются (не открывают свой сегмент)
   - `isMultiDocument(segments)` — heuristic: реальный multi-doc только
     если ≥ 2 сегментов с разными типами и confidence ≥ 0.6
     Это backwards-compat: если все одного типа, single-doc pipeline.

3. `src/webhooks/deliver.ts`:
   - `WebhookPayload.documents?: Array<...>` — новое опциональное поле.
     Заполняется ТОЛЬКО для реального multi-doc. Single-doc → `extracted`
     как обычно (v1 backwards-compatible).

4. 16 unit-тестов в `tests/multidoc-splitter.spec.ts`:
   - single-doc (одна или N страниц одного типа)
   - multi-doc (счёт + ТТН, 3 разных типа подряд)
   - combined_text объединяет через \n\n
   - low-confidence страница присоединяется к предыдущему
   - пустая страница (короткий текст) присоединяется к предыдущему
   - null document_type на странице — присоединяется
   - `isMultiDocument` heuristic: < 2 сегментов / одного типа / low conf → false

**Закрыто (2026-05-19):**

5. ✅ **PDF rasterizer → per-page OCR.** Tesseract уже эмитит
   `OcrResult.pages[]` для PDF (через pdftoppm + per-page recognize).
   PdfTextEngine теперь тоже отдаёт `pages[]` — через кастомный
   `pagerender` callback в `pdf-parse`, который дублирует текст в
   closure-captured массив, не ломая default-конкатенацию. Так что
   и тексто-слойные PDF, и сканы попадают в multidoc splitter с
   page-by-page данными. `src/pipeline/ocr/pdf-text.ts`,
   `tests/pdf-text-pages.spec.ts`.

6. ✅ **Per-segment extract.** Сделано в `multidoc/runner.ts`
   (xlsx-MVP коммитом 14fae43); orchestrator подключает
   `tryMultiDoc()` когда `ocr.pages.length > 1`. Каждый segment
   гоняется через `runDocumentPipeline` c `hint=type` чтобы
   classifier не переключался. Результат → `documents[]`.

7. ✅ **Webhook payload `documents[]`.** `webhook-delivery.ts`
   вытаскивает `_multidoc_documents` из extracted в top-level
   `payload.documents` (+slug-нормализация). При single-doc поле
   отсутствует — backwards-compatible.

8. ✅ **Tests.** `multidoc-splitter.spec.ts` (16 unit-тестов на
   splitter + relaxed-heuristic) + `pdf-text-pages.spec.ts`
   (per-page emission через pdf-parse pagerender). Orchestrator
   integration smoke остаётся в e2e фикстурах (отдельная
   итерация — нужны fixture'ы с реальным мультидок-PDF).

См. PARSDOCS_REPLY_TO_SLAI_TZ.md секция «Q1 Multi-document PDF» и
SLAI_OUR_REPLY.md секция 9.4.

**Где:** `pipeline/multidoc/{types,splitter,runner}.ts`,
`pipeline/ocr/pdf-text.ts`, `pipeline/ocr/tesseract.ts`,
`pipeline/webhook-delivery.ts`, `pipeline/orchestrator.ts`.

**Симптом (был):** если в PDF два разных документа (1 стр — счёт,
2-3 стр — ТТН), модель угадывала доминирующий тип и теряла второй.
SLAI хотел два отдельных Document'а в payload.

**Что осталось вне F5:**
- Orchestrator integration test на реальный multi-doc PDF (нужен
  fixture; не блокирует пилот).
- Версия v2 контракта где `documents[]` обязательное (сейчас
  опциональное v1 поле; v2 — после полугода параллельной поддержки).

---

### Долги из SLAI ТЗ v1.0 (2026-05-17) — F16-F27

См. `doc-service/docs/SLAI_TZ_v1_2026-05-17.md` (ТЗ от SLAI) и
`doc-service/docs/PARSDOCS_REPLY_TO_SLAI_TZ.md` (наш ответ).

| # | Долг | Срок | Приоритет |
|---|---|---|---|
| ~~**F16**~~ | ~~Новый тип `transport_request` (заявка на перевозку)~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F17**~~ | ~~Новый тип `transport_invoice` (ТН формы 2013)~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F18**~~ | ~~Новый тип `waybill` (путевой лист)~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F19**~~ | ~~Bank-реквизиты в invoice schema~~ — ✅ закрыто 2026-05-17 (PARTY schema расширен + prompt) | — | — |
| ~~**F20**~~ | ~~One-shot `metadata.prompt_override` для reprocess~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F21**~~ | ~~`GET /jobs/:id/raw-text` endpoint~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F22**~~ | ~~Case-insensitive document_type lookup~~ — ✅ закрыто 2026-05-17 (SLAI_ALIASES map + uppercase/lowercase fallback) | — | — |
| ~~**F23**~~ | ~~Tesseract китайский (chi-sim)~~ — ✅ закрыто 2026-05-17 (Dockerfile + Docker-rebuild) | — | — |
| ~~**F24**~~ | ~~Tesseract турецкий (tur)~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F25**~~ | ~~Tesseract польский (pol)~~ — ✅ закрыто 2026-05-17 | — | — |
| ~~**F26**~~ | ~~API-param `metadata.tesseract_langs`~~ — ✅ закрыто 2026-05-17 (per-job override через OcrInput.tesseractLangsOverride) | — | — |
| ~~**F27**~~ | ~~`metadata.delete_after_processing` flag~~ — ✅ закрыто 2026-05-17 (immediate delete после webhook) | — | — |

**Блокер старта:** golden dataset из `~/Desktop/SLAI/test-docs/` —
15 PDF + 15 .gt.json для invoice / request / ttn. Запросили у SLAI scp /
Yandex.Disk / в репо. Без него не запустим baseline и не сможем тюнить
prompt'ы под их форматы.

---

### A1. inference-service синхронный — closed 2026-05-19

**Симптом (исторический):** Каждый `POST /v1/extract` блокировал FastAPI worker. Под нагрузкой запросы стояли в backlog'е, потому что Claude backend оборачивал sync `Anthropic` SDK через `asyncio.to_thread` — каждый concurrent extract отъедал поток из default executor (~32 шт), и под бурстом всё начинало queue'иться невидимо.

**Done:**
- `ClaudeBackend` мигрирован на `AsyncAnthropic`. `messages.create` теперь awaitable нативно, без `asyncio.to_thread` обёртки. `is_ready()` — структурный (булевый флаг), реальных sync вызовов в hot path не осталось. (`inference-service/src/inference_service/backends/claude.py`)
- `OpenAICompatibleBackend` уже использовал `AsyncOpenAI` — ничего не меняли.
- Backend-уровневый `_admit` (asyncio.Semaphore на `ModelBackend`) cap'ит concurrent calls по `MAX_CONCURRENT_CALLS` (default 16). Очередит, не отвергает — для совместимости с долгим upstream'ом.
- Route-уровневый `AdmissionGate` (новый, `inference-service/src/inference_service/admission.py`) — admission control с **rejection**: при переполнении лимита `MAX_CONCURRENT_INFLIGHT` (default 8) запрос получает `503 Service Unavailable` + `Retry-After: 2`. Это даёт видимость saturation (метрика `inference_gate_rejections_total`) и защищает от невидимого роста очередей.
- Gate подключён к четырём горячим маршрутам: `/v1/extract`, `/v1/classify`, `/v1/vision-ocr`, `/v1/verify`. Cheap probes (`/health`, `/ready`, `/metrics`, `/v1/providers/status`) обходят gate, чтобы saturation можно было наблюдать.
- Метрики Prometheus: `inference_gate_inflight` (Gauge — текущие занятые слоты), `inference_gate_rejections_total` (Counter — отказы 503).
- Test coverage: `inference-service/tests/test_claude_backend.py` (6 тестов, AsyncAnthropic SDK замокан) + `inference-service/tests/test_concurrency.py` (6 тестов, включая sync semaphore semantics, gauge cleanup на exception, и end-to-end 5-параллельных-запросов через ASGITransport с проверкой 503+Retry-After+counter delta).

**Deferred (отдельная задача, hardware-coupled):**
- Qwen-VL backend остаётся in-process через `transformers` — GIL-bound, не масштабируется горизонтально на одном GPU. Миграция на vLLM с continuous batching обсуждается отдельно (требует решения по железу: 1×A100 vs 2×L4 vs cloud GPU, плюс модель weights pull во внутренний registry).
- Redis-очередь поверх inference-service **не реализована намеренно** — `/v1/extract` остаётся request/response, потому что doc-service BullMQ worker уже async-job pattern и менять контракт значит ломать v1.

**Решение записано в карточке** `parsdocs.md` строкой от 2026-05-19.

---

### A2. Storage abstraction half-done — closed 2026-05-19

**Done:**
- `FileStorage` интерфейс расширен `materialize()` + `remove()` сверх `saveStream()`.
- `S3FileStorage` через `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (multipart upload, streaming). Совместим с MinIO (`S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true`).
- Конфиг-селектор `STORAGE_BACKEND=local|s3`. При `s3` обязательны `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`; иначе fail-fast с понятной ошибкой.
- Write-through локальный кэш: `saveStream` пишет в S3 И в `<STORAGE_DIR>/uploads/<id>/<file>`, что позволяет post-upload pipeline (OCR в том же worker'е) читать с диска без round-trip в S3.
- `materialize()` — fast-path по кэшу, иначе stream GetObject → tmp; cleanup unlink'ает tmp на ошибке/после OCR.
- `remove()` — DeleteObject + чистка локального кэша. Идемпотентен на NoSuchKey/ENOENT.
- Orchestrator оборачивает OCR в `try/finally` с `materialized.cleanup()`. Download endpoint (`GET /jobs/:id/file`) — то же.
- Backwards-compat: `localFileStorage` остался экспортом-алиасом на активный backend; `removeStoredFile` всё ещё экспортирован (используется webhook-delivery.ts для immediate delete).
- Test coverage: `tests/file-storage-s3.spec.ts`, 15 assertions поверх `aws-sdk-client-mock` (PUT/GET/DELETE + кэш-fast-path + cleanup + factory edge-cases).

**Deferred (true shared-nothing horizontal scaling):**
- Сейчас orchestrator/OCR-движки принимают `filePath: string` и читают с локального диска. Worker в другом pod'е через `materialize()` стянет файл из S3, но это extra round-trip и плата за хранение в tmp. Полный stream-mode (OCR читает напрямую из S3 Body) требует переписать каждый движок — `pdftoppm`, `tesseract`, `pdf-parse`, `sheetjs`, `mammoth` — все ожидают локальный путь.
- Локальный кэш не очищается отдельно — он живёт по тем же retention-правилам что и LocalFs (file-cleanup sweeper). Это нормально пока кэш bounded; для долгоживущих pod'ов с большим объёмом нужен отдельный LRU.

---
