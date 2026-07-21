-- Up Migration
--
-- Сверка каталога 2026-07-21: llm_prompt коносамента в БД перечислял поля
-- СТАРОЙ номенклатурой (bl_number, vessel_name, voyage_number, container_number/
-- seal_number/packages/weight_gross/measurement, total_packages, total_weight_gross),
-- которой в боевой схеме нет — фактические имена диктует BL_SCHEMA из кода
-- (document-json-schemas.ts, EXTENDED_SCHEMAS-fallback при llm_schema=NULL):
-- number, vessel{name,voyage,imo}, containers[]{number,seal,type,tare_kg,
-- gross_weight_kg}, cargo{...}. Модель получала противоречие «промпт vs схема»
-- (схема побеждала, но это лишний шум). Переписываем перечень полей под схему,
-- тюнинг-инструкции 20260629000001/2 (ISO alpha-2, числа-не-строки,
-- shipped_on_board, carrier-в-подписи, service_name) сохранены дословно.
--
-- Деплой: migrate + restart api/worker (сброс кэша резолвера конфигов типов).

BEGIN;

UPDATE document_types
SET llm_prompt = 'Извлеки из коносамента (Bill of Lading): number (номер B/L), bl_type (Master/House/Sea Waybill), date (YYYY-MM-DD), carrier, scac_code, service_name, vessel (name/voyage/imo), port_of_loading, port_of_discharge, place_of_receipt, place_of_delivery, freight_terms (PREPAID/COLLECT/PAYABLE_AT_DESTINATION), incoterm, booking_number, shipper / consignee / notify_party (name/inn/kpp/address и прочие реквизиты, если указаны), containers (массив: number/seal/type/tare_kg/gross_weight_kg), cargo (description/gross_weight_kg/volume_m3/packages_count/package_type), shipped_on_board, place_of_issue, date_of_issue, number_of_original_bls, master_bl_number (только если это House B/L под мастером), release_type (только при явном маркере), document_stage, transport_docs, order_refs.

ВАЖНО: country везде в формате ISO 3166 alpha-2 (CN, RU, US, DE, TR — без слова "China"/"Russia"). Если в документе написано "China" — преобразуй в "CN".

Числовые поля (tare_kg/gross_weight_kg/volume_m3/packages_count) — числа, не строки. Десятичные с точкой, не запятой. shipped_on_board — дата «Shipped on Board» (фактическая погрузка на судно), отдельно от date, формат YYYY-MM-DD. place_of_issue / date_of_issue — место и дата выдачи коносамента. carrier — название морской линии/перевозчика (Maersk, MSC, COSCO, ...), НЕ экспедитора и НЕ грузоотправителя. carrier — морская линия/океанский перевозчик; часто указан ВНИЗУ в подписи «on behalf of the Ocean Carrier, X» (напр. FESCO INTEGRATED TRANSPORT), НЕ shipper и НЕ экспедитор. service_name — название сервиса/линии, если есть (напр. «Fesco China Direct Line»).',
    updated_at = now()
WHERE slug = 'bill_of_lading';

COMMIT;
