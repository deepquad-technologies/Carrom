-- Knockout tournaments. Prizes are virtual coins and cosmetics only.
CREATE TABLE IF NOT EXISTS tournaments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','registration','running','finished','cancelled')),
  -- Virtual coin entry per player and the virtual coin prize pool.
  entry_coins    BIGINT NOT NULL DEFAULT 0,
  prize_pool     BIGINT NOT NULL DEFAULT 0,
  prize_crate    TEXT CHECK (prize_crate IN ('rookie','champion','legendary')),
  max_players    INTEGER NOT NULL CHECK (max_players IN (4,8,16,32,64)),
  tier_id        TEXT NOT NULL,
  board_id       TEXT NOT NULL DEFAULT 'royal_gold',
  timer_preset   TEXT NOT NULL DEFAULT 'tournament',
  min_level      INTEGER NOT NULL DEFAULT 1,
  registration_opens_at TIMESTAMPTZ,
  starts_at      TIMESTAMPTZ NOT NULL,
  finished_at    TIMESTAMPTZ,
  winner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournaments_status_idx ON tournaments (status, starts_at);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seed          INTEGER,
  eliminated_in INTEGER,
  final_position INTEGER,
  points        INTEGER NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS tournament_players_user_idx ON tournament_players (user_id);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  player_a      UUID REFERENCES users(id) ON DELETE SET NULL,
  player_b      UUID REFERENCES users(id) ON DELETE SET NULL,
  winner_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  match_id      UUID REFERENCES matches(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','ready','running','finished','bye')),
  scheduled_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  UNIQUE (tournament_id, round, slot)
);
CREATE INDEX IF NOT EXISTS tournament_matches_bracket_idx
  ON tournament_matches (tournament_id, round, slot);
