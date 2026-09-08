-- Computer opponents, and coin gifts between friends.

-- ---------------------------------------------------------------------------
-- Bot accounts
--
-- A bot is a real user row with a real profile and a real coin balance. That is
-- deliberate: it means a bot pays its entry fee and collects its winnings
-- through the same append-only ledger everyone else uses, so the economy audit
-- stays honest instead of quietly minting coins into every bot match.
--
-- The flag is on `users` rather than a separate table because almost every
-- query that needs to know is already joining `users` to exclude bans.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS users_bot_idx ON users (is_bot) WHERE is_bot = TRUE;

-- Per-bot personality. Kept out of `profiles` so a bot's tuning is obviously
-- operator data rather than something a player could ever own.
CREATE TABLE IF NOT EXISTS bot_accounts (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  skill       TEXT NOT NULL DEFAULT 'medium' CHECK (skill IN ('easy','medium','hard')),
  -- Bots are topped up to this when they cannot afford an entry fee. The
  -- top-up is a logged ledger movement, never a silent balance edit.
  float_coins BIGINT NOT NULL DEFAULT 5000000 CHECK (float_coins > 0),
  -- Taken out of matchmaking without deleting the account or its history.
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bots are excluded from leaderboards, so a ranked view never shows one. The
-- exclusion is a join against users.is_bot, which users_bot_idx covers; an
-- index predicate cannot hold the subquery, and does not need to.

-- ---------------------------------------------------------------------------
-- Coin gifts
--
-- One friend sending another virtual coins. This moves coins, it never creates
-- them: the sender is debited and the recipient credited in one transaction, so
-- both ledgers still sum to their balances afterwards.
--
-- The abuse this table is designed against is alt-account farming — making
-- throwaway accounts to funnel their starting coins into a main. Hence: one
-- gift per sender per day, a cap on the amount, full accounts only, and a
-- record of every transfer for moderation to look at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coin_gifts (
  id           BIGSERIAL PRIMARY KEY,
  from_user    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       BIGINT NOT NULL CHECK (amount > 0),
  message_id   TEXT,
  -- The calendar day the gift was sent, in UTC. The unique index below is what
  -- actually enforces "once a day" — two devices tapping at once collide here
  -- rather than both succeeding.
  sent_on      DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user <> to_user)
);

CREATE UNIQUE INDEX IF NOT EXISTS coin_gifts_one_per_day
  ON coin_gifts (from_user, sent_on);

CREATE INDEX IF NOT EXISTS coin_gifts_to_idx ON coin_gifts (to_user, created_at DESC);
CREATE INDEX IF NOT EXISTS coin_gifts_from_idx ON coin_gifts (from_user, created_at DESC);

-- The coin ledger needs to be able to describe a gift and a bot top-up.
ALTER TABLE coin_ledger DROP CONSTRAINT IF EXISTS coin_ledger_reason_check;
ALTER TABLE coin_ledger ADD CONSTRAINT coin_ledger_reason_check
  CHECK (reason IN (
    'entry','payout','refund','crate','bonus','shop','speed_up','mission',
    'achievement','streak','tournament','admin','gift_sent','gift_received','bot_float'
  ));
