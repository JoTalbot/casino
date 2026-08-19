-- Турниры (T-055) — лидерборд по win за период
BEGIN;

CREATE TYPE tournament_status AS ENUM ('upcoming', 'active', 'finished');

CREATE TABLE tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status tournament_status NOT NULL DEFAULT 'upcoming',
    game_code TEXT NOT NULL DEFAULT 'crown-of-fortune',
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    prize_pool BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tournaments_dates CHECK (ends_at > starts_at)
);

CREATE TABLE tournament_scores (
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id),
    total_win BIGINT NOT NULL DEFAULT 0,
    total_bet BIGINT NOT NULL DEFAULT 0,
    rounds INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tournament_id, player_id)
);

CREATE INDEX tournament_scores_tournament_total_win_idx ON tournament_scores (tournament_id, total_win DESC);

-- Пример турнира для демо
INSERT INTO tournaments (code, title, description, status, game_code, starts_at, ends_at, prize_pool)
VALUES ('weekly-champions', 'Еженедельный чемпион', 'Топ по выигрышу за неделю, приз 50k CHIP', 'active', 'crown-of-fortune', now() - interval '1 day', now() + interval '6 days', 50000)
ON CONFLICT (code) DO NOTHING;

COMMIT;
