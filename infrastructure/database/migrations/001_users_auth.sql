-- Users, credentials, sessions and linked social accounts.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE,
  password_hash   TEXT,
  username        CITEXT NOT NULL UNIQUE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  is_guest        BOOLEAN NOT NULL DEFAULT FALSE,
  role            TEXT NOT NULL DEFAULT 'player'
                  CHECK (role IN ('player','moderator','admin')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at DESC);

-- Linked Facebook / Google identities. A user may link one of each.
CREATE TABLE IF NOT EXISTS social_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('facebook','google')),
  provider_user_id  TEXT NOT NULL,
  display_name      TEXT,
  avatar_url        TEXT,
  email             CITEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS social_accounts_user_idx ON social_accounts (user_id);

-- Refresh tokens are stored hashed and rotated on every use.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent   TEXT,
  ip           INET
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- Single-use tokens for email verification and password reset.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose);

CREATE TABLE IF NOT EXISTS profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  country           TEXT,
  level             INTEGER NOT NULL DEFAULT 1,
  xp                BIGINT NOT NULL DEFAULT 0,
  -- Virtual in-game coins. Not redeemable and never tied to real money.
  coins             BIGINT NOT NULL DEFAULT 2000 CHECK (coins >= 0),
  trophies          INTEGER NOT NULL DEFAULT 0 CHECK (trophies >= 0),
  games_played      INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  losses            INTEGER NOT NULL DEFAULT 0,
  current_streak    INTEGER NOT NULL DEFAULT 0,
  best_streak       INTEGER NOT NULL DEFAULT 0,
  perfect_games     INTEGER NOT NULL DEFAULT 0,
  queen_covers      INTEGER NOT NULL DEFAULT 0,
  comebacks         INTEGER NOT NULL DEFAULT 0,
  tournament_wins   INTEGER NOT NULL DEFAULT 0,
  tournament_points INTEGER NOT NULL DEFAULT 0,
  equipped_striker  TEXT NOT NULL DEFAULT 'str_classic',
  equipped_coin_set TEXT NOT NULL DEFAULT 'set_classic',
  equipped_board    TEXT NOT NULL DEFAULT 'classic_wood',
  equipped_avatar   TEXT,
  equipped_effect   TEXT,
  last_bonus_at     TIMESTAMPTZ,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profiles_trophies_idx ON profiles (trophies DESC);
CREATE INDEX IF NOT EXISTS profiles_wins_idx ON profiles (wins DESC);
CREATE INDEX IF NOT EXISTS profiles_xp_idx ON profiles (xp DESC);
CREATE INDEX IF NOT EXISTS profiles_country_trophies_idx ON profiles (country, trophies DESC);
