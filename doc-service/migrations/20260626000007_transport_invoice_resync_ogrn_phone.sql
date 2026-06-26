-- Up Migration
--
-- Ресинк схемы 2026-06-26 (extraction-gap аудит): код (TRANSPORT_INVOICE_SCHEMA /
-- EXTENDED_SCHEMAS в src/types/document-json-schemas.ts) собирает все party-объекты
-- из общего PARTY, который несёт `ogrn` (EXT-LINE-3, SLAI 2026-06-03) и `phone`
-- (F19). А DB-копия llm_schema для transport_invoice ОТСТАЛА: на party-объектах
-- (shipper/consignee/carrier/payer/forwarder) этих ключей нет — миграции 0522/0608
-- их не донесли, поэтому ogrn/phone у контрагентов ТН по факту никогда не
-- извлекались (модель видит DB-схему, а не код). SLAI matcher дозаполняет
-- реквизиты контрагента по ОГРН — без него matching молча промахивается.
--
-- Фикс: аддитивно добавить `ogrn` (string, 13 цифр ЮЛ / 15 ИП) и `phone` (string)
-- в КАЖДЫЙ существующий party.properties. driver — не party (объект-персона:
-- fio/license/phone, без inn/name; phone у него уже есть) → НЕ трогаем.
-- forwarder/payer/carrier/shipper/consignee — настоящие party (из PARTY).
--
-- Аддитивность: NEW || EXISTING — при конфликте ключа побеждает EXISTING,
-- ни один существующий ключ не дропается и не перезаписывается.

BEGIN;

-- shipper
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,shipper,properties}',
         '{"ogrn":{"type":"string","description":"ОГРН организации (13 цифр для ЮЛ, 15 для ИП)"},"phone":{"type":"string","description":"Контактный телефон в формате +7XXXXXXXXXX"}}'::jsonb
           || (llm_schema#>'{properties,shipper,properties}')
       )
 WHERE slug = 'transport_invoice'
   AND llm_schema#>'{properties,shipper,properties}' IS NOT NULL;

-- consignee
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,consignee,properties}',
         '{"ogrn":{"type":"string","description":"ОГРН организации (13 цифр для ЮЛ, 15 для ИП)"},"phone":{"type":"string","description":"Контактный телефон в формате +7XXXXXXXXXX"}}'::jsonb
           || (llm_schema#>'{properties,consignee,properties}')
       )
 WHERE slug = 'transport_invoice'
   AND llm_schema#>'{properties,consignee,properties}' IS NOT NULL;

-- carrier
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,carrier,properties}',
         '{"ogrn":{"type":"string","description":"ОГРН организации (13 цифр для ЮЛ, 15 для ИП)"},"phone":{"type":"string","description":"Контактный телефон в формате +7XXXXXXXXXX"}}'::jsonb
           || (llm_schema#>'{properties,carrier,properties}')
       )
 WHERE slug = 'transport_invoice'
   AND llm_schema#>'{properties,carrier,properties}' IS NOT NULL;

-- payer
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,payer,properties}',
         '{"ogrn":{"type":"string","description":"ОГРН организации (13 цифр для ЮЛ, 15 для ИП)"},"phone":{"type":"string","description":"Контактный телефон в формате +7XXXXXXXXXX"}}'::jsonb
           || (llm_schema#>'{properties,payer,properties}')
       )
 WHERE slug = 'transport_invoice'
   AND llm_schema#>'{properties,payer,properties}' IS NOT NULL;

-- forwarder
UPDATE document_types
   SET llm_schema = jsonb_set(
         llm_schema,
         '{properties,forwarder,properties}',
         '{"ogrn":{"type":"string","description":"ОГРН организации (13 цифр для ЮЛ, 15 для ИП)"},"phone":{"type":"string","description":"Контактный телефон в формате +7XXXXXXXXXX"}}'::jsonb
           || (llm_schema#>'{properties,forwarder,properties}')
       )
 WHERE slug = 'transport_invoice'
   AND llm_schema#>'{properties,forwarder,properties}' IS NOT NULL;

DO $$
DECLARE missing text;
BEGIN
  -- Каждый присутствующий party-объект обязан получить ogrn И phone.
  SELECT string_agg(party, ', ') INTO missing
    FROM (
      SELECT p AS party
        FROM document_types dt,
             unnest(ARRAY['shipper','consignee','carrier','payer','forwarder']) AS p
       WHERE dt.slug = 'transport_invoice'
         AND dt.llm_schema #> ARRAY['properties', p, 'properties'] IS NOT NULL
         AND NOT (
               (dt.llm_schema #> ARRAY['properties', p, 'properties']) ? 'ogrn'
           AND (dt.llm_schema #> ARRAY['properties', p, 'properties']) ? 'phone'
         )
    ) q;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'transport_invoice party objects missing ogrn/phone after update: %', missing;
  END IF;
END $$;

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types
   SET llm_schema = jsonb_set(llm_schema, '{properties,shipper,properties}',
         (llm_schema#>'{properties,shipper,properties}') #- '{ogrn}' #- '{phone}')
 WHERE slug = 'transport_invoice' AND llm_schema#>'{properties,shipper,properties}' IS NOT NULL;
UPDATE document_types
   SET llm_schema = jsonb_set(llm_schema, '{properties,consignee,properties}',
         (llm_schema#>'{properties,consignee,properties}') #- '{ogrn}' #- '{phone}')
 WHERE slug = 'transport_invoice' AND llm_schema#>'{properties,consignee,properties}' IS NOT NULL;
UPDATE document_types
   SET llm_schema = jsonb_set(llm_schema, '{properties,carrier,properties}',
         (llm_schema#>'{properties,carrier,properties}') #- '{ogrn}' #- '{phone}')
 WHERE slug = 'transport_invoice' AND llm_schema#>'{properties,carrier,properties}' IS NOT NULL;
UPDATE document_types
   SET llm_schema = jsonb_set(llm_schema, '{properties,payer,properties}',
         (llm_schema#>'{properties,payer,properties}') #- '{ogrn}' #- '{phone}')
 WHERE slug = 'transport_invoice' AND llm_schema#>'{properties,payer,properties}' IS NOT NULL;
UPDATE document_types
   SET llm_schema = jsonb_set(llm_schema, '{properties,forwarder,properties}',
         (llm_schema#>'{properties,forwarder,properties}') #- '{ogrn}' #- '{phone}')
 WHERE slug = 'transport_invoice' AND llm_schema#>'{properties,forwarder,properties}' IS NOT NULL;
COMMIT;
