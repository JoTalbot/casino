-- =============================================================================
-- Промокоды на виртуальные фишки (T-213)
--
-- Механика намеренно строится так же, как понадобится при реальных деньгах:
-- лимит активаций, лимит на игрока, срок действия, идемпотентное начисление
-- через ledger и запись в аудит. Разница будет только в валюте.
--
-- ВАЖНО: это НЕ платёжный функционал. Промокод начисляет CHIP — виртуальные
-- фишки без денежной ценности, которые нельзя купить или вывести.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS promo_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Код хранится в верхнем регистре: игрок вводит как угодно,
    -- сравнение однозначное.
    code            TEXT UNIQUE NOT NULL CHECK (code = upper(code) AND length(code) BETWEEN 3 AND 32),
    chips           BIGINT NOT NULL CHECK (chips > 0),
    -- NULL = без ограничения
    max_activations INTEGER CHECK (max_activations IS NULL OR max_activations > 0),
    per_player      INTEGER NOT NULL DEFAULT 1 CHECK (per_player > 0),
    starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    comment         TEXT,
    created_by      TEXT NOT NULL DEFAULT 'admin',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT promo_dates CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_id     UUID NOT NULL REFERENCES promo_codes(id),
    player_id    UUID NOT NULL REFERENCES players(id),
    chips        BIGINT NOT NULL,
    redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promo_redemptions_promo_idx ON promo_redemptions (promo_id);
CREATE INDEX IF NOT EXISTS promo_redemptions_player_idx ON promo_redemptions (player_id);

COMMENT ON TABLE promo_codes IS
    'Промокоды на виртуальные фишки. Денежных операций не содержат.';

COMMIT;
