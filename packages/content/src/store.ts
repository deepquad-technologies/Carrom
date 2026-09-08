/**
 * The store catalogue.
 *
 * Defined in code so a price change is a reviewable diff, then seeded into the
 * database, where an admin can run a sale or retire a product without a deploy.
 * The database is authoritative at runtime; this is the starting point.
 *
 * Prices are in the smallest unit of the currency — paise for INR — because a
 * price held as a float eventually becomes a price that is wrong.
 *
 * Two rules the catalogue must always satisfy:
 *
 *   * Nothing here changes how a shot behaves. Currency, cosmetics, crates,
 *     convenience and the removal of ads. A player who never spends can beat a
 *     player who spends everything.
 *   * Nothing here is a wager. Every price and every content list is shown
 *     before paying, and nothing bought can be converted back to money.
 */
export type StoreProductKind =
  | 'coin_pack'
  | 'gem_pack'
  | 'pass'
  | 'subscription'
  | 'bundle'
  | 'ad_free'
  | 'cosmetic';

export interface StoreGrants {
  coins?: number;
  gems?: number;
  /** Match tier ids; the crate rarity follows from the tier. */
  crates?: string[];
  items?: string[];
  entitlement?: {
    kind: 'ad_free' | 'pass_premium' | 'subscription' | 'vip';
    days?: number | null;
    scope?: string | null;
  };
}

export interface StoreProduct {
  id: string;
  kind: StoreProductKind;
  name: string;
  description: string;
  grants: StoreGrants;
  /** Price in the smallest currency unit. */
  priceMinor: number;
  /** Strikethrough price, for a genuine discount only. */
  compareMinor?: number | null;
  badge?: string | null;
  /** Subscription period. */
  periodDays?: number | null;
  sortOrder: number;
  /** A one-per-account offer, such as a starter pack. */
  maxPerUser?: number | null;
}

const COIN_PACKS: StoreProduct[] = [
  {
    id: 'coins_small', kind: 'coin_pack', name: 'Pocketful',
    description: '25,000 coins. Enough for a good evening at the beginner tables.',
    grants: { coins: 25_000 }, priceMinor: 4_900, sortOrder: 10,
  },
  {
    id: 'coins_medium', kind: 'coin_pack', name: 'Coin Bag',
    description: '120,000 coins, with a bit extra for buying more at once.',
    grants: { coins: 120_000 }, priceMinor: 19_900, badge: 'Popular', sortOrder: 20,
  },
  {
    id: 'coins_large', kind: 'coin_pack', name: 'Coin Chest',
    description: '350,000 coins. Opens up the higher tables.',
    grants: { coins: 350_000 }, priceMinor: 49_900, sortOrder: 30,
  },
  {
    id: 'coins_huge', kind: 'coin_pack', name: 'Treasury',
    description: '1,000,000 coins and a Champion crate.',
    grants: { coins: 1_000_000, crates: ['champion'] }, priceMinor: 99_900,
    badge: 'Best value', sortOrder: 40,
  },
];

const GEM_PACKS: StoreProduct[] = [
  {
    id: 'gems_small', kind: 'gem_pack', name: 'Handful of Gems',
    description: '80 gems.',
    grants: { gems: 80 }, priceMinor: 8_900, sortOrder: 10,
  },
  {
    id: 'gems_medium', kind: 'gem_pack', name: 'Gem Pouch',
    description: '260 gems, about a fifth more per rupee.',
    grants: { gems: 260 }, priceMinor: 24_900, badge: 'Popular', sortOrder: 20,
  },
  {
    id: 'gems_large', kind: 'gem_pack', name: 'Gem Casket',
    description: '700 gems.',
    grants: { gems: 700 }, priceMinor: 59_900, sortOrder: 30,
  },
];

const PASSES_AND_SUBS: StoreProduct[] = [
  {
    id: 'pass_premium', kind: 'pass', name: 'Carrom Pass',
    description:
      'Unlocks the premium reward track for this season, including every tier you have already reached.',
    grants: { entitlement: { kind: 'pass_premium' }, gems: 50 },
    priceMinor: 39_900, badge: 'Season', sortOrder: 10,
  },
  {
    id: 'club_monthly', kind: 'subscription', name: 'Club Membership',
    description:
      'No ads, 500 coins every day you play, a monthly Champion crate, and a members-only frame.',
    grants: {
      entitlement: { kind: 'subscription', days: 30 },
      coins: 15_000,
      crates: ['champion'],
    },
    priceMinor: 29_900, periodDays: 30, badge: 'Monthly', sortOrder: 20,
  },
  {
    id: 'ad_free_forever', kind: 'ad_free', name: 'Remove Ads',
    description: 'Removes every advert, permanently. One payment.',
    grants: { entitlement: { kind: 'ad_free', days: null } },
    priceMinor: 24_900, sortOrder: 30, maxPerUser: 1,
  },
];

const BUNDLES: StoreProduct[] = [
  {
    id: 'starter_pack', kind: 'bundle', name: 'Starter Pack',
    description: '50,000 coins, 40 gems and a Champion crate. Once per account.',
    grants: { coins: 50_000, gems: 40, crates: ['elite'] },
    priceMinor: 9_900, compareMinor: 24_900, badge: 'One time', sortOrder: 5,
    maxPerUser: 1,
  },
  {
    id: 'weekend_bundle', kind: 'bundle', name: 'Weekend Bundle',
    description: '200,000 coins, 150 gems and two crates.',
    grants: { coins: 200_000, gems: 150, crates: ['champion', 'elite'] },
    priceMinor: 44_900, compareMinor: 59_900, sortOrder: 50,
  },
];

export const STORE_CATALOGUE: StoreProduct[] = [
  ...BUNDLES,
  ...COIN_PACKS,
  ...GEM_PACKS,
  ...PASSES_AND_SUBS,
];

export function storeProductById(id: string): StoreProduct | undefined {
  return STORE_CATALOGUE.find((product) => product.id === id);
}

/* ------------------------------- Carrom Pass ------------------------------- */

export interface PassRewardDef {
  tier: number;
  track: 'free' | 'premium';
  kind: 'coins' | 'gems' | 'crate' | 'item' | 'xp' | 'title';
  amount?: number;
  itemId?: string | null;
  crateKind?: 'rookie' | 'champion' | 'legendary' | null;
}

/**
 * A 50-tier pass.
 *
 * The free track pays something on every tier, so a player who never spends
 * still has a reason to look at it. The premium track pays more, and adds the
 * cosmetics — but nothing on either track affects a match.
 */
export function buildPassRewards(tiers = 50): PassRewardDef[] {
  const rewards: PassRewardDef[] = [];

  for (let tier = 1; tier <= tiers; tier++) {
    const milestone = tier % 10 === 0;
    const half = tier % 5 === 0;

    // Free track: coins, with a crate at every tenth tier.
    if (milestone) {
      rewards.push({ tier, track: 'free', kind: 'crate', crateKind: 'rookie', amount: 0 });
    } else {
      rewards.push({
        tier,
        track: 'free',
        kind: 'coins',
        amount: 1_000 + Math.floor(tier / 5) * 500,
      });
    }

    // Premium track: gems, bigger coin drops, and a crate at each milestone.
    // The final tier is the one people play for, so it is the legendary crate
    // rather than another champion one.
    if (tier === tiers) {
      rewards.push({ tier, track: 'premium', kind: 'crate', crateKind: 'legendary', amount: 0 });
    } else if (milestone) {
      rewards.push({ tier, track: 'premium', kind: 'crate', crateKind: 'champion', amount: 0 });
    } else if (half) {
      rewards.push({ tier, track: 'premium', kind: 'gems', amount: 20 + tier });
    } else {
      rewards.push({
        tier,
        track: 'premium',
        kind: 'coins',
        amount: 4_000 + Math.floor(tier / 3) * 1_000,
      });
    }
  }

  return rewards;
}
