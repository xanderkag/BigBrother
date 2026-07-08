-- Up Migration
--
-- Заводим `yandex_vision` — облачный OCR Яндекса — как НАСТОЯЩУЮ интеграцию:
-- внешний платный сервис за нашим ключом, с рубильником, лимитом и счётчиком.
--
-- ПОЧЕМУ ИМЕННО ТАК, а не коннектор «ocr»:
-- «Распознавание» — это этап пайплайна, он есть всегда (tesseract локально).
-- Интеграция — конкретный ВНЕШНИЙ сервис, куда уходят изображения документов.
-- Поэтому строка в списке — «Яндекс Vision», и её тумблер имеет однозначный
-- смысл: выключен → страницы не уходят в облако Яндекса.
-- (Предыдущая попытка завести абстрактный `ocr` с «переключателем движка» была
-- откачена: она обещала приватность, которую не обеспечивала.)
--
-- enabled = true по умолчанию: не меняем поведение существующих установок.
-- Яндекс и раньше работал, если задан YANDEX_VISION_API_KEY + YANDEX_FOLDER_ID.
-- Новое здесь — возможность его выключить из интерфейса.
--
-- ГРАНИЦА ОТВЕТСТВЕННОСТИ (важно, не перепутать):
--   * этот тумблер — операционный//costовый рубильник облачного OCR;
--   * гарантия по ПДн (ТТН/CMR) остаётся за env-гардом YANDEX_DISABLE_FOR_PII
--     и per-job `_disable_external_ocr`. Они не зависят от БД и всегда сильнее:
--     фильтры каскада соединены через AND, поэтому тумблер может ТОЛЬКО убрать
--     Яндекс из цепочки, никогда не добавить.
--
-- unit_kind='pages' обязан присутствовать в zod-энуме UnitKind
-- (routes/gateway-admin.ts) и в GatewayUnitKind (storage/llm-usage.ts) —
-- иначе GET /gateway/connectors упадёт валидацией и уронит весь экран.
--
-- Учёт: страницы, реально отправленные в Яндекс, пишутся в llm_gateway_usage
-- (connector='yandex_vision', unit_kind='pages'). Суточный лимит энфорсится
-- через checkConsumerQuota. Месячный cap отображается, но НЕ энфорсится —
-- это существующее поведение всех коннекторов, не регрессия этой миграции.
--
-- Forward-only, идемпотентно.

BEGIN;

INSERT INTO gateway_connectors (slug, display_name, provider_kind, unit_kind, enabled) VALUES
    ('yandex_vision', 'Яндекс Vision (облачный OCR)', 'yandex_vision', 'pages', true)
ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE conn record;
BEGIN
    SELECT * INTO conn FROM gateway_connectors WHERE slug = 'yandex_vision';
    IF conn IS NULL THEN
        RAISE EXCEPTION 'yandex_vision connector not seeded';
    END IF;
    IF conn.unit_kind <> 'pages' THEN
        RAISE EXCEPTION 'yandex_vision unit_kind must be pages, got %', conn.unit_kind;
    END IF;
    -- Строка ОБЯЗАНА существовать: рантайм-гейт трактует её отсутствие как
    -- «облачный OCR запрещён» (fail-closed), чтобы неприменённая миграция
    -- не привела к молчаливой отправке сканов наружу.
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM gateway_connectors WHERE slug = 'yandex_vision';
COMMIT;
