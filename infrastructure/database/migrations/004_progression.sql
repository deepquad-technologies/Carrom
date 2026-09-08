-- Achievements, missions and the friend graph.
CREATE TABLE IF NOT EXISTS achievements (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  metric       TEXT NOT NULL,
  target       INTEGER NOT NULL,
  xp           INTEGER NOT NULL DEFAULT 0,
  coins        BIGINT NOT NULL DEFAULT 0,
  grants_item  TEXT REFERENCES items(id) ON DELETE SET NULL,
  tier         TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS player_achievements (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress       INTEGER NOT NULL DEFAULT 0,
  unlocked_at    TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS player_achievements_user_idx ON player_achievements (user_id);

CREATE TABLE IF NOT EXISTS missions (
  id           TEXT PRIMARY KEY,
  period       TEXT NOT NULL CHECK (period IN ('daily','weekly')),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  metric       TEXT NOT NULL,
  target       INTEGER NOT NULL,
  xp           INTEGER NOT NULL DEFAULT 0,
  coins        BIGINT NOT NULL DEFAULT 0,
  crate_kind   TEXT CHECK (crate_kind IN ('rookie','champion','legendary')),
  enabled      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS player_missions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  -- Which day or ISO week this instance belongs to, e.g. 2026-09-07 or 2026-W37.
  period_key  TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, mission_id, period_key)
);
CREATE INDEX IF NOT EXISTS player_missions_user_idx ON player_missions (user_id, period_key);

CREATE TABLE IF NOT EXISTS friends (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','blocked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);
CREATE INDEX IF NOT EXISTS friends_friend_idx ON friends (friend_id);

CREATE TABLE IF NOT EXISTS friend_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (from_user, to_user),
  CHECK (from_user <> to_user)
);
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_user, status);

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Rolled up periodically from profiles so leaderboard reads stay cheap.
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  scope       TEXT NOT NULL CHECK (scope IN ('global','country')),
  period      TEXT NOT NULL CHECK (period IN ('weekly','monthly','all_time')),
  metric      TEXT NOT NULL CHECK (metric IN ('trophies','wins','streak','xp','tournament_points')),
  country     TEXT NOT NULL DEFAULT '',
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value       BIGINT NOT NULL,
  position    INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, period, metric, country, user_id)
);
CREATE INDEX IF NOT EXISTS leaderboard_lookup_idx
  ON leaderboard_entries (scope, period, metric, country, position);
