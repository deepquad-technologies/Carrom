-- Client performance telemetry, limited-time events, and retention plumbing.

-- ---------------------------------------------------------------------------
-- Performance telemetry
--
-- One row per client sample, not per frame. The client aggregates locally and
-- posts a summary at most once a minute, so this table grows with sessions
-- rather than with time on screen. It is deliberately not linked to a match:
-- we want the shape of the fleet, not a per-player performance profile.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS perf_samples (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('web','ios','android','unknown')),
  app_version   TEXT NOT NULL DEFAULT 'dev',
  -- Coarse device bucket, never a fingerprint.
  device_class  TEXT NOT NULL DEFAULT 'unknown'
                CHECK (device_class IN ('low','mid','high','unknown')),
  fps_avg       REAL NOT NULL,
  fps_min       REAL NOT NULL,
  -- Share of frames that took longer than 50ms, as 0..1.
  jank_ratio    REAL NOT NULL DEFAULT 0,
  ping_ms       INTEGER,
  -- Socket round trips that never came back during the sample.
  drops         INTEGER NOT NULL DEFAULT 0,
  memory_mb     INTEGER,
  in_match      BOOLEAN NOT NULL DEFAULT FALSE,
  sampled_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS perf_samples_time_idx ON perf_samples (sampled_at DESC);
CREATE INDEX IF NOT EXISTS perf_samples_platform_idx ON perf_samples (platform, sampled_at DESC);

-- Crashes and unhandled errors. Separate from perf so a crash storm cannot
-- drown out the sampling, and so it can be retained longer.
CREATE TABLE IF NOT EXISTS client_errors (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('web','ios','android','unknown')),
  app_version  TEXT NOT NULL DEFAULT 'dev',
  kind         TEXT NOT NULL CHECK (kind IN ('crash','error','socket','render')),
  message      TEXT NOT NULL,
  -- Trimmed client-side; we do not want megabytes of stack per report.
  stack        TEXT,
  context      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_errors_time_idx ON client_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_kind_idx ON client_errors (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Limited-time events
--
-- A weekend double-XP run, a themed tournament week, a festival board giveaway.
-- Admin-editable so a live event does not need a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_events (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('xp_boost','coin_boost','crate_boost','themed','tournament')),
  -- Multiplier for boost events; 1 means no change.
  multiplier    NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (multiplier BETWEEN 1 AND 10),
  -- Optional cosmetic theming for the lobby.
  accent        TEXT NOT NULL DEFAULT '#f2c94c',
  banner_id     TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS live_events_window_idx ON live_events (active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- Retention
--
-- These tables are append-only and grow without bound. Nothing here deletes on
-- its own; the API exposes an admin-triggered prune so removal is always a
-- deliberate, logged act rather than a surprise at 3am.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retention_runs (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL,
  older_than  TIMESTAMPTZ NOT NULL,
  deleted     BIGINT NOT NULL,
  run_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retention_runs_time_idx ON retention_runs (run_at DESC);

-- Match history filtering reads by player, then by mode and outcome. The
-- existing (user_id, match_id) index finds the rows; these two let the join
-- and the ordering stay on an index once history gets long.
CREATE INDEX IF NOT EXISTS match_players_outcome_idx
  ON match_players (user_id, won);
CREATE INDEX IF NOT EXISTS matches_mode_ended_idx
  ON matches (mode_id, ended_at DESC);
