-- Profile cosmetics and collection milestones.

-- The catalogue grew past strikers, coin sets and boards, so the category
-- constraint has to widen with it.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_category_check;
ALTER TABLE items ADD CONSTRAINT items_category_check
  CHECK (category IN ('striker','coin_set','board','avatar','frame','banner','badge','victory','effect'));

-- Milestone payouts. One row per player per milestone is the record that a
-- milestone was paid; the primary key is what stops a recount paying twice.
CREATE TABLE IF NOT EXISTS collection_claims (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- e.g. "strikers:50" — collection id and the percentage reached.
  milestone_id  TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  owned_at_claim INTEGER NOT NULL,
  coins         BIGINT NOT NULL DEFAULT 0,
  xp            INTEGER NOT NULL DEFAULT 0,
  crate_kind    TEXT CHECK (crate_kind IN ('rookie','champion','legendary')),
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, milestone_id)
);
CREATE INDEX IF NOT EXISTS collection_claims_user_idx
  ON collection_claims (user_id, collection_id);

-- Emote cooldown state, so a mute or a spam block survives a reconnect.
CREATE TABLE IF NOT EXISTS emote_state (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Rolling minute window used for the per-minute cap.
  window_started TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_in_window INTEGER NOT NULL DEFAULT 0,
  -- Set when a player has been rate limited hard enough to sit out a while.
  muted_until    TIMESTAMPTZ
);

-- Whether a player wants to see opponent emotes at all.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS emotes_muted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tutorial_done BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reduced_motion BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS high_contrast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS music_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS haptics_enabled BOOLEAN NOT NULL DEFAULT TRUE;
