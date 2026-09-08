import pg from 'pg';
import { DATABASE_URL, DB_POOL_MAX, IS_PROD } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

/** Postgres returns BIGINT as a string by default; coin balances fit in a JS number. */
pg.types.setTypeParser(20, (value: string) => Number(value));

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: IS_PROD && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client errored');
});

/** Query rows are plain objects; interfaces without index signatures are fine. */
export type Row = object;

export async function query<T extends Row = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms > 250) {
    logger.warn({ ms, sql: text.slice(0, 120) }, 'slow query');
  }
  return result.rows as T[];
}

export async function one<T extends Row = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a unit of work inside a transaction. Anything that moves coins, grants
 * items or settles a match goes through here so a partial failure cannot leave
 * a player paid but not credited.
 */
export async function transaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function healthy(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
