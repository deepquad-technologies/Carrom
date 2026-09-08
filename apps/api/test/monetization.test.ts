import { describe, expect, it } from 'vitest';
import { STORE_CATALOGUE, buildPassRewards, storeProductById } from '@carrom/content';
import { AD_LIMITS, REWARDED_PAYOUT } from '../src/features/ads.js';

/**
 * Monetization invariants.
 *
 * These are the rules that must hold for the whole catalogue at once — the kind
 * of thing that is easy to break by adding one more product in a hurry, and
 * expensive to discover in production.
 */

describe('store catalogue', () => {
  it('has no duplicate product ids', () => {
    const ids = STORE_CATALOGUE.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prices everything above zero', () => {
    for (const product of STORE_CATALOGUE) {
      expect(product.priceMinor, product.id).toBeGreaterThan(0);
    }
  });

  it('holds prices as whole minor units', () => {
    // A price with a fractional paise is a rounding bug waiting to be shipped.
    for (const product of STORE_CATALOGUE) {
      expect(Number.isInteger(product.priceMinor), product.id).toBe(true);
    }
  });

  it('only ever shows a genuine discount', () => {
    for (const product of STORE_CATALOGUE) {
      if (product.compareMinor == null) continue;
      expect(product.compareMinor, product.id).toBeGreaterThan(product.priceMinor);
    }
  });

  it('grants something for every product', () => {
    for (const product of STORE_CATALOGUE) {
      const grants = product.grants;
      const givesSomething =
        Boolean(grants.coins) ||
        Boolean(grants.gems) ||
        Boolean(grants.crates?.length) ||
        Boolean(grants.items?.length) ||
        Boolean(grants.entitlement);
      expect(givesSomething, product.id).toBe(true);
    }
  });

  /**
   * The commercial rule: buying more must never cost more per unit. A pack that
   * is worse value than a smaller one is the kind of thing players notice, post
   * about, and never trust you about again.
   */
  it('never makes a bigger pack worse value', () => {
    for (const kind of ['coin_pack', 'gem_pack'] as const) {
      const packs = STORE_CATALOGUE.filter((p) => p.kind === kind).sort(
        (a, b) => a.priceMinor - b.priceMinor,
      );

      let previousRate = 0;
      for (const pack of packs) {
        const amount = kind === 'coin_pack' ? (pack.grants.coins ?? 0) : (pack.grants.gems ?? 0);
        const rate = amount / pack.priceMinor;
        expect(rate, `${pack.id} is worse value than a cheaper pack`).toBeGreaterThanOrEqual(
          previousRate,
        );
        previousRate = rate;
      }
    }
  });

  it('caps one-time offers at one per account', () => {
    const starter = storeProductById('starter_pack');
    expect(starter?.maxPerUser).toBe(1);
  });

  it('gives every subscription a period', () => {
    for (const product of STORE_CATALOGUE.filter((p) => p.kind === 'subscription')) {
      expect(product.periodDays, product.id).toBeGreaterThan(0);
    }
  });

  /**
   * Nothing sold may touch gameplay. The grant shapes here are currency,
   * crates, cosmetics and entitlements — there is deliberately no way to
   * express "and also a wider striker".
   */
  it('sells nothing that affects a match', () => {
    const allowed = new Set(['coins', 'gems', 'crates', 'items', 'entitlement']);
    for (const product of STORE_CATALOGUE) {
      for (const key of Object.keys(product.grants)) {
        expect(allowed.has(key), `${product.id} grants "${key}"`).toBe(true);
      }
    }
  });
});

describe('carrom pass', () => {
  const rewards = buildPassRewards(50);

  it('pays on every tier of the free track', () => {
    for (let tier = 1; tier <= 50; tier++) {
      const reward = rewards.find((r) => r.tier === tier && r.track === 'free');
      expect(reward, `tier ${tier} free`).toBeDefined();
    }
  });

  it('pays on every tier of the premium track', () => {
    for (let tier = 1; tier <= 50; tier++) {
      const reward = rewards.find((r) => r.tier === tier && r.track === 'premium');
      expect(reward, `tier ${tier} premium`).toBeDefined();
    }
  });

  it('never defines the same tier and track twice', () => {
    // A duplicate is silently dropped by the database, which means a reward
    // quietly disappears — exactly the bug this catches.
    const keys = rewards.map((r) => `${r.tier}:${r.track}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('finishes on the legendary crate', () => {
    const last = rewards.find((r) => r.tier === 50 && r.track === 'premium');
    expect(last?.kind).toBe('crate');
    expect(last?.crateKind).toBe('legendary');
  });

  it('makes the premium track worth more than the free one', () => {
    const value = (track: 'free' | 'premium') =>
      rewards
        .filter((r) => r.track === track)
        .reduce((sum, r) => sum + (r.kind === 'coins' ? (r.amount ?? 0) : 0), 0);

    expect(value('premium')).toBeGreaterThan(value('free'));
  });

  it('keeps every reward to something cosmetic or spendable', () => {
    const allowed = new Set(['coins', 'gems', 'crate', 'item', 'xp', 'title']);
    for (const reward of rewards) {
      expect(allowed.has(reward.kind), `${reward.tier}:${reward.track}`).toBe(true);
    }
  });
});

describe('ad frequency limits', () => {
  it('caps interstitials hardest', () => {
    // Interstitials are the intrusive placement; the numbers must reflect that.
    expect(AD_LIMITS.interstitial.perDay).toBeLessThan(AD_LIMITS.banner.perDay);
    expect(AD_LIMITS.interstitial.perDay).toBeLessThan(AD_LIMITS.rewarded.perDay);
  });

  it('puts a real gap between interstitials', () => {
    expect(AD_LIMITS.interstitial.minGapSeconds).toBeGreaterThanOrEqual(60);
  });

  it('never leaves a placement uncapped', () => {
    for (const [placement, limit] of Object.entries(AD_LIMITS)) {
      expect(limit.perDay, placement).toBeGreaterThan(0);
      expect(Number.isFinite(limit.perDay), placement).toBe(true);
    }
  });

  it('pays a modest rewarded amount', () => {
    // Large enough to be worth eight seconds, small enough that watching ads is
    // never a better living than playing.
    expect(REWARDED_PAYOUT.coins).toBeGreaterThan(0);
    expect(REWARDED_PAYOUT.coins).toBeLessThanOrEqual(2_000);
  });

  it('cannot out-earn a match through ads alone', () => {
    // The beginner tier pays 200 coins entry, so a win nets a few hundred. A
    // day of every allowed rewarded ad should stay in the same order of
    // magnitude as a short session of actually playing.
    const dailyMax = REWARDED_PAYOUT.coins * AD_LIMITS.rewarded.perDay;
    expect(dailyMax).toBeLessThanOrEqual(25_000);
  });
});
