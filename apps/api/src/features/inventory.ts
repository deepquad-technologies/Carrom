import { Router } from 'express';
import { z } from 'zod';
import {
  BOARDS, COIN_SETS, STRIKERS, itemById, RARITY_ORDER, CATALOG_COUNTS,
} from '@carrom/content';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { requireAuth, generalRateLimit } from '../auth/middleware.js';
import { moveCoins } from './economy.js';

export const inventoryRouter = Router();

interface InventoryRow {
  item_id: string;
  acquired_at: Date;
  source: string;
  favorite: boolean;
  duplicates: number;
}

export async function ownedItemIds(userId: string): Promise<Set<string>> {
  const rows = await query<{ item_id: string }>(
    'SELECT item_id FROM inventory WHERE user_id = $1',
    [userId],
  );
  return new Set(rows.map((r) => r.item_id));
}

/**
 * The full locker: every cosmetic in the game, flagged with whether this player
 * owns it and how it can be unlocked. Sending the whole catalogue keeps the
 * client simple and lets it show locked items with their unlock condition.
 */
inventoryRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const userId = req.auth!.sub;

    const rows = await query<InventoryRow>(
      'SELECT item_id, acquired_at, source, favorite, duplicates FROM inventory WHERE user_id = $1',
      [userId],
    );
    const owned = new Map(rows.map((r) => [r.item_id, r]));

    const fragments = await query<{ rarity: string; amount: number }>(
      'SELECT rarity, amount FROM fragments WHERE user_id = $1',
      [userId],
    );

    const profile = await one<{
      equipped_striker: string; equipped_coin_set: string; equipped_board: string;
      level: number; coins: number;
    }>(
      `SELECT equipped_striker, equipped_coin_set, equipped_board, level, coins
         FROM profiles WHERE user_id = $1`,
      [userId],
    );

    const decorate = <T extends { id: string; rarity: string }>(item: T) => {
      const row = owned.get(item.id);
      return {
        ...item,
        owned: Boolean(row),
        favorite: row?.favorite ?? false,
        duplicates: row?.duplicates ?? 0,
        acquiredAt: row?.acquired_at?.toISOString() ?? null,
      };
    };

    res.json({
      strikers: STRIKERS.map(decorate),
      coinSets: COIN_SETS.map(decorate),
      boards: BOARDS.map(decorate),
      equipped: {
        striker: profile?.equipped_striker,
        coinSet: profile?.equipped_coin_set,
        board: profile?.equipped_board,
      },
      fragments: Object.fromEntries(
        RARITY_ORDER.map((r) => [r, fragments.find((f) => f.rarity === r)?.amount ?? 0]),
      ),
      counts: {
        ...CATALOG_COUNTS,
        owned: owned.size,
      },
      level: profile?.level ?? 1,
      coins: Number(profile?.coins ?? 0),
    });
  }),
);

/** Which profile column each equippable category writes to. */
const EQUIP_COLUMN: Record<string, string> = {
  striker: 'equipped_striker',
  coin_set: 'equipped_coin_set',
  board: 'equipped_board',
  avatar: 'equipped_avatar',
  frame: 'frame_id',
  banner: 'banner_id',
  badge: 'badge_id',
  victory: 'victory_anim_id',
};

/** Equip an owned cosmetic. Ownership is checked server-side, always. */
inventoryRouter.post(
  '/equip',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const { itemId } = z.object({ itemId: z.string().min(1).max(64) }).parse(req.body);
    const userId = req.auth!.sub;

    // The catalogue row is the authority on what an item is; the in-memory
    // content package only covers strikers and coin sets.
    const row = await one<{ category: string }>('SELECT category FROM items WHERE id = $1', [itemId]);
    const board = BOARDS.find((b) => b.id === itemId);
    const item = itemById(itemId);
    if (!row && !board && !item) throw notFound('No such item');

    const category = row?.category ?? (board ? 'board' : item!.category);
    const column = EQUIP_COLUMN[category];
    if (!column) throw badRequest('That item cannot be equipped');

    const ownedRow = await one('SELECT 1 FROM inventory WHERE user_id = $1 AND item_id = $2', [
      userId,
      itemId,
    ]);
    if (!ownedRow) throw conflict('You do not own that yet', 'not_owned');

    await query(`UPDATE profiles SET ${column} = $2 WHERE user_id = $1`, [userId, itemId]);
    res.json({ ok: true, equipped: { category, itemId } });
  }),
);

inventoryRouter.post(
  '/favorite',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({ itemId: z.string().min(1).max(64), favorite: z.boolean() })
      .parse(req.body);

    const updated = await query(
      'UPDATE inventory SET favorite = $3 WHERE user_id = $1 AND item_id = $2 RETURNING item_id',
      [req.auth!.sub, body.itemId, body.favorite],
    );
    if (updated.length === 0) throw conflict('You do not own that yet', 'not_owned');
    res.json({ ok: true });
  }),
);

/**
 * Buy a shop cosmetic with virtual coins. Price and unlock rules come from the
 * database, never from the request.
 */
inventoryRouter.post(
  '/buy',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const { itemId } = z.object({ itemId: z.string().min(1).max(64) }).parse(req.body);
    const userId = req.auth!.sub;

    const result = await transaction(async (client) => {
      const itemRow = await client.query<{
        id: string; name: string; unlock_kind: string; price_coins: number | null;
        unlock_level: number | null; enabled: boolean;
      }>(
        `SELECT id, name, unlock_kind, price_coins, unlock_level, enabled
           FROM items WHERE id = $1`,
        [itemId],
      );
      const item = itemRow.rows[0];
      if (!item) throw notFound('No such item');
      if (!item.enabled) throw conflict('That item is not available', 'item_disabled');
      if (item.unlock_kind !== 'shop' || !item.price_coins) {
        throw conflict('That item is not for sale', 'not_purchasable');
      }

      const already = await client.query('SELECT 1 FROM inventory WHERE user_id = $1 AND item_id = $2', [
        userId,
        itemId,
      ]);
      if (already.rowCount) throw conflict('You already own that', 'already_owned');

      if (item.unlock_level) {
        const level = await client.query<{ level: number }>(
          'SELECT level FROM profiles WHERE user_id = $1',
          [userId],
        );
        if ((level.rows[0]?.level ?? 1) < item.unlock_level) {
          throw conflict(`Reach level ${item.unlock_level} first`, 'level_locked');
        }
      }

      const balance = await moveCoins(client, {
        userId,
        delta: -Number(item.price_coins),
        reason: 'shop',
        note: itemId,
      });

      await client.query(
        `INSERT INTO inventory (user_id, item_id, source) VALUES ($1,$2,'shop')`,
        [userId, itemId],
      );

      return { name: item.name, spent: Number(item.price_coins), balance };
    });

    res.json({ ok: true, ...result });
  }),
);

/** Items a player can currently buy, with their prices. */
inventoryRouter.get(
  '/shop',
  requireAuth,
  route(async (req, res) => {
    const owned = await ownedItemIds(req.auth!.sub);
    const rows = await query<{
      id: string; name: string; category: string; rarity: string;
      price_coins: number; unlock_level: number | null;
    }>(
      `SELECT id, name, category, rarity, price_coins, unlock_level
         FROM items
        WHERE unlock_kind = 'shop' AND enabled
        ORDER BY price_coins`,
    );

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        rarity: r.rarity,
        price: Number(r.price_coins),
        requiresLevel: r.unlock_level,
        owned: owned.has(r.id),
      })),
    });
  }),
);
