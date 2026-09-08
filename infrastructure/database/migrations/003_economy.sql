-- Cosmetics, inventory, crates and the virtual-coin ledger.
--
-- The visual definition of every item lives in @carrom/content. This table
-- carries only what admins need to control at runtime: availability, shop
-- price and whether an item is retired.
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('striker','coin_set','board','avatar','effect')),
  rarity       TEXT NOT NULL CHECK (rarity IN ('common','rare','epic','mythic','legendary')),
  unlock_kind  TEXT NOT NULL CHECK (unlock_kind IN ('starter','level','crate','achievement','shop','tier')),
  unlock_level INTEGER,
  unlock_achievement TEXT,
  unlock_tier  TEXT,
  -- Virtual coin price when unlock_kind = 'shop'.
  price_coins  BIGINT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  droppable    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_category_rarity_idx ON items (category, rarity);
CREATE INDEX IF NOT EXISTS items_enabled_idx ON items (enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS inventory (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL DEFAULT 'crate'
               CHECK (source IN ('starter','crate','shop','achievement','level','tier','admin')),
  favorite     BOOLEAN NOT NULL DEFAULT FALSE,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS inventory_user_idx ON inventory (user_id);

-- Crafting fragments, banked by rarity when a duplicate drops.
CREATE TABLE IF NOT EXISTS fragments (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rarity   TEXT NOT NULL CHECK (rarity IN ('common','rare','epic','mythic','legendary')),
  amount   INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  PRIMARY KEY (user_id, rarity)
);

CREATE TABLE IF NOT EXISTS crates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('rookie','champion','legendary')),
  -- Room entry the crate was won at; sizes the coin reward.
  tier_entry   BIGINT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'match'
               CHECK (source IN ('match','streak','mission','tournament','admin')),
  match_id     UUID REFERENCES matches(id) ON DELETE SET NULL,
  won_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at     TIMESTAMPTZ,
  opened_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crates_user_open_idx ON crates (user_id) WHERE opened_at IS NULL;

-- What actually came out of a crate, kept so support can answer disputes.
CREATE TABLE IF NOT EXISTS crate_rewards (
  id          BIGSERIAL PRIMARY KEY,
  crate_id    UUID NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT REFERENCES items(id) ON DELETE SET NULL,
  duplicate   BOOLEAN NOT NULL DEFAULT FALSE,
  coins       BIGINT NOT NULL DEFAULT 0,
  fragments   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crate_rewards_user_idx ON crate_rewards (user_id, created_at DESC);

-- Append-only ledger for every virtual coin movement. Balances in `profiles`
-- must always equal the sum of this ledger for a user.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  reason      TEXT NOT NULL
              CHECK (reason IN ('entry','payout','refund','crate','bonus','shop','speed_up',
                                'mission','achievement','streak','tournament','admin')),
  match_id    UUID REFERENCES matches(id) ON DELETE SET NULL,
  crate_id    UUID REFERENCES crates(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coin_ledger_user_idx ON coin_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coin_ledger_reason_idx ON coin_ledger (reason);
