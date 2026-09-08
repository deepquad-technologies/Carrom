import type { PoolClient } from 'pg';
import { transaction } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * Idempotency for anything that grants value.
 *
 * The pattern is: claim a key inside the same transaction that does the work.
 * If the key is already taken the claim fails, the transaction rolls back
 * without doing anything, and the stored result of the first attempt is
 * returned instead. That makes a retried request — from a flaky network, a
 * double tap, or a replay attempt — impossible to turn into a second payout.
 */
export class DuplicateOperation extends Error {
  constructor(readonly key: string, readonly result: unknown) {
    super(`Operation ${key} already completed`);
    this.name = 'DuplicateOperation';
  }
}

/**
 * Reserve a key. Throws `DuplicateOperation` carrying the first attempt's
 * result if this key has been used before.
 *
 * `ON CONFLICT DO NOTHING` rather than catching a unique violation: in Postgres
 * a raised constraint error aborts the enclosing transaction, and every
 * statement after it — including the read of the original result — fails with
 * "current transaction is aborted". Letting the insert return no rows keeps the
 * transaction healthy long enough to fetch what the first attempt produced.
 */
export async function claimKey(
  client: PoolClient,
  key: string,
  scope: string,
  userId: string | null,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (key, scope, user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, scope, userId],
  );

  if (inserted.rowCount && inserted.rowCount > 0) return;

  const existing = await client.query<{ result: unknown }>(
    'SELECT result FROM idempotency_keys WHERE key = $1',
    [key],
  );
  // Throwing rolls the transaction back, so the replay changes nothing.
  throw new DuplicateOperation(key, existing.rows[0]?.result ?? null);
}

/** Record what the operation produced, so a replay can return the same answer. */
export async function recordResult(
  client: PoolClient,
  key: string,
  result: unknown,
): Promise<void> {
  await client.query('UPDATE idempotency_keys SET result = $2 WHERE key = $1', [
    key,
    JSON.stringify(result ?? null),
  ]);
}

export interface OnceResult<T> {
  /** True when this call did the work, false when it was a replay. */
  fresh: boolean;
  result: T;
}

/**
 * Run `work` exactly once for `key`. A second call with the same key returns
 * the first result without touching anything.
 */
export async function once<T>(
  key: string,
  scope: string,
  userId: string | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<OnceResult<T>> {
  try {
    const result = await transaction(async (client) => {
      await claimKey(client, key, scope, userId);
      const produced = await work(client);
      await recordResult(client, key, produced);
      return produced;
    });
    return { fresh: true, result };
  } catch (err) {
    if (err instanceof DuplicateOperation) {
      logger.info({ key, scope }, 'idempotent replay refused');
      return { fresh: false, result: err.result as T };
    }
    throw err;
  }
}

/** Deterministic keys, so the same logical operation always produces the same one. */
export const keyFor = {
  matchSettlement: (matchId: string) => `match:settle:${matchId}`,
  matchReward: (matchId: string, userId: string) => `match:reward:${matchId}:${userId}`,
  crateOpen: (crateId: string) => `crate:open:${crateId}`,
  loginClaim: (userId: string, day: string) => `login:${userId}:${day}`,
  missionClaim: (userId: string, missionId: string, periodKey: string) =>
    `mission:${userId}:${missionId}:${periodKey}`,
  achievement: (userId: string, achievementId: string) => `achievement:${userId}:${achievementId}`,
  seasonReward: (seasonId: string, userId: string) => `season:${seasonId}:${userId}`,
  tournamentPrize: (tournamentId: string, userId: string) =>
    `tournament:${tournamentId}:${userId}`,
  collectionMilestone: (userId: string, milestoneId: string) =>
    `collection:${userId}:${milestoneId}`,
};

/**
 * Keys are only useful while a retry is plausible. Anything older than the
 * retention window is dropped so the table does not grow without bound.
 */
export async function pruneIdempotencyKeys(days = 30): Promise<number> {
  const { query } = await import('../db/pool.js');
  const removed = await query<{ key: string }>(
    `DELETE FROM idempotency_keys
      WHERE created_at < now() - ($1 || ' days')::interval
      RETURNING key`,
    [String(days)],
  );
  return removed.length;
}
