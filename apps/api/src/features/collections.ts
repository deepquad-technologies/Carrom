import { Router } from 'express';
import { z } from 'zod';
import {
  COLLECTIONS, MILESTONES, RARITY_ORDER, buildProgress, collectionById, milestoneId,
  milestoneReward, type CollectionProgress, type Rarity,
} from '@carrom/content';
import { query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { keyFor, once } from '../lib/idempotency.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';
import { moveCoins } from './economy.js';
import { grantXp } from './progression.js';
import { logger } from '../lib/logger.js';

/**
 * Collections.
 *
 * Progress is derived from the inventory rather than stored, so it can never
 * drift from what a player actually owns. Milestone payouts are the only thing
 * recorded, and they are keyed per player per milestone — the primary key on
 * `collection_claims` plus an idempotency key means a recount, a double tap or
 * a replayed request cannot pay twice.
 */
export const collectionRouter = Router();

interface OwnedRow {
  category: string;
  rarity: Rarity;
  owned: string;
  total: string;
}

/**
 * One query for the whole picture: every catalogue item grouped by category and
 * rarity, with a count of how many this player owns.
 */
async function ownershipFor(userId: string): Promise<OwnedRow[]> {
  return query<OwnedRow>(
    `SELECT i.category,
            i.rarity,
            COUNT(*) FILTER (WHERE inv.user_id IS NOT NULL)::text AS owned,
            COUNT(*)::text AS total
       FROM items i
       LEFT JOIN inventory inv ON inv.item_id = i.id AND inv.user_id = $1
      WHERE i.enabled
      GROUP BY i.category, i.rarity`,
    [userId],
  );
}

function emptyRarity(): Record<Rarity, { owned: number; total: number }> {
  return Object.fromEntries(
    RARITY_ORDER.map((r) => [r, { owned: 0, total: 0 }]),
  ) as Record<Rarity, { owned: number; total: number }>;
}

export async function collectionsFor(userId: string): Promise<{
  collections: CollectionProgress[];
  overall: { owned: number; total: number; percent: number };
  unclaimed: number;
}> {
  const [rows, claims] = await Promise.all([
    ownershipFor(userId),
    query<{ milestone_id: string }>(
      'SELECT milestone_id FROM collection_claims WHERE user_id = $1',
      [userId],
    ),
  ]);

  const claimed = new Set(claims.map((c) => c.milestone_id));

  const collections = COLLECTIONS.map((definition) => {
    const byRarity = emptyRarity();
    let owned = 0;

    for (const row of rows) {
      if (row.category !== definition.category) continue;
      const rarity = row.rarity;
      if (!byRarity[rarity]) continue;
      byRarity[rarity] = { owned: Number(row.owned), total: Number(row.total) };
      owned += Number(row.owned);
    }

    return buildProgress(definition, owned, byRarity, claimed);
  });

  const owned = collections.reduce((sum, c) => sum + c.owned, 0);
  const total = collections.reduce((sum, c) => sum + c.total, 0);
  const unclaimed = collections.reduce(
    (sum, c) => sum + c.milestones.filter((m) => m.reached && !m.claimed).length,
    0,
  );

  return {
    collections,
    overall: {
      owned,
      total,
      percent: total > 0 ? Math.round((owned / total) * 1000) / 10 : 0,
    },
    unclaimed,
  };
}

collectionRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    res.json(await collectionsFor(req.auth!.sub));
  }),
);

/** Every item in one collection, flagged with whether it is owned. */
collectionRouter.get(
  '/:id/items',
  requireAuth,
  route(async (req, res) => {
    const id = z.string().min(1).max(32).parse(req.params.id);
    const definition = collectionById(id);
    if (!definition) throw notFound('No such collection');

    const rows = await query(
      `SELECT i.id, i.name, i.rarity, i.unlock_kind, i.unlock_level,
              i.unlock_achievement, i.unlock_tier, i.price_coins,
              inv.acquired_at, inv.favorite,
              (inv.user_id IS NOT NULL) AS owned
         FROM items i
         LEFT JOIN inventory inv ON inv.item_id = i.id AND inv.user_id = $1
        WHERE i.category = $2 AND i.enabled
        ORDER BY (inv.user_id IS NULL), i.rarity, i.name`,
      [req.auth!.sub, definition.category],
    );

    res.json({ collection: definition, items: rows });
  }),
);

/**
 * Claim a reached milestone. The reward is recomputed here from the player's
 * real ownership — the request only names which milestone, never what it pays.
 */
collectionRouter.post(
  '/:id/claim/:at',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().min(1).max(32).parse(req.params.id);
    const at = z.coerce.number().min(0).max(1).parse(req.params.at);

    const definition = collectionById(id);
    if (!definition) throw notFound('No such collection');

    const milestone = MILESTONES.find((m) => Math.abs(m.at - at) < 0.001);
    if (!milestone) throw notFound('No such milestone');

    const userId = req.auth!.sub;
    const key = milestoneId(definition.id, milestone.at);

    // Recount from the inventory before paying anything.
    const progress = await collectionsFor(userId);
    const current = progress.collections.find((c) => c.id === definition.id)!;
    const target = current.milestones.find((m) => m.id === key)!;

    if (!target.reached) {
      throw conflict(
        `You need ${Math.ceil(milestone.at * definition.total)} ${definition.noun} for that`,
        'milestone_not_reached',
      );
    }
    if (target.claimed) throw conflict('Already claimed', 'already_claimed');

    const reward = milestoneReward(definition, milestone);

    const outcome = await once(
      keyFor.collectionMilestone(userId, key),
      'collection_milestone',
      userId,
      async (client) => {
        // The unique key on collection_claims is the second guard, in case two
        // requests race past the idempotency claim.
        const inserted = await client.query(
          `INSERT INTO collection_claims
             (user_id, milestone_id, collection_id, owned_at_claim, coins, xp, crate_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (user_id, milestone_id) DO NOTHING
           RETURNING milestone_id`,
          [userId, key, definition.id, current.owned, reward.coins, reward.xp, reward.crateKind ?? null],
        );
        if (inserted.rowCount === 0) throw conflict('Already claimed', 'already_claimed');

        const balance = await moveCoins(client, {
          userId,
          delta: reward.coins,
          reason: 'achievement',
          note: `collection ${key}`,
        });
        const levels = await grantXp(client, userId, reward.xp);

        if (reward.crateKind) {
          await client.query(
            `INSERT INTO crates (user_id, kind, tier_entry, source) VALUES ($1,$2,$3,'mission')`,
            [userId, reward.crateKind, 5_000],
          );
        }

        await client.query(
          `INSERT INTO notifications (user_id, kind, title, body, data)
           VALUES ($1,'achievement',$2,$3,$4)`,
          [
            userId,
            `${definition.name} — ${milestone.label}`,
            `${current.owned} of ${definition.total} ${definition.noun} collected.`,
            JSON.stringify({ collection: definition.id, at: milestone.at }),
          ],
        );

        return {
          coins: reward.coins,
          xp: reward.xp,
          crateKind: reward.crateKind ?? null,
          balance,
          levelUp: levels.leveledUp ? levels.levelAfter : null,
        };
      },
    );

    logger.info({ userId, milestone: key, fresh: outcome.fresh }, 'collection milestone claimed');

    res.json({
      ok: true,
      alreadyClaimed: !outcome.fresh,
      ...(outcome.result as Record<string, unknown>),
      progress: await collectionsFor(userId),
    });
  }),
);

/**
 * Grant an item outright. Used by achievements and season rewards, and safe to
 * call repeatedly.
 */
export async function grantItem(
  userId: string,
  itemId: string,
  source: 'achievement' | 'level' | 'tier' | 'admin' | 'crate' = 'achievement',
): Promise<boolean> {
  const inserted = await query<{ item_id: string }>(
    `INSERT INTO inventory (user_id, item_id, source)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id, item_id) DO NOTHING
     RETURNING item_id`,
    [userId, itemId, source],
  );
  return inserted.length > 0;
}

/**
 * Items a player has unlocked by level or by reaching a tier, granted lazily so
 * levelling up does not need to know the whole catalogue.
 */
export async function syncUnlockedItems(userId: string): Promise<string[]> {
  const granted = await transaction(async (client) => {
    const rows = await client.query<{ id: string; unlock_kind: string }>(
      `INSERT INTO inventory (user_id, item_id, source)
       SELECT $1, i.id, CASE i.unlock_kind WHEN 'level' THEN 'level' ELSE 'tier' END
         FROM items i
         JOIN profiles p ON p.user_id = $1
        WHERE i.enabled
          AND (
            (i.unlock_kind = 'level' AND i.unlock_level IS NOT NULL AND p.level >= i.unlock_level)
            OR (i.unlock_kind = 'starter')
          )
       ON CONFLICT (user_id, item_id) DO NOTHING
       RETURNING item_id AS id, 'level' AS unlock_kind`,
      [userId],
    );
    return rows.rows.map((r) => r.id);
  });

  if (granted.length > 0) {
    logger.info({ userId, granted: granted.length }, 'level unlocks granted');
  }
  return granted;
}
