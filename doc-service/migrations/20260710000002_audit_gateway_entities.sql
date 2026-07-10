-- Up Migration
--
-- P1 IA-пересборки: аудит на gateway-сущности.
--
-- Раньше audit_log.entity был ограничен CHECK'ом ('document_type',
-- 'provider_setting'), поэтому смена рубильника/лимита коннектора и бюджета
-- потребителя НЕ логировалась. На экране «Подключения» «История изменений»
-- карточки из-за этого была неполной (мы честно писали плашку об этом).
--
-- Расширяем CHECK, чтобы gateway-admin мог писать before/after при PATCH
-- коннектора и бюджета. Схема audit_log не меняется — только допустимые
-- значения entity. entity_id: для коннектора — slug, для бюджета —
-- '<consumer>::<connector>'.
--
-- Имя констрейнта — авто-сгенерированное Postgres для inline-CHECK на колонке
-- (`<table>_<column>_check`).

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_check
  CHECK (entity IN ('document_type', 'provider_setting', 'gateway_connector', 'gateway_budget'));

-- Down Migration
--
-- Возврат к строгому набору. Сначала удаляем строки новых сущностей, иначе
-- добавление узкого CHECK'а упадёт на уже записанных gateway-строках.

DELETE FROM audit_log WHERE entity IN ('gateway_connector', 'gateway_budget');
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_check
  CHECK (entity IN ('document_type', 'provider_setting'));
