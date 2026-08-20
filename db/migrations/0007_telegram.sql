-- =============================================================================
-- Привязка игрока к Telegram (T-197)
--
-- Mini App отдаёт подписанный initData; сервер проверяет подпись ключом бота
-- и находит игрока по telegram_id. Без уникального индекса один аккаунт
-- Telegram мог бы наплодить сколько угодно игроков и обходить лимиты
-- ответственной игры.
-- =============================================================================

BEGIN;

ALTER TABLE players ADD COLUMN IF NOT EXISTS telegram_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS players_telegram_uidx
    ON players (telegram_id) WHERE telegram_id IS NOT NULL;

COMMENT ON COLUMN players.telegram_id IS
    'ID пользователя Telegram, подтверждённый подписью initData. NULL для гостей.';

COMMIT;
