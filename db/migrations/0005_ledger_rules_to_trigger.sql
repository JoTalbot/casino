-- =============================================================================
-- Неизменяемость ledger_entries: правила → триггеры (T-185)
--
-- Проблема, найденная при развёртывании на сервере:
-- PostgreSQL запрещает `INSERT ... ON CONFLICT` для таблиц, у которых есть
-- правила (RULE) на INSERT/UPDATE. В 0001_init.sql на ledger_entries висят
-- ledger_no_update и ledger_no_delete, поэтому КАЖДОЕ идемпотентное
-- начисление падало с ошибкой 0A000:
--   "INSERT with ON CONFLICT clause cannot be used with table that has
--    INSERT or UPDATE rules"
-- Ломались: ежедневный бонус, реферальные бонусы, награды за ачивки.
--
-- Решение: заменить правила триггерами. Триггер и защищает append-only,
-- и не мешает ON CONFLICT. Побочный плюс — правила молча проглатывали
-- UPDATE/DELETE, а триггер о них громко сообщает.
-- =============================================================================

BEGIN;

DROP RULE IF EXISTS ledger_no_update ON ledger_entries;
DROP RULE IF EXISTS ledger_no_delete ON ledger_entries;

CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger_entries — append-only журнал: операция % запрещена', TG_OP
        USING HINT = 'Исправление баланса оформляется новой проводкой tx_type = adjustment с указанием reason.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update_trg
    BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

CREATE TRIGGER ledger_entries_no_delete_trg
    BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

COMMENT ON FUNCTION ledger_entries_immutable() IS
    'Запрещает UPDATE/DELETE в журнале проводок. Заменила RULE-правила (T-185): правила несовместимы с ON CONFLICT.';

COMMIT;
