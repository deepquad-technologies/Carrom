import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  CRATE_LIST, CRATE_SLOTS, CRATE_TYPES, dropTable, openCrate, rollCrateKind,
  type CrateInstance, type CrateKind,
} from '@carrom/content';
import { MATCH_TIERS } from '@carrom/config';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';
import { moveCoins } from './economy.js';
import { grantXp } from './progression.js';

export const crateRouter = Router();

interface CrateRow {
  id: string;
  kind: CrateKind;
  tier_entry: number;
  won_at: Date;
  ready_at: Date | null;
  opened_at: Date | null;
}

function toInstance(row: CrateRow): CrateInstance {
  return {
    id: row.id,
    kind: row.kind,
    tierEntry: Number(row.tier_entry),
    wonAt: row.won_at.getTime(),
    readyAt: row.ready_at ? row.ready_at.getTime() : null,
  };
}

export async function openCrateCount(client: PoolClient, userId: string): Promise<number> {
  const rows = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM crates WHERE user_id = $1 AND opened_at IS NULL',
    [userId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

export interface AwardedCrate {
  id: string;
  kind: CrateKind;
}

/**
 * Award a crate for a win. Slots are limited, so a full locker means no drop —
 * the caller tells the player why.
 */
export async function awardCrate(
  client: PoolClient,
  userId: string,
  tierId: string,
  tierEntry: number,
  matchId: string | null,
  source: 'match' | 'streak' | 'mission' | 'tournament' = 'match',
): Promise<AwardedCrate | null> {
  if ((await openCrateCount(client, userId)) >= CRATE_SLOTS) return null;

  const tierIndex = Math.max(0, MATCH_TIERS.findIndex((t) => t.id === tierId));
  const kind = rollCrateKind(tierIndex);

  const result = await client.query<{ id: string }>(
    `INSERT INTO crates (user_id, kind, tier_entry, source, match_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [userId, kind, tierEntry, source, matchId],
  );

  return { id: result.rows[0].id, kind };
}

async function loadCrates(userId: string) {
  const rows = await query<CrateRow>(
    `SELECT id, kind, tier_entry, won_at, ready_at, opened_at
       FROM crates
      WHERE user_id = $1 AND opened_at IS NULL
      ORDER BY won_at`,
    [userId],
  );

  const now = Date.now();
  return rows.map((row) => {
    const crate = toInstance(row);
    const type = CRATE_TYPES[crate.kind];
    const remaining = crate.readyAt === null ? type.unlockMs : Math.max(0, crate.readyAt - now);
    return {
      ...crate,
      name: type.name,
      remaining,
      ready: crate.readyAt !== null && remaining === 0,
      unlocking: crate.readyAt !== null && remaining > 0,
      speedUpCost: remaining > 0 ? Math.ceil(remaining / 60_000) * type.speedUpPerMinute : 0,
      unlockMs: type.unlockMs,
      color: type.color,
      accent: type.accent,
      glow: type.glow,
    };
  });
}

crateRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    res.json({
      crates: await loadCrates(req.auth!.sub),
      slots: CRATE_SLOTS,
      types: CRATE_LIST.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        unlockMs: c.unlockMs,
        itemDrops: c.itemDrops,
        guaranteed: c.guaranteed,
        xp: c.xp,
        color: c.color,
        accent: c.accent,
        glow: c.glow,
        // Published so players can see exactly what the roll uses.
        dropRates: dropTable(c.id),
      })),
    });
  }),
);

/** Start the unlock timer. Only one crate unlocks at a time. */
crateRouter.post(
  '/:id/unlock',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const crateId = z.string().uuid().parse(req.params.id);
    const userId = req.auth!.sub;

    await transaction(async (client) => {
      const row = await client.query<CrateRow>(
        `SELECT id, kind, tier_entry, won_at, ready_at, opened_at
           FROM crates
          WHERE id = $1 AND user_id = $2 AND opened_at IS NULL
          FOR UPDATE`,
        [crateId, userId],
      );
      const crate = row.rows[0];
      if (!crate) throw notFound('No such crate');
      if (crate.ready_at) throw conflict('That crate is already unlocking', 'already_unlocking');

      const busy = await client.query(
        `SELECT 1 FROM crates
          WHERE user_id = $1 AND opened_at IS NULL
            AND ready_at IS NOT NULL AND ready_at > now()`,
        [userId],
      );
      if (busy.rowCount) throw conflict('Another crate is already unlocking', 'slot_busy');

      const readyAt = new Date(Date.now() + CRATE_TYPES[crate.kind].unlockMs);
      await client.query('UPDATE crates SET ready_at = $2 WHERE id = $1', [crateId, readyAt]);
    });

    res.json({ ok: true, crates: await loadCrates(userId) });
  }),
);

/** Skip the remaining wait for virtual coins. */
crateRouter.post(
  '/:id/speed-up',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const crateId = z.string().uuid().parse(req.params.id);
    const userId = req.auth!.sub;

    const result = await transaction(async (client) => {
      const row = await client.query<CrateRow>(
        `SELECT id, kind, tier_entry, won_at, ready_at, opened_at
           FROM crates
          WHERE id = $1 AND user_id = $2 AND opened_at IS NULL
          FOR UPDATE`,
        [crateId, userId],
      );
      const crate = row.rows[0];
      if (!crate) throw notFound('No such crate');
      if (!crate.ready_at) throw conflict('Start the unlock first', 'not_unlocking');

      const remaining = crate.ready_at.getTime() - Date.now();
      if (remaining <= 0) throw conflict('That crate is already open', 'already_ready');

      const cost = Math.ceil(remaining / 60_000) * CRATE_TYPES[crate.kind].speedUpPerMinute;
      const balance = await moveCoins(client, {
        userId,
        delta: -cost,
        reason: 'speed_up',
        crateId,
        note: crate.kind,
      });

      await client.query('UPDATE crates SET ready_at = now() WHERE id = $1', [crateId]);
      return { cost, balance };
    });

    res.json({ ok: true, ...result, crates: await loadCrates(userId) });
  }),
);

/**
 * Open a ready crate. The roll happens here, on the server, and every drop is
 * written to `crate_rewards` so a disputed opening can be looked up later.
 */
crateRouter.post(
  '/:id/open',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const crateId = z.string().uuid().parse(req.params.id);
    const userId = req.auth!.sub;

    const payload = await transaction(async (client) => {
      const row = await client.query<CrateRow>(
        `SELECT id, kind, tier_entry, won_at, ready_at, opened_at
           FROM crates
          WHERE id = $1 AND user_id = $2 AND opened_at IS NULL
          FOR UPDATE`,
        [crateId, userId],
      );
      const crateRow = row.rows[0];
      if (!crateRow) throw notFound('No such crate');
      if (!crateRow.ready_at || crateRow.ready_at.getTime() > Date.now()) {
        throw conflict('That crate is still locked', 'crate_locked');
      }

      const ownedRows = await client.query<{ item_id: string }>(
        'SELECT item_id FROM inventory WHERE user_id = $1',
        [userId],
      );
      const owned = new Set(ownedRows.rows.map((r) => r.item_id));

      const reward = openCrate(toInstance(crateRow), owned);

      for (const drop of reward.drops) {
        if (drop.duplicate) {
          await client.query(
            `INSERT INTO fragments (user_id, rarity, amount)
             VALUES ($1,$2,$3)
             ON CONFLICT (user_id, rarity) DO UPDATE SET amount = fragments.amount + EXCLUDED.amount`,
            [userId, drop.item.rarity, drop.fragments],
          );
          await client.query(
            'UPDATE inventory SET duplicates = duplicates + 1 WHERE user_id = $1 AND item_id = $2',
            [userId, drop.item.id],
          );
        } else {
          await client.query(
            `INSERT INTO inventory (user_id, item_id, source)
             VALUES ($1,$2,'crate')
             ON CONFLICT (user_id, item_id) DO NOTHING`,
            [userId, drop.item.id],
          );
        }

        await client.query(
          `INSERT INTO crate_rewards (crate_id, user_id, item_id, duplicate, coins, fragments)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [crateId, userId, drop.item.id, drop.duplicate, drop.coins, drop.fragments],
        );
      }

      const balance = await moveCoins(client, {
        userId,
        delta: reward.coins,
        reason: 'crate',
        crateId,
        note: crateRow.kind,
      });
      const xp = await grantXp(client, userId, reward.xp);

      await client.query('UPDATE crates SET opened_at = now() WHERE id = $1', [crateId]);

      return { reward, balance, xp };
    });

    res.json({
      ok: true,
      kind: payload.reward.kind,
      coins: payload.reward.coins,
      xp: payload.reward.xp,
      balance: payload.balance,
      levelUp: payload.xp.leveledUp ? payload.xp.levelAfter : null,
      drops: payload.reward.drops.map((d) => ({
        item: d.item,
        duplicate: d.duplicate,
        coins: d.coins,
        fragments: d.fragments,
      })),
      crates: await loadCrates(userId),
    });
  }),
);

/** Recent openings, so support can answer "what did I get?". */
crateRouter.get(
  '/history',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<{
      item_id: string | null; duplicate: boolean; coins: number;
      fragments: number; created_at: Date;
    }>(
      `SELECT item_id, duplicate, coins, fragments, created_at
         FROM crate_rewards
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 60`,
      [req.auth!.sub],
    );
    res.json({ history: rows });
  }),
);

export async function crateSummary(userId: string) {
  const row = await one<{ count: string; ready: string }>(
    `SELECT COUNT(*)::text AS count,
            COUNT(*) FILTER (WHERE ready_at IS NOT NULL AND ready_at <= now())::text AS ready
       FROM crates WHERE user_id = $1 AND opened_at IS NULL`,
    [userId],
  );
  return { held: Number(row?.count ?? 0), ready: Number(row?.ready ?? 0), slots: CRATE_SLOTS };
}
