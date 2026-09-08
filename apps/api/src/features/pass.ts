import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { hasEntitlement, moveGems } from './entitlements.js';
import { awardCrate } from './crates.js';

/**
 * The Carrom Pass.
 *
 * Two tracks over one season. Everybody progresses on the free track by
 * playing; buying the pass unlocks the premium track *retroactively*, so a
 * player who buys at tier 30 immediately gets tiers 1-30 rather than being
 * punished for deciding late.
 *
 * Every reward is currency, a crate or a cosmetic. Nothing on either track
 * changes how a shot behaves — the pass buys colour and progress, never an
 * edge across the table.
 */
export const passRouter = Router();
export const passAdminRouter = Router();

export type Track = 'free' | 'premium';

interface PassRow {
  id: string;
  name: string;
  description: string;
  tiers: number;
  xp_per_tier: number;
  product_id: string | null;
  accent: string;
  starts_at: string;
  ends_at: string;
}

interface RewardRow {
  tier: number;
  track: Track;
  reward_kind: 'coins' | 'gems' | 'crate' | 'item' | 'xp' | 'title';
  amount: string;
  item_id: string | null;
  crate_kind: string | null;
}

/**
 * Pass rewards name a crate rarity, but awardCrate rolls a crate from a match
 * tier. This is the bridge between the two vocabularies, kept in one place so
 * a mismatch cannot silently downgrade somebody's reward.
 */
const CRATE_TIER_FOR: Record<string, string> = {
  rookie: 'beginner',
  champion: 'champion',
  legendary: 'grandmaster',
};

/** The pass that is running right now, if any. */
export async function activePass(): Promise<PassRow | null> {
  return one<PassRow>(
    `SELECT * FROM pass_seasons
      WHERE active = TRUE AND starts_at <= now() AND ends_at > now()
      ORDER BY starts_at DESC LIMIT 1`,
  );
}

function tierFromXp(xp: number, pass: PassRow): number {
  return Math.min(pass.tiers, Math.floor(xp / pass.xp_per_tier));
}

/**
 * Add pass XP for a player. Called from match settlement.
 *
 * Silently does nothing when no pass is running, so callers never need to check
 * first — a season gap must not become a crash in the payout path.
 */
export async function addPassXp(userId: string, xp: number): Promise<void> {
  if (xp <= 0) return;
  const pass = await activePass();
  if (!pass) return;

  await query(
    `INSERT INTO pass_progress (pass_id, user_id, xp, tier, premium)
     VALUES ($1, $2, $3, LEAST($4, $3 / $5), FALSE)
     ON CONFLICT (pass_id, user_id) DO UPDATE SET
       xp = pass_progress.xp + $3,
       tier = LEAST($4, (pass_progress.xp + $3) / $5),
       updated_at = now()`,
    [pass.id, userId, xp, pass.tiers, pass.xp_per_tier],
  );
}

/* -------------------------------- player API ------------------------------ */

passRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const pass = await activePass();
    if (!pass) {
      res.json({ pass: null, message: 'No pass is running at the moment.' });
      return;
    }

    const [rewards, progress, claims] = await Promise.all([
      query<RewardRow>(
        `SELECT tier, track, reward_kind, amount::text, item_id, crate_kind
           FROM pass_rewards WHERE pass_id = $1 ORDER BY tier, track`,
        [pass.id],
      ),
      one<{ xp: string; tier: number }>(
        'SELECT xp::text, tier FROM pass_progress WHERE pass_id = $1 AND user_id = $2',
        [pass.id, req.auth!.sub],
      ),
      query<{ tier: number; track: Track }>(
        'SELECT tier, track FROM pass_claims WHERE pass_id = $1 AND user_id = $2',
        [pass.id, req.auth!.sub],
      ),
    ]);

    const premium = await hasEntitlement(req.auth!.sub, 'pass_premium', pass.id);
    const xp = Number(progress?.xp ?? 0);
    const tier = tierFromXp(xp, pass);
    const claimed = new Set(claims.map((c) => `${c.tier}:${c.track}`));

    res.json({
      pass: {
        id: pass.id,
        name: pass.name,
        description: pass.description,
        tiers: pass.tiers,
        xpPerTier: pass.xp_per_tier,
        accent: pass.accent,
        startsAt: pass.starts_at,
        endsAt: pass.ends_at,
        productId: pass.product_id,
      },
      premium,
      xp,
      tier,
      xpIntoTier: xp % pass.xp_per_tier,
      rewards: rewards.map((row) => ({
        tier: row.tier,
        track: row.track,
        kind: row.reward_kind,
        amount: Number(row.amount),
        itemId: row.item_id,
        crateKind: row.crate_kind,
        unlocked: row.tier <= tier && (row.track === 'free' || premium),
        claimed: claimed.has(`${row.tier}:${row.track}`),
      })),
    });
  }),
);

/**
 * Claim one reward.
 *
 * The claim row's primary key is what makes this idempotent: a double tap
 * inserts once, and the second attempt is told it was already claimed rather
 * than paying again.
 */
passRouter.post(
  '/claim',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({ tier: z.number().int().min(1).max(200), track: z.enum(['free', 'premium']) })
      .parse(req.body);

    const pass = await activePass();
    if (!pass) throw notFound('No pass is running');

    const progress = await one<{ xp: string }>(
      'SELECT xp::text FROM pass_progress WHERE pass_id = $1 AND user_id = $2',
      [pass.id, req.auth!.sub],
    );
    const tier = tierFromXp(Number(progress?.xp ?? 0), pass);
    if (body.tier > tier) throw conflict('You have not reached that tier yet', 'tier_locked');

    if (body.track === 'premium' && !(await hasEntitlement(req.auth!.sub, 'pass_premium', pass.id))) {
      throw conflict('The premium track needs the pass', 'needs_pass');
    }

    const reward = await one<RewardRow>(
      `SELECT tier, track, reward_kind, amount::text, item_id, crate_kind
         FROM pass_rewards WHERE pass_id = $1 AND tier = $2 AND track = $3`,
      [pass.id, body.tier, body.track],
    );
    if (!reward) throw notFound('There is no reward at that tier');

    const granted = await transaction(async (client) => {
      const claim = await client.query(
        `INSERT INTO pass_claims (pass_id, user_id, tier, track)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING tier`,
        [pass.id, req.auth!.sub, body.tier, body.track],
      );
      if (claim.rowCount === 0) return null;

      const amount = Number(reward.amount);
      switch (reward.reward_kind) {
        case 'coins':
          await moveCoins(client, {
            userId: req.auth!.sub,
            delta: amount,
            reason: 'shop',
            note: `pass:${pass.id}:${body.tier}`,
          });
          break;
        case 'gems':
          await moveGems(client, {
            userId: req.auth!.sub,
            delta: amount,
            reason: 'pass_reward',
            note: `pass:${pass.id}:${body.tier}`,
          });
          break;
        case 'crate':
          await awardCrate(
            client,
            req.auth!.sub,
            CRATE_TIER_FOR[reward.crate_kind ?? 'rookie'] ?? 'beginner',
            0,
            null,
            'mission',
          );
          break;
        case 'item':
          if (reward.item_id) {
            await client.query(
              `INSERT INTO inventory (user_id, item_id, source) VALUES ($1,$2,'shop')
               ON CONFLICT (user_id, item_id) DO UPDATE SET duplicates = inventory.duplicates + 1`,
              [req.auth!.sub, reward.item_id],
            );
          }
          break;
        case 'xp':
          await client.query('UPDATE profiles SET xp = xp + $2 WHERE user_id = $1', [
            req.auth!.sub,
            amount,
          ]);
          break;
        case 'title':
          if (reward.item_id) {
            await client.query('UPDATE profiles SET title_id = $2 WHERE user_id = $1', [
              req.auth!.sub,
              reward.item_id,
            ]);
          }
          break;
      }
      return reward;
    });

    if (!granted) {
      res.json({ ok: true, alreadyClaimed: true });
      return;
    }

    res.json({
      ok: true,
      reward: {
        kind: granted.reward_kind,
        amount: Number(granted.amount),
        itemId: granted.item_id,
      },
    });
  }),
);

/** Claim everything currently unlocked, in one go. */
passRouter.post(
  '/claim-all',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const pass = await activePass();
    if (!pass) throw notFound('No pass is running');

    const progress = await one<{ xp: string }>(
      'SELECT xp::text FROM pass_progress WHERE pass_id = $1 AND user_id = $2',
      [pass.id, req.auth!.sub],
    );
    const tier = tierFromXp(Number(progress?.xp ?? 0), pass);
    const premium = await hasEntitlement(req.auth!.sub, 'pass_premium', pass.id);

    const pending = await query<RewardRow>(
      `SELECT r.tier, r.track, r.reward_kind, r.amount::text, r.item_id, r.crate_kind
         FROM pass_rewards r
        WHERE r.pass_id = $1 AND r.tier <= $2
          AND (r.track = 'free' OR $3)
          AND NOT EXISTS (
            SELECT 1 FROM pass_claims c
             WHERE c.pass_id = r.pass_id AND c.user_id = $4
               AND c.tier = r.tier AND c.track = r.track
          )
        ORDER BY r.tier`,
      [pass.id, tier, premium, req.auth!.sub],
    );

    let coins = 0;
    let gems = 0;
    let others = 0;

    await transaction(async (client) => {
      for (const reward of pending) {
        const claim = await client.query(
          `INSERT INTO pass_claims (pass_id, user_id, tier, track)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING tier`,
          [pass.id, req.auth!.sub, reward.tier, reward.track],
        );
        if (claim.rowCount === 0) continue;

        const amount = Number(reward.amount);
        if (reward.reward_kind === 'coins') coins += amount;
        else if (reward.reward_kind === 'gems') gems += amount;
        else if (reward.reward_kind === 'crate') {
          await awardCrate(
            client,
            req.auth!.sub,
            CRATE_TIER_FOR[reward.crate_kind ?? 'rookie'] ?? 'beginner',
            0,
            null,
            'mission',
          );
          others += 1;
        } else if (reward.reward_kind === 'item' && reward.item_id) {
          await client.query(
            `INSERT INTO inventory (user_id, item_id, source) VALUES ($1,$2,'shop')
             ON CONFLICT (user_id, item_id) DO UPDATE SET duplicates = inventory.duplicates + 1`,
            [req.auth!.sub, reward.item_id],
          );
          others += 1;
        }
      }

      // One ledger entry each rather than dozens, so history stays readable.
      if (coins > 0) {
        await moveCoins(client, {
          userId: req.auth!.sub,
          delta: coins,
          reason: 'shop',
          note: `pass:${pass.id}:bulk`,
        });
      }
      if (gems > 0) {
        await moveGems(client, {
          userId: req.auth!.sub,
          delta: gems,
          reason: 'pass_reward',
          note: `pass:${pass.id}:bulk`,
        });
      }
    });

    res.json({ claimed: pending.length, coins, gems, items: others });
  }),
);

/* -------------------------------- admin API ------------------------------- */

passAdminRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const passes = await query<PassRow & { active: boolean }>(
      'SELECT * FROM pass_seasons ORDER BY starts_at DESC LIMIT 20',
    );
    res.json({ passes });
  }),
);

passAdminRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        id: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/),
        name: z.string().min(2).max(80),
        description: z.string().max(400).default(''),
        tiers: z.number().int().min(10).max(200).default(50),
        xpPerTier: z.number().int().min(100).max(100_000).default(1_000),
        productId: z.string().max(64).nullable().default(null),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f2c94c'),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        rewards: z
          .array(
            z.object({
              tier: z.number().int().min(1).max(200),
              track: z.enum(['free', 'premium']),
              kind: z.enum(['coins', 'gems', 'crate', 'item', 'xp', 'title']),
              amount: z.number().int().min(0).max(10_000_000).default(0),
              itemId: z.string().max(64).nullable().default(null),
              crateKind: z.enum(['rookie', 'champion', 'legendary']).nullable().default(null),
            }),
          )
          .max(400)
          .default([]),
      })
      .parse(req.body);

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO pass_seasons
           (id, name, description, tiers, xp_per_tier, product_id, accent, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, tiers = EXCLUDED.tiers,
           xp_per_tier = EXCLUDED.xp_per_tier, product_id = EXCLUDED.product_id,
           accent = EXCLUDED.accent, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at`,
        [
          body.id, body.name, body.description, body.tiers, body.xpPerTier,
          body.productId, body.accent, body.startsAt, body.endsAt,
        ],
      );

      if (body.rewards.length > 0) {
        // Replacing the reward table wholesale is safe: claims are recorded
        // separately, so nobody loses something they already took.
        await client.query('DELETE FROM pass_rewards WHERE pass_id = $1', [body.id]);
        for (const reward of body.rewards) {
          await client.query(
            `INSERT INTO pass_rewards (pass_id, tier, track, reward_kind, amount, item_id, crate_kind)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [body.id, reward.tier, reward.track, reward.kind, reward.amount, reward.itemId, reward.crateKind],
          );
        }
      }
    });

    logger.info({ pass: body.id, admin: req.auth!.sub }, 'carrom pass saved');
    res.json({ ok: true });
  }),
);
