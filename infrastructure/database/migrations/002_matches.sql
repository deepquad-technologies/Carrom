-- Matches, seats, the per-shot event log and final results.
CREATE TABLE IF NOT EXISTS matches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode_id       TEXT NOT NULL,
  tier_id       TEXT NOT NULL,
  board_id      TEXT NOT NULL,
  table_size    TEXT NOT NULL CHECK (table_size IN ('2p','4p')),
  room_code     TEXT,
  is_private    BOOLEAN NOT NULL DEFAULT FALSE,
  is_ranked     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Virtual coin entry per seat and the resulting pot.
  entry_coins   BIGINT NOT NULL DEFAULT 0,
  pot_coins     BIGINT NOT NULL DEFAULT 0,
  turn_seconds  INTEGER NOT NULL DEFAULT 60,
  status        TEXT NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting','playing','finished','cancelled')),
  winner_color  TEXT CHECK (winner_color IN ('white','black')),
  end_reason    TEXT CHECK (end_reason IN ('complete','forfeit','abandoned','cancelled','decision')),
  points        INTEGER NOT NULL DEFAULT 0,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches (status);
CREATE INDEX IF NOT EXISTS matches_created_idx ON matches (created_at DESC);
CREATE INDEX IF NOT EXISTS matches_room_code_idx ON matches (room_code) WHERE room_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS match_players (
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat            SMALLINT NOT NULL,
  color           TEXT NOT NULL CHECK (color IN ('white','black')),
  striker_skin    TEXT NOT NULL,
  coin_skin       TEXT NOT NULL,
  level_before    INTEGER NOT NULL DEFAULT 1,
  trophies_before INTEGER NOT NULL DEFAULT 0,
  balance_before  BIGINT NOT NULL DEFAULT 0,
  pocketed        INTEGER NOT NULL DEFAULT 0,
  fouls           INTEGER NOT NULL DEFAULT 0,
  won             BOOLEAN,
  left_early      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id, match_id);

-- Every shot, kept for replay, dispute review and cheat analysis.
CREATE TABLE IF NOT EXISTS match_events (
  id           BIGSERIAL PRIMARY KEY,
  match_id     UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  seat         SMALLINT,
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Milliseconds the player took to act; used to spot automation.
  think_ms     INTEGER,
  UNIQUE (match_id, seq)
);
CREATE INDEX IF NOT EXISTS match_events_match_idx ON match_events (match_id, seq);
CREATE INDEX IF NOT EXISTS match_events_kind_idx ON match_events (kind);

CREATE TABLE IF NOT EXISTS match_results (
  match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  won            BOOLEAN NOT NULL,
  coins_delta    BIGINT NOT NULL DEFAULT 0,
  xp_gained      INTEGER NOT NULL DEFAULT 0,
  trophies_delta INTEGER NOT NULL DEFAULT 0,
  level_before   INTEGER NOT NULL,
  level_after    INTEGER NOT NULL,
  crate_id       UUID,
  streak_after   INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_results_user_idx ON match_results (user_id, created_at DESC);

-- Elo-style rating, tracked separately from displayed trophies.
CREATE TABLE IF NOT EXISTS ratings (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL DEFAULT 1200,
  deviation   INTEGER NOT NULL DEFAULT 350,
  games       INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ratings_rating_idx ON ratings (rating DESC);
