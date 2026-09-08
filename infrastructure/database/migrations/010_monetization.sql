-- Store, gems, passes, subscriptions, entitlements, promo codes and advertising.
--
-- Ground rules that shape every table below:
--
--   * Nothing here is gambling. Players buy virtual currency and cosmetics at a
--     known price. There is no wagering, no cash-out, no chance-based purchase
--     whose value is unknown before paying.
--   * The client never decides that a purchase succeeded. A row in `purchases`
--     only reaches 'granted' after the server has verified a receipt with the
--     platform, which is why the receipt and the verification result are both
--     stored.
--   * Currency movement is append-only and auditable, exactly like coins.

-- ---------------------------------------------------------------------------
-- Gems: the premium currency
-- ---------------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gems BIGINT NOT NULL DEFAULT 0 CHECK (gems >= 0);

-- Append-only. profiles.gems must always equal the sum of this ledger, which
-- /admin/economy/audit checks alongside the coin ledger.
CREATE TABLE IF NOT EXISTS gem_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       BIGINT NOT NULL,
  balance     BIGINT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN (
                'purchase','spend','refund','promo','pass_reward','gift',
                'admin_grant','admin_revoke','rewarded_ad'
              )),
  purchase_id UUID,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gem_ledger_user_idx ON gem_ledger (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Store catalogue
--
-- Prices live in the database so a sale does not need a deploy. `price_minor`
-- is in the smallest unit of `currency` (paise, cents), never a float.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS store_products (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'coin_pack','gem_pack','pass','subscription','bundle','ad_free','cosmetic'
                 )),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  -- What the player receives. Shape depends on kind; validated in the API.
  grants         JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_minor    INTEGER NOT NULL CHECK (price_minor >= 0),
  currency       TEXT NOT NULL DEFAULT 'INR',
  -- Strikethrough price for a sale; NULL when not discounted.
  compare_minor  INTEGER CHECK (compare_minor IS NULL OR compare_minor > price_minor),
  -- Platform product identifiers, so one row serves web, iOS and Android.
  sku_apple      TEXT,
  sku_google     TEXT,
  sku_stripe     TEXT,
  -- Subscriptions only.
  period_days    INTEGER CHECK (period_days IS NULL OR period_days > 0),
  sort_order     INTEGER NOT NULL DEFAULT 100,
  badge          TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  -- A per-account cap, e.g. a starter pack that can only be bought once.
  max_per_user   INTEGER,
  available_from TIMESTAMPTZ,
  available_to   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_products_active_idx ON store_products (active, kind, sort_order);

-- ---------------------------------------------------------------------------
-- Purchases
--
-- One row per attempt, from the moment the client asks to buy. The state
-- machine is deliberately explicit so a support question ("did my money go
-- somewhere?") has an answer for every possible outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES store_products(id),
  platform       TEXT NOT NULL CHECK (platform IN ('web','ios','android','promo','admin')),
  provider       TEXT NOT NULL CHECK (provider IN ('stripe','apple','google','promo','admin','sandbox')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','verifying','granted','failed','refunded','revoked')),
  price_minor    INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  -- The provider's own order id. Unique so the same receipt cannot be
  -- redeemed twice, by a replayed request or by two devices at once.
  provider_txn   TEXT,
  -- Raw receipt as supplied by the client, kept for dispute resolution.
  receipt        TEXT,
  -- What the provider said when we verified. Never what the client claimed.
  verification   JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason TEXT,
  granted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchases_provider_txn_idx
  ON purchases (provider, provider_txn) WHERE provider_txn IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchases_user_idx ON purchases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchases_status_idx ON purchases (status, created_at DESC);

ALTER TABLE gem_ledger
  DROP CONSTRAINT IF EXISTS gem_ledger_purchase_fk;
ALTER TABLE gem_ledger
  ADD CONSTRAINT gem_ledger_purchase_fk
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS refunds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  -- Whether we clawed back the granted currency. Sometimes we deliberately do
  -- not, e.g. goodwill refunds; the record says which.
  clawed_back  BOOLEAN NOT NULL DEFAULT TRUE,
  issued_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_user_idx ON refunds (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Entitlements
--
-- The single answer to "is this player allowed X right now". Ad-free, premium
-- pass, subscription tiers. Everything that grants one writes a row here rather
-- than setting a flag somewhere private, so revoking is one place too.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ad_free','pass_premium','subscription','vip')),
  -- Season id for a pass, plan id for a subscription; NULL for account-wide.
  scope       TEXT,
  source      TEXT NOT NULL CHECK (source IN ('purchase','promo','admin','subscription','gift')),
  purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL means permanent.
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS entitlements_lookup_idx
  ON entitlements (user_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES store_products(id),
  provider       TEXT NOT NULL CHECK (provider IN ('stripe','apple','google','sandbox')),
  provider_sub   TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','past_due','cancelled','expired')),
  current_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_end    TIMESTAMPTZ NOT NULL,
  cancel_at_end  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Monthly perks are handed out once per period, tracked by this marker.
  last_grant_for TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_idx
  ON subscriptions (provider, provider_sub) WHERE provider_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id, status);

-- ---------------------------------------------------------------------------
-- Carrom Pass
--
-- A free track everybody progresses on, and a premium track unlocked by buying
-- the pass. Buying the pass never grants an advantage in a match: every reward
-- is currency, a crate or a cosmetic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pass_seasons (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  season_id    UUID REFERENCES seasons(id) ON DELETE SET NULL,
  tiers        INTEGER NOT NULL DEFAULT 50 CHECK (tiers BETWEEN 10 AND 200),
  xp_per_tier  INTEGER NOT NULL DEFAULT 1000 CHECK (xp_per_tier > 0),
  product_id   TEXT REFERENCES store_products(id),
  accent       TEXT NOT NULL DEFAULT '#f2c94c',
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS pass_rewards (
  pass_id     TEXT NOT NULL REFERENCES pass_seasons(id) ON DELETE CASCADE,
  tier        INTEGER NOT NULL CHECK (tier >= 1),
  track       TEXT NOT NULL CHECK (track IN ('free','premium')),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('coins','gems','crate','item','xp','title')),
  amount      BIGINT NOT NULL DEFAULT 0,
  item_id     TEXT,
  crate_kind  TEXT CHECK (crate_kind IN ('rookie','champion','legendary')),
  PRIMARY KEY (pass_id, tier, track)
);

CREATE TABLE IF NOT EXISTS pass_progress (
  pass_id     TEXT NOT NULL REFERENCES pass_seasons(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xp          BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0),
  tier        INTEGER NOT NULL DEFAULT 0,
  premium     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pass_id, user_id)
);

-- One row per claimed reward. The primary key is what makes claiming idempotent.
CREATE TABLE IF NOT EXISTS pass_claims (
  pass_id    TEXT NOT NULL REFERENCES pass_seasons(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier       INTEGER NOT NULL,
  track      TEXT NOT NULL CHECK (track IN ('free','premium')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pass_id, user_id, tier, track)
);

-- ---------------------------------------------------------------------------
-- Promo codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
  code         TEXT PRIMARY KEY,
  description  TEXT NOT NULL DEFAULT '',
  grants       JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_uses     INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  per_user     INTEGER NOT NULL DEFAULT 1 CHECK (per_user >= 1),
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON promo_redemptions (user_id);
CREATE INDEX IF NOT EXISTS promo_redemptions_code_idx ON promo_redemptions (code, user_id);

-- ---------------------------------------------------------------------------
-- Advertising
--
-- Ads are served by us, to our own placements, from campaigns an advertiser
-- books. Targeting is deliberately coarse — country, platform, level band — and
-- never uses anything a player told us in confidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advertisers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  contact_email TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','banned')),
  notes        TEXT,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id  UUID NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','running','paused','finished')),
  -- Where it may appear.
  placement      TEXT NOT NULL CHECK (placement IN ('banner','interstitial','rewarded','sponsored')),
  -- Budget in the smallest currency unit, and what we charge per thousand views.
  budget_minor   BIGINT NOT NULL DEFAULT 0,
  spent_minor    BIGINT NOT NULL DEFAULT 0,
  cpm_minor      INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'INR',
  -- Coarse targeting. NULL means no restriction on that dimension.
  target_countries TEXT[],
  target_platforms TEXT[],
  min_level      INTEGER,
  max_level      INTEGER,
  -- Pace: hard cap on impressions per player per day for this campaign.
  daily_cap      INTEGER NOT NULL DEFAULT 10 CHECK (daily_cap > 0),
  weight         INTEGER NOT NULL DEFAULT 100 CHECK (weight > 0),
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_campaigns_serving_idx
  ON ad_campaigns (status, placement, starts_at, ends_at);

-- Creatives are drawn, not downloaded: a headline, a body line, a call to
-- action and two colours. That keeps ads on-brand, fast, and impossible to use
-- as a tracking pixel.
CREATE TABLE IF NOT EXISTS ad_creatives (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  cta         TEXT NOT NULL DEFAULT 'Learn more',
  click_url   TEXT,
  accent      TEXT NOT NULL DEFAULT '#f2c94c',
  background  TEXT NOT NULL DEFAULT '#12151f',
  emblem      TEXT NOT NULL DEFAULT 'star',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_creatives_campaign_idx ON ad_creatives (campaign_id, active);

CREATE TABLE IF NOT EXISTS ad_impressions (
  id          BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  creative_id UUID REFERENCES ad_creatives(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  placement   TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'unknown',
  country     TEXT,
  clicked     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Rewarded ads only: whether the player watched far enough to be paid.
  completed   BOOLEAN NOT NULL DEFAULT FALSE,
  rewarded    BOOLEAN NOT NULL DEFAULT FALSE,
  shown_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_impressions_campaign_idx ON ad_impressions (campaign_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS ad_impressions_user_day_idx ON ad_impressions (user_id, shown_at DESC);

-- Rewarded-video grants. One row per payout, so a replayed callback cannot pay
-- twice and a player cannot farm the same impression.
CREATE TABLE IF NOT EXISTS ad_rewards (
  impression_id BIGINT PRIMARY KEY REFERENCES ad_impressions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_kind   TEXT NOT NULL CHECK (reward_kind IN ('coins','gems','crate_speedup','extra_spin')),
  amount        BIGINT NOT NULL DEFAULT 0,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_rewards_user_idx ON ad_rewards (user_id, granted_at DESC);

-- A cosmetic an advertiser has sponsored: free to the player, branded, and
-- still purely cosmetic. Never affects a shot.
CREATE TABLE IF NOT EXISTS sponsored_items (
  item_id       TEXT PRIMARY KEY,
  campaign_id   UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  claimable     BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ad frequency control
--
-- Per-player, per-placement counters. Kept in the database rather than only in
-- Redis so a cache flush cannot reset somebody's daily interstitial budget to
-- zero and let the app spam them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_frequency (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placement   TEXT NOT NULL,
  day         DATE NOT NULL,
  shown       INTEGER NOT NULL DEFAULT 0,
  last_shown  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, placement, day)
);
