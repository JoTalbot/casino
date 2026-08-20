BEGIN;

-- Push-подписки (T-178).
-- До этой миграции подписки жили в памяти процесса: рестарт API — и все
-- подписки терялись, а при нескольких инстансах уведомления уходили
-- только с того узла, который принял запрос.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id   UUID NOT NULL REFERENCES players(id),
    endpoint    TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_player_idx
    ON push_subscriptions (player_id) WHERE revoked_at IS NULL;

COMMIT;
