-- Up Migration
--
-- ГТД (customs_declaration): модель кладёт ОГРН (13 цифр) в поле `inn`,
-- потому что в схеме сторон нет отдельного поля под ОГРН. Валидатор
-- `inn_checksum` бьёт «ИНН должен быть 10 или 12 цифр, получено 13» →
-- документ уходит в needs_review хотя разобран правильно.
--
-- Реальный кейс 2026-07-10: 29 из 54 ГТД в needs_review, 23 из них —
-- один и тот же ОГРН 1147847397906 в поле seller.inn/recipient.inn.
--
-- Фикс двусторонний:
--   1. Схема: добавляем `ogrn` (+ `kpp` где нет) в seller/sender/recipient —
--      даём модели куда положить 13-значный номер.
--   2. Промпт: явно разводим ИНН (10/12 цифр) и ОГРН (13) / ОГРНИП (15).

BEGIN;

-- ── 1. Схема: добавляем ogrn/kpp в party-объекты ───────────────────
-- jsonb_set по каждой стороне. Добавляем ogrn во все, kpp туда где нет
-- (declarant уже имеет kpp — не трогаем его structure, только ogrn).
UPDATE document_types
SET llm_schema = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        llm_schema,
        '{properties,seller,properties,ogrn}',
        '{"type":"string","description":"ОГРН (13 цифр) / ОГРНИП (15) — НЕ путать с ИНН"}'::jsonb
      ),
      '{properties,seller,properties,kpp}',
      '{"type":"string","description":"КПП (9 цифр), только у юрлиц"}'::jsonb
    ),
    '{properties,recipient,properties,ogrn}',
    '{"type":"string","description":"ОГРН (13 цифр) / ОГРНИП (15) — НЕ путать с ИНН"}'::jsonb
  ),
  '{properties,recipient,properties,kpp}',
  '{"type":"string","description":"КПП (9 цифр), только у юрлиц"}'::jsonb
)
WHERE slug = 'customs_declaration';

-- sender отдельным шагом (чтобы не городить 6-уровневый jsonb_set).
UPDATE document_types
SET llm_schema = jsonb_set(
  jsonb_set(
    llm_schema,
    '{properties,sender,properties,ogrn}',
    '{"type":"string","description":"ОГРН (13 цифр) / ОГРНИП (15) — НЕ путать с ИНН"}'::jsonb
  ),
  '{properties,sender,properties,kpp}',
  '{"type":"string","description":"КПП (9 цифр), только у юрлиц"}'::jsonb
)
WHERE slug = 'customs_declaration';

-- ── 2. Промпт: разводим ИНН и ОГРН ─────────────────────────────────
UPDATE document_types
SET llm_prompt = llm_prompt || '

ВАЖНО про идентификаторы сторон (seller/sender/declarant/recipient):
- `inn` — ИНН строго 10 цифр (юрлицо) ИЛИ 12 цифр (ИП). НИЧЕГО другого.
- `ogrn` — ОГРН 13 цифр (юрлицо) ИЛИ ОГРНИП 15 цифр (ИП). Это ДРУГОЙ номер.
- `kpp` — КПП 9 цифр, только у юрлиц.
НЕ клади 13-значный ОГРН в поле inn — для него есть поле ogrn. Если видишь
13 цифр рядом с меткой «ОГРН» или «ОГРН/ОГРНИП» — это ogrn, не inn.'
WHERE slug = 'customs_declaration';

-- Sanity check
DO $$
DECLARE has_ogrn boolean;
BEGIN
  SELECT (llm_schema->'properties'->'seller'->'properties' ? 'ogrn')
    INTO has_ogrn FROM document_types WHERE slug = 'customs_declaration';
  IF NOT has_ogrn THEN
    RAISE EXCEPTION 'seller.ogrn not added to customs_declaration schema';
  END IF;
END $$;

COMMIT;

-- Down Migration — убираем ogrn/kpp из seller/sender/recipient + промпт-хвост.
BEGIN;

UPDATE document_types
SET llm_schema = (llm_schema
    #- '{properties,seller,properties,ogrn}'
    #- '{properties,seller,properties,kpp}'
    #- '{properties,sender,properties,ogrn}'
    #- '{properties,sender,properties,kpp}'
    #- '{properties,recipient,properties,ogrn}'
    #- '{properties,recipient,properties,kpp}')
WHERE slug = 'customs_declaration';

-- Промпт-хвост откатываем regex-обрезкой по маркеру «ВАЖНО про идентификаторы».
UPDATE document_types
SET llm_prompt = regexp_replace(llm_prompt, E'\n\nВАЖНО про идентификаторы.*$', '', 'n')
WHERE slug = 'customs_declaration';

COMMIT;
