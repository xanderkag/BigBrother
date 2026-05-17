-- Up Migration
--
-- F13 (SLAI ТЗ v1.0 + SLAI_NOTE_CATEGORY_SYNC): инфраструктура для
-- continuous category sync.
--
-- Контекст (см. PARSDOCS_CATEGORY_SYNC_REPLY.md и SLAI_NOTE_*):
-- SLAI присылает webhook'и при изменении номенклатуры в их БД
-- (TypeORM @AfterInsert/Update/Remove на Nomenclature).
-- Мы складываем их в `sync_inbox`, фоновый sweeper применяет к
-- `slai_category_map` lookup-table. Снимок целого справочника
-- прилетает раз в сутки snapshot endpoint'ом для reconcile.
--
-- Таблицы:
--   slai_category_map — текущий снимок mapping SLAI category_id → наш
--                       category_hint (используется orchestrator'ом
--                       в applyCategoryHints для дополнительной
--                       sync-aware точности)
--   sync_inbox        — очередь событий от SLAI. UNIQUE на event_id =
--                       идемпотентность повторных доставок при retry

CREATE TABLE IF NOT EXISTS slai_category_map (
    slai_category_id     BIGINT PRIMARY KEY,
    name                 TEXT NOT NULL,
    -- Локальный hint в нашей терминологии (food / metal / fuel / ...).
    -- Может быть NULL пока operator не сопоставил вручную через UI.
    our_hint             TEXT,
    -- Подкатегория SLAI (если есть)
    subcategory_id       BIGINT,
    subcategory_name     TEXT,
    -- active=false когда SLAI помечает category как удалённую (soft-delete)
    active               BOOLEAN NOT NULL DEFAULT true,
    -- Метрика реального использования (приходит в daily snapshot
    -- `category_hist_30d`) — operator видит «насколько эту категорию
    -- стоит мапить хорошо»
    usage_count_30d      INTEGER NOT NULL DEFAULT 0,
    items_count          INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slai_category_map_active
    ON slai_category_map (active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_slai_category_map_our_hint
    ON slai_category_map (our_hint);
CREATE INDEX IF NOT EXISTS idx_slai_category_map_usage
    ON slai_category_map (usage_count_30d DESC);

CREATE TABLE IF NOT EXISTS sync_inbox (
    -- ULID или их event_id — UNIQUE для идемпотентности (см. наш ответ
    -- на Q7 в PARSDOCS_CATEGORY_SYNC_REPLY.md)
    event_id             TEXT PRIMARY KEY,
    -- Event type (category.added / nomenclature.changed / ...)
    event_type           TEXT NOT NULL,
    -- v1 / v2 / ... согласно X-SLAI-Version header
    version              TEXT NOT NULL DEFAULT 'v1',
    -- Полный payload как пришёл (для replay и audit)
    payload              JSONB NOT NULL,
    -- Когда мы приняли event
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL пока не обработан, timestamp когда sweeper применил
    processed_at         TIMESTAMPTZ,
    -- Текст ошибки если обработка не удалась
    last_error           TEXT,
    -- Сколько раз пытались обработать (retry counter)
    attempts             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sync_inbox_pending
    ON sync_inbox (received_at) WHERE processed_at IS NULL;

-- Триггер обновления updated_at для slai_category_map (consistency с
-- остальными нашими таблицами — переиспользуем уже существующую функцию
-- jobs_set_updated_at если есть; иначе создаём свою)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at_now') THEN
        CREATE OR REPLACE FUNCTION set_updated_at_now()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;
    END IF;
END $$;

CREATE OR REPLACE TRIGGER trg_slai_category_map_updated_at
    BEFORE UPDATE ON slai_category_map
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at_now();

-- Down Migration
DROP TRIGGER IF EXISTS trg_slai_category_map_updated_at ON slai_category_map;
DROP TABLE IF EXISTS sync_inbox;
DROP TABLE IF EXISTS slai_category_map;
-- set_updated_at_now() оставляем — может быть в использовании другими таблицами.
