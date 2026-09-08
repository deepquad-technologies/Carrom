-- Player reports, automated cheat flags, bans and the admin audit trail.
--
-- Flow: a player reports someone from a match or a profile. The report lands in
-- the admin queue together with everything the reviewer needs — the reported
-- account, its recent matches, and any automated flags raised against it. A
-- moderator decides; only an explicit decision applies a ban.

CREATE TABLE IF NOT EXISTS reports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id       UUID REFERENCES matches(id) ON DELETE SET NULL,
  category       TEXT NOT NULL CHECK (category IN
                 ('cheating','bot','stalling','abuse','offensive_name','collusion','other')),
  -- Optional short note from the reporter. Free text is capped in the API.
  detail         TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','reviewing','actioned','dismissed')),
  -- Reviewer decision.
  resolution     TEXT CHECK (resolution IN ('ban','warn','no_action','duplicate')),
  reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  review_note    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One open report per reporter per target keeps the queue honest.
  CHECK (reporter_id <> reported_id)
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_reported_idx ON reports (reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_reporter_idx ON reports (reporter_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_per_pair
  ON reports (reporter_id, reported_id) WHERE status IN ('open','reviewing');

-- Raised automatically by the anti-cheat checks. Never bans on its own; it
-- only queues an account for a human to look at.
CREATE TABLE IF NOT EXISTS cheat_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id    UUID REFERENCES matches(id) ON DELETE SET NULL,
  signal      TEXT NOT NULL CHECK (signal IN
              ('invalid_shot','impossible_shot','rapid_actions','turn_too_fast',
               'abnormal_win_rate','state_mismatch','packet_flood','multi_session')),
  severity    SMALLINT NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 5),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cheat_flags_user_idx ON cheat_flags (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cheat_flags_open_idx ON cheat_flags (reviewed, severity DESC) WHERE NOT reviewed;

CREATE TABLE IF NOT EXISTS bans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'account'
              CHECK (scope IN ('account','ranked','chat')),
  -- NULL expires_at means permanent.
  expires_at  TIMESTAMPTZ,
  issued_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  report_id   UUID REFERENCES reports(id) ON DELETE SET NULL,
  lifted_at   TIMESTAMPTZ,
  lifted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bans_user_active_idx
  ON bans (user_id) WHERE lifted_at IS NULL;

-- Players a user has muted. Purely client-side filtering, stored server-side
-- so it follows them across devices.
CREATE TABLE IF NOT EXISTS mutes (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, muted_id)
);

-- Every privileged action, for accountability.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_type, target_id);

-- Lightweight product analytics. No personal data beyond the user id.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  props       JSONB NOT NULL DEFAULT '{}'::jsonb,
  platform    TEXT CHECK (platform IN ('web','android','ios','unknown')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events (name, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events (user_id, created_at DESC);
