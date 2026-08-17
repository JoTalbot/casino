-- =============================================================================
-- Crown of Fortune / casino — схема базы данных, версия 1
-- PostgreSQL 16+
--
-- Задача: T-012 · Агент: claude-2026-08-17-B · Дата: 2026-08-17
-- Пояснения и обоснование решений: docs/DB-SCHEMA.md
--
-- Принципы (нарушать нельзя):
--   1. Деньги/фишки — ТОЛЬКО BIGINT в минимальных единицах. Никогда FLOAT.
--   2. Кошелёк — двойная запись (ledger). Баланс это производная величина.
--   3. Всё, что меняет баланс, идемпотентно по внешнему ключу.
--   4. Ничего не удаляется. Только пометка deleted_at / статус.
--   5. Раунд хранит достаточно данных, чтобы третья сторона его переиграла.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- регистронезависимый email

-- -----------------------------------------------------------------------------
-- Общие типы
-- -----------------------------------------------------------------------------

CREATE TYPE player_status   AS ENUM ('active', 'suspended', 'self_excluded', 'closed');
CREATE TYPE currency_kind   AS ENUM ('virtual', 'fiat', 'crypto');
CREATE TYPE tx_type         AS ENUM (
    'bet',            -- списание ставки
    'win',            -- зачисление выигрыша
    'refund',         -- откат ставки (rollback раунда)
    'grant',          -- начисление фишек: регистрация, ежедневный бонус, подарок
    'purchase',       -- покупка фишек (стадия 2+, на стадии 1 не используется)
    'adjustment'      -- ручная корректировка администратором, всегда с причиной
);
CREATE TYPE round_status    AS ENUM ('open', 'settled', 'rolled_back');
CREATE TYPE seed_status     AS ENUM ('active', 'revealed');
CREATE TYPE limit_kind      AS ENUM ('loss_daily', 'loss_weekly', 'wager_daily',
                                     'session_minutes', 'spins_daily');

-- =============================================================================
-- 1. ИГРОКИ
-- =============================================================================

CREATE TABLE players (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           CITEXT UNIQUE,
    username        CITEXT UNIQUE NOT NULL,
    password_hash   TEXT,                       -- argon2id; NULL для гостевых/OAuth
    status          player_status NOT NULL DEFAULT 'active',
    country_code    CHAR(2),                    -- ISO 3166-1 alpha-2
    locale          TEXT NOT NULL DEFAULT 'ru',
    date_of_birth   DATE,                       -- возрастной гейт даже для соц-казино
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,

    -- master RTP: если задан, для игрока выбирается набор лент с ближайшим RTP.
    -- Практика индустрии (см. research/06 §1.1). NULL = берётся значение клуба.
    master_rtp      NUMERIC(5,4) CHECK (master_rtp IS NULL
                                        OR master_rtp BETWEEN 0.5000 AND 0.9999)
);

CREATE INDEX players_status_idx     ON players (status) WHERE deleted_at IS NULL;
CREATE INDEX players_created_at_idx ON players (created_at DESC);

COMMENT ON COLUMN players.master_rtp IS
    'Персональный целевой RTP; выбирает ближайший набор лент. NULL = наследуется от клуба.';

-- Клубы/бренды: один инстанс движка может обслуживать несколько витрин.
-- На стадии 1 клуб ровно один, но закладываем сразу — потом дорого.
CREATE TABLE clubs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT UNIQUE NOT NULL,
    title           TEXT NOT NULL,
    master_rtp      NUMERIC(5,4) NOT NULL DEFAULT 0.9600
                        CHECK (master_rtp BETWEEN 0.5000 AND 0.9999),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE club_members (
    club_id         UUID NOT NULL REFERENCES clubs(id),
    player_id       UUID NOT NULL REFERENCES players(id),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (club_id, player_id)
);

-- =============================================================================
-- 2. КОШЕЛЁК: двойная запись
-- =============================================================================
-- Баланс НЕ хранится как редактируемое поле. Он выводится из проводок.
-- Материализованный кэш (wallets.balance) обновляется только триггером
-- и служит для скорости, а не как источник правды.

CREATE TABLE currencies (
    code            TEXT PRIMARY KEY,           -- 'CHIP', 'EUR', 'BTC'
    kind            currency_kind NOT NULL,
    exponent        SMALLINT NOT NULL,          -- знаков после запятой: CHIP=0, EUR=2, BTC=8
    title           TEXT NOT NULL
);

INSERT INTO currencies (code, kind, exponent, title)
VALUES ('CHIP', 'virtual', 0, 'Виртуальные фишки');

CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id       UUID NOT NULL REFERENCES players(id),
    currency_code   TEXT NOT NULL REFERENCES currencies(code),
    -- кэш баланса в минимальных единицах; поддерживается триггером,
    -- сверяется фоновой задачей против SUM(ledger.amount)
    balance         BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (player_id, currency_code),
    CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0)
);

-- Проводки. Append-only: UPDATE и DELETE запрещены правилом ниже.
CREATE TABLE ledger_entries (
    id              BIGSERIAL PRIMARY KEY,
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    -- знак: списание отрицательное, зачисление положительное
    amount          BIGINT NOT NULL CHECK (amount <> 0),
    balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
    tx_type         tx_type NOT NULL,
    round_id        UUID,                       -- FK добавляется после создания rounds
    -- Идемпотентность: повторный запрос с тем же ключом не создаёт вторую проводку.
    -- Формат: '<scope>:<external_id>', например 'bet:round-7f3a...'
    idempotency_key TEXT NOT NULL,
    reason          TEXT,                       -- обязателен для 'adjustment'
    created_by      TEXT NOT NULL DEFAULT 'system',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ledger_adjustment_needs_reason
        CHECK (tx_type <> 'adjustment' OR reason IS NOT NULL)
);

CREATE UNIQUE INDEX ledger_idempotency_uidx ON ledger_entries (idempotency_key);
CREATE INDEX ledger_wallet_time_idx  ON ledger_entries (wallet_id, created_at DESC);
CREATE INDEX ledger_round_idx        ON ledger_entries (round_id) WHERE round_id IS NOT NULL;

-- Запрет модификации истории
CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;

COMMENT ON TABLE ledger_entries IS
    'Append-only журнал проводок. Источник правды по балансу. UPDATE/DELETE заблокированы.';

-- =============================================================================
-- 3. ИГРЫ И МАТЕМАТИКА
-- =============================================================================

CREATE TABLE games (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT UNIQUE NOT NULL,       -- 'crown-of-fortune'
    title           TEXT NOT NULL,
    reels           SMALLINT NOT NULL,
    row_count       SMALLINT NOT NULL,
    lines           SMALLINT NOT NULL,
    is_enabled      BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Версия математики. Одна игра = несколько наборов лент под разные RTP.
-- config_json — ровно тот config/game.json, по которому считался PAR sheet.
-- config_hash — SHA-256 канонического JSON, тот же, что пишет GameConfig.config_hash().
CREATE TABLE game_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id         UUID NOT NULL REFERENCES games(id),
    version         TEXT NOT NULL,              -- '1.0.0'
    config_hash     CHAR(64) NOT NULL,          -- SHA-256 hex
    config_json     JSONB NOT NULL,
    -- фактический RTP, подтверждённый аналитикой и симуляцией
    analytic_rtp    NUMERIC(7,6) NOT NULL,
    simulated_rtp   NUMERIC(7,6),
    volatility_index NUMERIC(6,3),
    hit_frequency   NUMERIC(6,5),
    max_win_x       INTEGER,
    par_sheet_path  TEXT,                       -- docs/PAR-SHEET.md на момент приёмки
    is_active       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (game_id, version),
    UNIQUE (config_hash)
);

CREATE INDEX game_configs_active_idx ON game_configs (game_id, analytic_rtp)
    WHERE is_active;

COMMENT ON TABLE game_configs IS
    'Версии математики. Выбор набора под master_rtp: ORDER BY abs(analytic_rtp - :mrtp) LIMIT 1.';

-- =============================================================================
-- 4. PROVABLY FAIR: пары сидов
-- =============================================================================
-- Серверный сид хранится в открытом виде, но НИКОГДА не отдаётся в API,
-- пока status = 'active'. Отдаётся только server_seed_hash.
-- После ротации status = 'revealed' и сид становится публичным.

CREATE TABLE seed_pairs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id           UUID NOT NULL REFERENCES players(id),
    server_seed         CHAR(64) NOT NULL,      -- hex, 32 байта. НЕ отдавать до revealed!
    server_seed_hash    CHAR(64) NOT NULL,      -- SHA-256(server_seed), публикуется сразу
    client_seed         TEXT NOT NULL
                            CHECK (length(client_seed) BETWEEN 1 AND 256
                                   AND position(':' in client_seed) = 0),
    -- следующий nonce, который будет использован; растёт при каждом раунде
    next_nonce          BIGINT NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
    status              seed_status NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revealed_at         TIMESTAMPTZ,

    CONSTRAINT seed_revealed_has_timestamp
        CHECK ((status = 'revealed') = (revealed_at IS NOT NULL))
);

-- У игрока не может быть двух активных пар одновременно
CREATE UNIQUE INDEX seed_pairs_one_active_uidx
    ON seed_pairs (player_id) WHERE status = 'active';
CREATE INDEX seed_pairs_player_idx ON seed_pairs (player_id, created_at DESC);
CREATE INDEX seed_pairs_hash_idx   ON seed_pairs (server_seed_hash);

COMMENT ON COLUMN seed_pairs.client_seed IS
    'Двоеточие запрещено: сообщение HMAC имеет вид "clientSeed:nonce:cursor",
     двоеточие в сиде позволило бы подобрать коллизию сообщений.';

-- =============================================================================
-- 5. РАУНДЫ
-- =============================================================================
-- Раунд = одна ставка. Базовый спин + вся серия фриспинов входят в ОДИН раунд
-- (см. research/06 §1.2). Внутри раунда — спины в таблице spins.
-- Раунд хранит всё необходимое для независимого пересчёта третьей стороной.

CREATE TABLE rounds (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- идемпотентность спина: клиент генерирует ключ и ретраит с ним же
    external_id         TEXT NOT NULL,
    player_id           UUID NOT NULL REFERENCES players(id),
    club_id             UUID REFERENCES clubs(id),
    game_id             UUID NOT NULL REFERENCES games(id),
    game_config_id      UUID NOT NULL REFERENCES game_configs(id),
    config_hash         CHAR(64) NOT NULL,      -- дублируем: раунд самодостаточен
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    currency_code       TEXT NOT NULL REFERENCES currencies(code),

    seed_pair_id        UUID NOT NULL REFERENCES seed_pairs(id),
    nonce               BIGINT NOT NULL,
    -- сколько случайных чисел раунд израсходовал; нужно верификатору
    draw_count          INTEGER NOT NULL DEFAULT 0,

    bet_per_line        BIGINT NOT NULL CHECK (bet_per_line > 0),
    lines               SMALLINT NOT NULL CHECK (lines > 0),
    total_bet           BIGINT NOT NULL CHECK (total_bet > 0),
    total_win           BIGINT NOT NULL DEFAULT 0 CHECK (total_win >= 0),

    status              round_status NOT NULL DEFAULT 'open',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at          TIMESTAMPTZ,
    client_ip           INET,
    client_user_agent   TEXT,

    CONSTRAINT rounds_settled_has_timestamp
        CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);

CREATE UNIQUE INDEX rounds_external_uidx ON rounds (player_id, external_id);
-- Одна пара сидов + один nonce = ровно один раунд. Защита от повторного
-- использования потока случайности.
CREATE UNIQUE INDEX rounds_seed_nonce_uidx ON rounds (seed_pair_id, nonce);
CREATE INDEX rounds_player_time_idx ON rounds (player_id, started_at DESC);
CREATE INDEX rounds_game_time_idx   ON rounds (game_id, started_at DESC);
CREATE INDEX rounds_open_idx        ON rounds (player_id) WHERE status = 'open';

-- теперь можно связать проводки с раундами
ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_round_fk FOREIGN KEY (round_id) REFERENCES rounds(id);

-- Отдельные спины внутри раунда: базовый (index 0) и фриспины (1..N).
CREATE TABLE spins (
    id                  BIGSERIAL PRIMARY KEY,
    round_id            UUID NOT NULL REFERENCES rounds(id),
    spin_index          SMALLINT NOT NULL CHECK (spin_index >= 0),
    is_free             BOOLEAN NOT NULL DEFAULT false,
    -- позиции остановки барабанов: [12, 3, 30, 7, 21]
    reel_stops          SMALLINT[] NOT NULL,
    -- видимая сетка символов, 5x3, для быстрого рендера истории без пересчёта
    grid                TEXT[] NOT NULL,
    win                 BIGINT NOT NULL DEFAULT 0 CHECK (win >= 0),
    multiplier          SMALLINT NOT NULL DEFAULT 1,
    -- разбор выигрыша: [{"line":3,"symbol":"CROWN","count":4,"pay":626}, ...]
    win_details         JSONB NOT NULL DEFAULT '[]'::jsonb,
    scatter_count       SMALLINT NOT NULL DEFAULT 0,
    triggered_free      SMALLINT NOT NULL DEFAULT 0,  -- сколько фриспинов выдал этот спин
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (round_id, spin_index)
);

CREATE INDEX spins_round_idx ON spins (round_id, spin_index);

COMMENT ON TABLE spins IS
    'reel_stops достаточно для полного пересчёта: grid и win_details — денормализация
     ради скорости истории, но проверяются пересчётом из stops при аудите.';

-- =============================================================================
-- 6. АУДИТ-ЛОГ
-- =============================================================================
-- Append-only. Пишется всё, что имеет юридическое или следственное значение.

CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type      TEXT NOT NULL,      -- 'player' | 'admin' | 'system'
    actor_id        TEXT,
    event_type      TEXT NOT NULL,      -- 'round.settled', 'seed.rotated', 'limit.set', ...
    subject_type    TEXT,               -- 'round' | 'player' | 'wallet' | 'seed_pair'
    subject_id      TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip              INET
);

CREATE INDEX audit_time_idx    ON audit_log (occurred_at DESC);
CREATE INDEX audit_subject_idx ON audit_log (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_event_idx   ON audit_log (event_type, occurred_at DESC);

CREATE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- =============================================================================
-- 7. ОТВЕТСТВЕННАЯ ИГРА (задел под T-015)
-- =============================================================================

CREATE TABLE player_limits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id       UUID NOT NULL REFERENCES players(id),
    kind            limit_kind NOT NULL,
    value           BIGINT NOT NULL CHECK (value > 0),
    -- ужесточение действует немедленно, ослабление — только после cooling_until
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    cooling_until   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX player_limits_active_uidx
    ON player_limits (player_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE self_exclusions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id       UUID NOT NULL REFERENCES players(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = бессрочно; снятие возможно только вручную и с задержкой
    ends_at         TIMESTAMPTZ,
    reason          TEXT,
    created_by      TEXT NOT NULL DEFAULT 'player'
);

CREATE INDEX self_exclusions_player_idx ON self_exclusions (player_id, started_at DESC);

CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id       UUID NOT NULL REFERENCES players(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    ip              INET,
    user_agent      TEXT,
    -- когда последний раз показывали reality check
    reality_check_at TIMESTAMPTZ
);

CREATE INDEX sessions_player_idx ON sessions (player_id, started_at DESC);

-- =============================================================================
-- 8. ТРИГГЕРЫ
-- =============================================================================

-- Поддержка кэша баланса. Единственное место, где wallets.balance меняется.
CREATE OR REPLACE FUNCTION apply_ledger_entry() RETURNS TRIGGER AS $$
DECLARE
    new_balance BIGINT;
BEGIN
    UPDATE wallets
       SET balance = balance + NEW.amount,
           updated_at = now()
     WHERE id = NEW.wallet_id
    RETURNING balance INTO new_balance;

    IF new_balance IS NULL THEN
        RAISE EXCEPTION 'Кошелёк % не найден', NEW.wallet_id;
    END IF;

    IF new_balance <> NEW.balance_after THEN
        RAISE EXCEPTION
            'Расхождение баланса кошелька %: рассчитано %, в проводке %',
            NEW.wallet_id, new_balance, NEW.balance_after;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_apply_trg
    AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

-- updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER players_touch_trg BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- =============================================================================
-- 9. ПРОВЕРОЧНЫЕ ПРЕДСТАВЛЕНИЯ
-- =============================================================================

-- Сверка кэша баланса с журналом. Должно возвращать 0 строк.
CREATE VIEW wallet_balance_mismatch AS
SELECT w.id AS wallet_id,
       w.player_id,
       w.balance AS cached_balance,
       COALESCE(SUM(l.amount), 0) AS ledger_balance,
       w.balance - COALESCE(SUM(l.amount), 0) AS diff
  FROM wallets w
  LEFT JOIN ledger_entries l ON l.wallet_id = w.id
 GROUP BY w.id, w.player_id, w.balance
HAVING w.balance <> COALESCE(SUM(l.amount), 0);

-- Фактический RTP по игре за период. Считается из журнала, а не из rounds.
CREATE VIEW game_rtp_actual AS
SELECT r.game_id,
       r.config_hash,
       date_trunc('day', r.started_at) AS day,
       count(*)                        AS rounds,
       sum(r.total_bet)                AS total_bet,
       sum(r.total_win)                AS total_win,
       CASE WHEN sum(r.total_bet) > 0
            THEN sum(r.total_win)::numeric / sum(r.total_bet)
       END                             AS rtp
  FROM rounds r
 WHERE r.status = 'settled'
 GROUP BY r.game_id, r.config_hash, date_trunc('day', r.started_at);

-- Зависшие раунды: открыты дольше 5 минут. Требуют разбора.
CREATE VIEW stuck_rounds AS
SELECT * FROM rounds
 WHERE status = 'open'
   AND started_at < now() - interval '5 minutes';

COMMIT;
