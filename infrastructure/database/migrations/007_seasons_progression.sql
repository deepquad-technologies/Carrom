-- Seasons, ranked divisions, login rewards, fair play, follows and presence.

/* --------------------------------- seasons -------------------------------- */

CREATE TABLE IF NOT EXISTS seasons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number        INTEGER NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  theme_id      TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'upcoming'
                CHECK (status IN ('upcoming','active','frozen','settled')),
  -- Snapshot of the reward table used when this season settled.
  reward_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  settled_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS seasons_status_idx ON seasons (status, starts_at DESC);
-- Only one season may be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS seasons_one_active
  ON seasons ((status = 'active')) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS season_players (
  season_id      UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL DEFAULT 0,
  peak_rating    INTEGER NOT NULL DEFAULT 0,
  division       TEXT NOT NULL DEFAULT 'bronze',
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  xp             BIGINT NOT NULL DEFAULT 0,
  final_position INTEGER,
  rewarded_at    TIMESTAMPTZ,
  PRIMARY KEY (season_id, user_id)
);
CREATE INDEX IF NOT EXISTS season_players_board_idx
  ON season_players (season_id, rating DESC);

/* ----------------------------- daily login rewards ------------------------ */

CREATE TABLE IF NOT EXISTS login_streaks (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Which day of the 7-day cycle they will claim next, 1-7.
  cycle_day      SMALLINT NOT NULL DEFAULT 1 CHECK (cycle_day BETWEEN 1 AND 7),
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  -- UTC date of the last claim, so a claim is once per calendar day.
  last_claim_on  DATE,
  cycles_done    INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_claims (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_on    DATE NOT NULL,
  cycle_day   SMALLINT NOT NULL,
  reward      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One claim per player per day, enforced by the database.
  UNIQUE (user_id, claim_on)
);

/* -------------------------------- fair play ------------------------------- */

CREATE TABLE IF NOT EXISTS fair_play (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 0-100. Starts at 100 and is recomputed from behaviour.
  score              SMALLINT NOT NULL DEFAULT 100 CHECK (score BETWEEN 0 AND 100),
  abandons           INTEGER NOT NULL DEFAULT 0,
  disconnects        INTEGER NOT NULL DEFAULT 0,
  upheld_reports     INTEGER NOT NULL DEFAULT 0,
  confirmed_cheating INTEGER NOT NULL DEFAULT 0,
  clean_matches      INTEGER NOT NULL DEFAULT 0,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fair_play_score_idx ON fair_play (score);

/* -------------------------------- follows --------------------------------- */

-- Following is one-directional and needs no approval, unlike friendship.
CREATE TABLE IF NOT EXISTS follows (
  follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);

/* ------------------------------- spectating -------------------------------- */

-- Recorded for analytics and to enforce per-match spectator limits across nodes.
CREATE TABLE IF NOT EXISTS spectator_sessions (
  id          BIGSERIAL PRIMARY KEY,
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS spectator_sessions_match_idx
  ON spectator_sessions (match_id) WHERE left_at IS NULL;

/* ------------------------- server-side configuration ---------------------- */

-- Reward values, timers and matchmaking ranges live here so they can change
-- without a deploy. Code reads defaults from @carrom/config and overlays these.
CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Previous values, so a bad config change can be traced and reverted.
CREATE TABLE IF NOT EXISTS app_config_history (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_config_history_key_idx
  ON app_config_history (key, created_at DESC);

/* -------------------------------- idempotency ------------------------------ */

-- Every reward-granting operation records a key here inside its own
-- transaction. A replayed request hits the unique index and is refused, which
-- is what stops duplicate crates, payouts and claims.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  result      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_keys_user_idx ON idempotency_keys (user_id, scope);
CREATE INDEX IF NOT EXISTS idempotency_keys_age_idx ON idempotency_keys (created_at);

/* --------------------------------- presence -------------------------------- */

-- Last known presence, mirrored from Redis so it survives a restart and can be
-- read in a join for friend lists.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS presence TEXT NOT NULL DEFAULT 'offline'
    CHECK (presence IN ('online','in_game','in_matchmaking','away','offline')),
  ADD COLUMN IF NOT EXISTS current_match_id UUID,
  ADD COLUMN IF NOT EXISTS title_id TEXT,
  ADD COLUMN IF NOT EXISTS frame_id TEXT,
  ADD COLUMN IF NOT EXISTS banner_id TEXT,
  ADD COLUMN IF NOT EXISTS badge_id TEXT,
  ADD COLUMN IF NOT EXISTS victory_anim_id TEXT,
  ADD COLUMN IF NOT EXISTS ui_theme TEXT NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS total_play_seconds BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS successful_shots INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fouls INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS profiles_presence_idx ON profiles (presence)
  WHERE presence <> 'offline';

/* ------------------------------ match telemetry ---------------------------- */

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS season_id UUID REFERENCES seasons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spectator_peak INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_spectatable BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE match_players
  ADD COLUMN IF NOT EXISTS rating_before INTEGER,
  ADD COLUMN IF NOT EXISTS rating_after INTEGER,
  ADD COLUMN IF NOT EXISTS avg_think_ms INTEGER;

CREATE INDEX IF NOT EXISTS matches_live_idx ON matches (created_at DESC)
  WHERE status = 'playing';
