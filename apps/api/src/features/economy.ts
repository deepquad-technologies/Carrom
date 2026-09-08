import type { PoolClient } from 'pg';
import { BONUS_AMOUNT, BONUS_COOLDOWN_MS, BONUS_THRESHOLD } from '@carrom/config';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict } from '../lib/errors.js';

/**
 * Virtual coins. Every movement is written to `coin_ledger` alongside the
 * balance update, in the same transaction, so the ledger and the balance can
 * never disagree. There is no path in this system that converts coins to or
 * from real money.
 */
export type CoinReason =
  | 'entry'
  | 'payout'
  | 'refund'
  | 'crate'
  | 'bonus'
  | 'shop'
  | 'speed_up'
  | 'mission'
  | 'achievement'
  | 'streak'
  | 'tournament'
  | 'admin'
  /** A friend-to-friend transfer: one debit, one credit, nothing minted. */
  | 'gift_sent'
  | 'gift_received'
  /** Coins issued to a bot account so it can cover an entry fee. */
  | 'bot_float';

export interface CoinMovement {
  userId: string;
  delta: number;
  reason: CoinReason;
  matchId?: string | null;
  crateId?: string | null;
  note?: string;
}

/**
 * Apply a coin movement inside an existing transaction.
 *
 * The balance update carries its own guard (`coins + delta >= 0`) so a debit
 * can never take an account negative even if two requests race.
 */
export async function moveCoins(client: PoolClient, m: CoinMovement): Promise<number> {
  const result = await client.query<{ coins: number }>(
    `UPDATE profiles
        SET coins = coins + $2
      WHERE user_id = $1
        AND coins + $2 >= 0
      RETURNING coins`,
    [m.userId, m.delta],
  );

  if (result.rowCount === 0) {
    throw conflict('Not enough coins for that', 'insufficient_coins');
  }
  const balance = Number(result.rows[0].coins);

  await client.query(
    `INSERT INTO coin_ledger (user_id, delta, balance_after, reason, match_id, crate_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [m.userId, m.delta, balance, m.reason, m.matchId ?? null, m.crateId ?? null, m.note ?? null],
  );

  return balance;
}

/** Convenience wrapper when the movement is the whole unit of work. */
export function moveCoinsStandalone(m: CoinMovement): Promise<number> {
  return transaction((client) => moveCoins(client, m));
}

export async function getBalance(userId: string): Promise<number> {
  const row = await one<{ coins: number }>('SELECT coins FROM profiles WHERE user_id = $1', [userId]);
  return row ? Number(row.coins) : 0;
}

export async function hasBalance(userId: string, amount: number): Promise<boolean> {
  return (await getBalance(userId)) >= amount;
}

/**
 * A free top-up so a player is never permanently stuck with too few coins to
 * sit at the lowest table. Rate limited by a cooldown on the profile row.
 */
export async function claimBonus(userId: string): Promise<{
  ok: boolean;
  balance: number;
  message: string;
}> {
  const row = await one<{ coins: number; last_bonus_at: Date | null }>(
    'SELECT coins, last_bonus_at FROM profiles WHERE user_id = $1',
    [userId],
  );
  if (!row) throw badRequest('Profile not found');

  const balance = Number(row.coins);
  if (balance >= BONUS_THRESHOLD) {
    return { ok: false, balance, message: 'You still have coins to play with.' };
  }

  const last = row.last_bonus_at?.getTime() ?? 0;
  const wait = last + BONUS_COOLDOWN_MS - Date.now();
  if (wait > 0) {
    return { ok: false, balance, message: `Next top-up in ${Math.ceil(wait / 60_000)} min.` };
  }

  const next = await transaction(async (client) => {
    const updated = await moveCoins(client, {
      userId,
      delta: BONUS_AMOUNT,
      reason: 'bonus',
      note: 'low balance top-up',
    });
    await client.query('UPDATE profiles SET last_bonus_at = now() WHERE user_id = $1', [userId]);
    return updated;
  });

  return { ok: true, balance: next, message: `${BONUS_AMOUNT} coins added.` };
}

export interface LedgerEntry {
  id: number;
  delta: number;
  balance_after: number;
  reason: CoinReason;
  note: string | null;
  created_at: Date;
}

export function ledgerFor(userId: string, limit = 50): Promise<LedgerEntry[]> {
  return query<LedgerEntry>(
    `SELECT id, delta, balance_after, reason, note, created_at
       FROM coin_ledger
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, Math.min(limit, 200)],
  );
}

/**
 * Integrity check: a profile balance must equal the sum of its ledger. Used by
 * the admin dashboard and worth running as a scheduled job.
 */
export async function auditBalances(limit = 100): Promise<Array<{
  user_id: string;
  coins: number;
  ledger_total: number;
}>> {
  return query(
    `SELECT p.user_id, p.coins, COALESCE(SUM(l.delta), 0)::bigint AS ledger_total
       FROM profiles p
       LEFT JOIN coin_ledger l ON l.user_id = p.user_id
      GROUP BY p.user_id, p.coins
     HAVING p.coins <> COALESCE(SUM(l.delta), 0)
      LIMIT $1`,
    [limit],
  );
}
