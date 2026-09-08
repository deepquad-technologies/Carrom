import {
  ACHIEVEMENTS, ALL_MISSIONS, AVATARS, BADGES, BANNERS, BOARDS, COIN_SETS, FRAMES,
  STORE_CATALOGUE, STRIKERS, VICTORY_ANIMATIONS, buildPassRewards,
} from '@carrom/content';
import { seedBots } from '../features/bots.js';
import { logger } from '../lib/logger.js';
import { closePool, transaction } from './pool.js';
import { migrate } from './migrate.js';

/**
 * Push the content catalogue into the database.
 *
 * The visual definition of every cosmetic lives in code (@carrom/content); the
 * rows here exist so admins can retire an item, change a shop price or disable
 * a drop without a deploy. Re-running is safe: everything upserts.
 */
async function seedItems(): Promise<number> {
  const rows = [
    ...STRIKERS.map((i) => ({ ...i, category: 'striker' as const })),
    ...COIN_SETS.map((i) => ({ ...i, category: 'coin_set' as const })),
    ...BOARDS.map((b) => ({
      id: b.id, name: b.name, category: 'board' as const, rarity: b.rarity, unlock: b.unlock,
    })),
    // Profile cosmetics share the inventory table, so collections and the
    // locker can treat every category the same way.
    ...AVATARS.map((a) => ({
      id: a.id, name: a.name, category: 'avatar' as const, rarity: a.rarity, unlock: a.unlock,
    })),
    ...FRAMES.map((f) => ({
      id: f.id, name: f.name, category: 'frame' as const, rarity: f.rarity, unlock: f.unlock,
    })),
    ...BANNERS.map((b) => ({
      id: b.id, name: b.name, category: 'banner' as const, rarity: b.rarity, unlock: b.unlock,
    })),
    ...BADGES.map((b) => ({
      id: b.id, name: b.name, category: 'badge' as const, rarity: b.rarity, unlock: b.unlock,
    })),
    ...VICTORY_ANIMATIONS.map((v) => ({
      id: v.id, name: v.name, category: 'victory' as const, rarity: v.rarity, unlock: v.unlock,
    })),
  ];

  await transaction(async (client) => {
    for (const item of rows) {
      const unlock = item.unlock;
      await client.query(
        `INSERT INTO items
           (id, name, category, rarity, unlock_kind, unlock_level,
            unlock_achievement, unlock_tier, price_coins, droppable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           rarity = EXCLUDED.rarity,
           unlock_kind = EXCLUDED.unlock_kind,
           unlock_level = EXCLUDED.unlock_level,
           unlock_achievement = EXCLUDED.unlock_achievement,
           unlock_tier = EXCLUDED.unlock_tier,
           price_coins = EXCLUDED.price_coins,
           droppable = EXCLUDED.droppable,
           updated_at = now()`,
        [
          item.id,
          item.name,
          item.category,
          item.rarity,
          unlock.kind,
          unlock.level ?? null,
          unlock.achievementId ?? null,
          unlock.tierId ?? null,
          unlock.coins ?? null,
          unlock.kind === 'crate',
        ],
      );
    }
  });
  return rows.length;
}

async function seedAchievements(): Promise<number> {
  await transaction(async (client) => {
    for (const a of ACHIEVEMENTS) {
      await client.query(
        `INSERT INTO achievements
           (id, name, description, metric, target, xp, coins, grants_item, tier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           metric = EXCLUDED.metric,
           target = EXCLUDED.target,
           xp = EXCLUDED.xp,
           coins = EXCLUDED.coins,
           grants_item = EXCLUDED.grants_item,
           tier = EXCLUDED.tier`,
        [a.id, a.name, a.description, a.metric, a.target, a.xp, a.coins, a.grantsItemId ?? null, a.tier],
      );
    }
  });
  return ACHIEVEMENTS.length;
}

async function seedMissions(): Promise<number> {
  await transaction(async (client) => {
    for (const m of ALL_MISSIONS) {
      await client.query(
        `INSERT INTO missions
           (id, period, name, description, metric, target, xp, coins, crate_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           period = EXCLUDED.period,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           metric = EXCLUDED.metric,
           target = EXCLUDED.target,
           xp = EXCLUDED.xp,
           coins = EXCLUDED.coins,
           crate_kind = EXCLUDED.crate_kind`,
        [m.id, m.period, m.name, m.description, m.metric, m.target, m.xp, m.coins, m.crateKind ?? null],
      );
    }
  });
  return ALL_MISSIONS.length;
}

/**
 * The store.
 *
 * Prices come from the catalogue in code, but only on first insert: an admin
 * who runs a sale must not have it silently reverted by the next deploy. Name,
 * description and contents are kept in step, because those are content rather
 * than commercial decisions.
 */
async function seedStore(): Promise<number> {
  await transaction(async (client) => {
    for (const product of STORE_CATALOGUE) {
      await client.query(
        `INSERT INTO store_products
           (id, kind, name, description, grants, price_minor, currency, compare_minor,
            sku_apple, sku_google, sku_stripe, period_days, sort_order, badge, max_per_user)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'INR',$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           grants = EXCLUDED.grants,
           period_days = EXCLUDED.period_days,
           sort_order = EXCLUDED.sort_order,
           max_per_user = EXCLUDED.max_per_user,
           updated_at = now()`,
        [
          product.id, product.kind, product.name, product.description,
          JSON.stringify(product.grants), product.priceMinor,
          product.compareMinor ?? null,
          `carrom.${product.id}`, `carrom.${product.id}`, `carrom.${product.id}`,
          product.periodDays ?? null, product.sortOrder, product.badge ?? null,
          product.maxPerUser ?? null,
        ],
      );
    }
  });
  return STORE_CATALOGUE.length;
}

/**
 * A Carrom Pass season.
 *
 * Only created when none exists, so re-seeding a live environment never resets
 * anybody's progress or shifts the end date out from under them.
 */
async function seedPass(): Promise<number> {
  const rewards = buildPassRewards(50);

  const created = await transaction(async (client) => {
    const existing = await client.query(
      "SELECT id FROM pass_seasons WHERE active = TRUE AND ends_at > now()",
    );
    if (existing.rowCount && existing.rowCount > 0) return 0;

    const id = `pass_${new Date().getFullYear()}_${Math.floor(new Date().getMonth() / 3) + 1}`;
    await client.query(
      `INSERT INTO pass_seasons
         (id, name, description, tiers, xp_per_tier, product_id, accent, starts_at, ends_at)
       VALUES ($1,$2,$3,50,1000,'pass_premium','#f2c94c', now(), now() + INTERVAL '90 days')
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        'Season Pass',
        'Play matches to climb 50 tiers. The free track pays on every tier.',
      ],
    );

    await client.query('DELETE FROM pass_rewards WHERE pass_id = $1', [id]);

    let inserted = 0;
    for (const reward of rewards) {
      const written = await client.query(
        `INSERT INTO pass_rewards (pass_id, tier, track, reward_kind, amount, item_id, crate_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (pass_id, tier, track) DO NOTHING`,
        [
          id, reward.tier, reward.track, reward.kind, reward.amount ?? 0,
          reward.itemId ?? null, reward.crateKind ?? null,
        ],
      );
      inserted += written.rowCount ?? 0;
    }
    // Count what landed, not what we attempted: a duplicate tier silently
    // dropped by ON CONFLICT is exactly the kind of thing a seed log should
    // make visible.
    return inserted;
  });

  return created;
}

/**
 * A house advertiser with one campaign per placement.
 *
 * These promote the game's own features, so a fresh install has something to
 * render in every ad slot and the frequency caps can be tested without booking
 * a real advertiser.
 */
async function seedHouseAds(): Promise<number> {
  return transaction(async (client) => {
    const advertiser = await client.query<{ id: string }>(
      `INSERT INTO advertisers (name, contact_email, status, notes)
       SELECT 'Carrom Club (house)', NULL, 'active', 'Built-in promotions for our own features.'
        WHERE NOT EXISTS (SELECT 1 FROM advertisers WHERE name = 'Carrom Club (house)')
       RETURNING id`,
    );

    const advertiserId =
      advertiser.rows[0]?.id ??
      (
        await client.query<{ id: string }>(
          "SELECT id FROM advertisers WHERE name = 'Carrom Club (house)' LIMIT 1",
        )
      ).rows[0]?.id;

    if (!advertiserId) return 0;

    const campaigns: Array<[string, string, string, string, string, string]> = [
      ['House · Banner', 'banner', 'Join a tournament', 'Knockout brackets run all week.', 'See cups', '#f2c94c'],
      ['House · Interstitial', 'interstitial', 'Try the Carrom Pass', 'Fifty tiers of rewards this season.', 'Open pass', '#a78bfa'],
      ['House · Rewarded', 'rewarded', 'Watch for coins', 'A short clip pays 500 coins.', 'Watch', '#4dd6a0'],
    ];

    let made = 0;
    for (const [name, placement, headline, body, cta, accent] of campaigns) {
      const campaign = await client.query<{ id: string }>(
        `INSERT INTO ad_campaigns
           (advertiser_id, name, status, placement, budget_minor, cpm_minor, daily_cap, weight)
         SELECT $1, $2, 'running', $3, 0, 0, 6, 100
          WHERE NOT EXISTS (SELECT 1 FROM ad_campaigns WHERE name = $2)
         RETURNING id`,
        [advertiserId, name, placement],
      );
      if (campaign.rowCount === 0) continue;

      await client.query(
        `INSERT INTO ad_creatives (campaign_id, headline, body, cta, accent, background, emblem)
         VALUES ($1,$2,$3,$4,$5,'#12151f','star')`,
        [campaign.rows[0]!.id, headline, body, cta, accent],
      );
      made += 1;
    }
    return made;
  });
}

export async function seed(): Promise<void> {
  const items = await seedItems();
  const achievements = await seedAchievements();
  const missions = await seedMissions();
  const products = await seedStore();
  const passRewards = await seedPass();
  const houseAds = await seedHouseAds();
  const bots = await seedBots();
  logger.info(
    { items, achievements, missions, products, passRewards, houseAds, bots },
    'seed complete',
  );
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/db/seed.ts');

if (invokedDirectly) {
  migrate()
    .then(() => seed())
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}
