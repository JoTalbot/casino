BEGIN;

-- Рефералка (T-059)
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES players(id),
    referee_id UUID NOT NULL REFERENCES players(id),
    bonus_amount BIGINT NOT NULL DEFAULT 5000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (referee_id)
);

CREATE INDEX referrals_referrer_idx ON referrals (referrer_id);

-- Ачивки (T-060)
CREATE TYPE achievement_type AS ENUM ('first_win', 'big_win', 'hundred_spins', 'referral_master', 'tournament_winner');

CREATE TABLE IF NOT EXISTS achievements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code achievement_type UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reward BIGINT NOT NULL DEFAULT 0
);

INSERT INTO achievements (code, title, description, reward) VALUES
('first_win', 'Первая победа', 'Выиграй первый раунд', 100),
('big_win', 'Крупный выигрыш', 'Выиграй 100x ставки', 500),
('hundred_spins', 'Сотня спинов', 'Сыграй 100 раундов', 1000),
('referral_master', 'Мастер рефералов', 'Пригласи 5 друзей', 2500),
('tournament_winner', 'Чемпион турнира', 'Войди в топ-3 турнира', 5000)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_achievements (
    player_id UUID NOT NULL REFERENCES players(id),
    achievement_id UUID NOT NULL REFERENCES achievements(id),
    unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (player_id, achievement_id)
);

-- Чат простой (T-061)
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    player_id UUID NOT NULL REFERENCES players(id),
    username TEXT NOT NULL,
    message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_time_idx ON chat_messages (created_at DESC);

COMMIT;
