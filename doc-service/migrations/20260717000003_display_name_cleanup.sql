-- Up Migration
--
-- Наведение порядка в display-именах типов (аудит 2026-07-17, sign-off владельца).
-- Принцип: русский термин ВЭД первым, англ/номер формы в скобках; убрать чистый
-- English; заострить счёт↔инвойс (в ВЭД «инвойс» — счёт за товар, по которому
-- едет груз). Меняются ТОЛЬКО display_name — slug/контракт/схемы не трогаем,
-- классификация не зависит от display. SLAI ярлыки синхронит у себя.

BEGIN;

-- 1. English → русский
UPDATE document_types SET display_name = 'Инвойс (ВЭД, закупка товара)' WHERE slug = 'commercial_invoice';
UPDATE document_types SET display_name = 'Упаковочный лист (Packing List)' WHERE slug = 'packing_list';
UPDATE document_types SET display_name = 'Расходная накладная (Delivery Note)' WHERE slug = 'delivery_note';

-- 2. Счёт ↔ инвойс
UPDATE document_types SET display_name = 'Счёт на оплату (внутренний РФ)' WHERE slug = 'invoice';
UPDATE document_types SET display_name = 'Проформа-инвойс (ВЭД)' WHERE slug = 'proforma_invoice';

-- 3. Три «накладные» — развести
UPDATE document_types SET display_name = 'Транспортная накладная (ТН, РФ)' WHERE slug = 'TTN';
UPDATE document_types SET display_name = 'Товарно-транспортная накладная (ТТН, 1-Т)' WHERE slug = 'transport_invoice';
UPDATE document_types SET display_name = 'CMR (Международная накладная)' WHERE slug = 'CMR';

-- Мелочь: OCR-мусор в имени
UPDATE document_types SET display_name = 'Акцизный e-AD' WHERE slug = 'excise_ead';

COMMIT;

-- Down Migration
BEGIN;
UPDATE document_types SET display_name = 'Commercial Invoice' WHERE slug = 'commercial_invoice';
UPDATE document_types SET display_name = 'Packing List' WHERE slug = 'packing_list';
UPDATE document_types SET display_name = 'Расходная накладная / Delivery Note' WHERE slug = 'delivery_note';
UPDATE document_types SET display_name = 'Счёт на оплату' WHERE slug = 'invoice';
UPDATE document_types SET display_name = 'Инвойс-проформа' WHERE slug = 'proforma_invoice';
UPDATE document_types SET display_name = 'Транспортная накладная' WHERE slug = 'TTN';
UPDATE document_types SET display_name = 'Транспортная накладная (форма 2013)' WHERE slug = 'transport_invoice';
UPDATE document_types SET display_name = 'CMR (международная накладная)' WHERE slug = 'CMR';
UPDATE document_types SET display_name = 'Акцизный e-AD (АКЦИЗЕ ПРЕЦЕС)' WHERE slug = 'excise_ead';
COMMIT;
