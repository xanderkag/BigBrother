-- Up Migration
--
-- document_types.tier — уровень зрелости типа документа.
-- Информационное поле для UI и SLAI-интегратора: предупреждать, что
-- experimental-тип может вести себя нестабильно, beta — обкатан на
-- проде но без замера на golden-set'е, stable — типизированная Zod
-- схема + regex parser + ≥90% accuracy на golden-set.
--
-- 6 builtin'ов (invoice/factInvoice/UPD/TTN/CMR/AKT) → stable.
-- Хорошо обкатанные кастомные типы (заведены давно, есть keywords +
-- validators) → beta. Остальные — experimental (default).
--
-- Runtime НЕ принимает решений на основе tier'а; resolver просто
-- пробрасывает значение в ResolvedTypeConfig, UI/логи показывают
-- бейдж.
--
-- Имя миграции отличается от первоначально планировавшегося
-- 20260524000021_document_types_tier.sql — этот слот был уже занят
-- (classifier_fixes_slai_eod). Берём следующую свободную дату.

BEGIN;

ALTER TABLE document_types
  ADD COLUMN tier TEXT NOT NULL DEFAULT 'experimental'
    CHECK (tier IN ('stable', 'beta', 'experimental'));

CREATE INDEX idx_document_types_tier ON document_types (tier);

-- Seed: 6 builtins → stable
UPDATE document_types SET tier = 'stable'
  WHERE slug IN ('invoice', 'factInvoice', 'UPD', 'TTN', 'CMR', 'AKT');

-- Seed: well-established custom types → beta
-- (есть keywords, validators, и долго в проде).
UPDATE document_types SET tier = 'beta'
  WHERE slug IN (
    'payment_order',
    'commercial_invoice',
    'packing_list',
    'cert_of_origin',
    'customs_declaration',
    'eac_conformity_certificate',
    'proforma_invoice',
    'price_list',
    'wire_transfer_application',
    'contract',
    'contract_addendum',
    'contract_specification',
    'bill_of_lading',
    'cash_receipt',
    'transfer_note',
    'weighing_act'
  );

-- Остаются experimental: transport_request, transport_invoice, waybill
-- (добавлены 2026-05-17, нет accumulated данных).

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_document_types_tier;
ALTER TABLE document_types DROP COLUMN IF EXISTS tier;

COMMIT;
