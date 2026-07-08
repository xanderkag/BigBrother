-- Up Migration
--
-- Экран «Интеграции» показывал только 3 коннектора (llm / dadata / yandex_maps),
-- хотя платформа реально ходит ещё в два внешних слоя:
--   ocr — распознавание сканов и фото (движки: tesseract, yandex-vision, vision-llm);
--   asr — распознавание речи (сейчас faster-whisper).
-- Оба настраивались, но были невидимы: без тумблера, без лимитов, без учёта расхода.
-- Заводим их в реестр, чтобы «Интеграции» стали честной панелью всего, что подключено.
--
-- provider_kind='ocr' уже существует в provider_settings (миграция 20260513000004
-- засеяла 'tesseract' и 'yandex-vision'), поэтому переключатель исполнителя для OCR
-- заработает сразу — включая вариант «Yandex Vision».
--
-- provider_kind='asr' в provider_settings ПОКА НЕТ (ASR настраивается через env
-- inference-service: ASR_BASE_URL / ASR_MODEL). Коннектор заводим выключенным —
-- он даёт видимость, тумблер и лимиты; выбор исполнителя появится, когда заведём
-- kind='asr' в provider_settings. Так честнее, чем прятать интеграцию.
--
-- ⚠ unit_kind 'pages'/'minutes' обязан присутствовать в zod-энуме UnitKind
--   (routes/gateway-admin.ts) — иначе GET /gateway/connectors упадёт валидацией
--   и уронит весь экран. Расширено тем же коммитом.
--
-- Enforcement квот в роуты по-прежнему не вшит (см. 20260625000004) — здесь
-- только реестр. Forward-only, идемпотентно.

BEGIN;

INSERT INTO gateway_connectors (slug, display_name, provider_kind, unit_kind, enabled) VALUES
    ('ocr', 'Распознавание сканов', 'ocr', 'pages',   true),
    ('asr', 'Распознавание речи',   'asr', 'minutes', false)
ON CONFLICT (slug) DO NOTHING;

-- Sanity: пять коннекторов, ocr включён, asr спит.
DO $$
DECLARE cnt int;
BEGIN
    SELECT count(*) INTO cnt FROM gateway_connectors
     WHERE slug IN ('llm','dadata','yandex_maps','ocr','asr');
    IF cnt <> 5 THEN
        RAISE EXCEPTION 'expected 5 connectors after ocr/asr seed, got %', cnt;
    END IF;

    IF (SELECT enabled FROM gateway_connectors WHERE slug='ocr') IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'ocr connector must be enabled (OCR is on the hot path)';
    END IF;

    IF (SELECT unit_kind FROM gateway_connectors WHERE slug='ocr') <> 'pages' THEN
        RAISE EXCEPTION 'ocr connector unit_kind must be pages';
    END IF;
    IF (SELECT unit_kind FROM gateway_connectors WHERE slug='asr') <> 'minutes' THEN
        RAISE EXCEPTION 'asr connector unit_kind must be minutes';
    END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
DELETE FROM gateway_connectors WHERE slug IN ('ocr', 'asr');
COMMIT;
