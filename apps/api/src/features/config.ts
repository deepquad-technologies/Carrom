import { Router } from 'express';
import { z } from 'zod';
import {
  FAIR_PLAY_WEIGHTS, LOGIN_CYCLE, LOGIN_STREAK_BONUS, MATCH_TIERS, SPECTATOR_LIMITS,
  STREAK_REWARDS, TIMERS, XP_REWARDS,
} from '@carrom/config';
import { CRATE_TYPES } from '@carrom/content';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, notFound, route } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

/**
 * Runtime configuration.
 *
 * Defaults live in `@carrom/config` so the code always has sane values, and
 * anything an administrator changes is stored in `app_config` and overlaid on
 * top. Nothing that awards XP, coins or crates reads a literal at the call
 * site — it reads through `cfg()`, so tuning the economy never needs a deploy.
 *
 * Values are cached in memory and refreshed on a short interval; a write busts
 * the cache immediately on the node that made it.
 */
export const configRouter = Router();

/** Every tunable, with its shipped default. */
export const CONFIG_DEFAULTS = {
  'xp.rewards': XP_REWARDS as Record<string, number>,
  'xp.streaks': STREAK_REWARDS,
  'economy.rake': 0.1,
  'economy.startingBalance': 2_000,
  'economy.bonusAmount': 500,
  'economy.bonusCooldownMs': 60 * 60 * 1000,
  'economy.bonusThreshold': 200,
  'match.timers': Object.fromEntries(
    Object.entries(TIMERS).map(([id, timer]) => [id, timer.turnSeconds]),
  ),
  'match.tiers': Object.fromEntries(MATCH_TIERS.map((tier) => [tier.id, tier.entry])),
  'match.maxTurns': 150,
  'matchmaking.ratingTolerance': 150,
  'matchmaking.toleranceGrowthPer10s': 100,
  'crates.unlockMs': Object.fromEntries(
    Object.entries(CRATE_TYPES).map(([id, crate]) => [id, crate.unlockMs]),
  ),
  'crates.coinFactor': Object.fromEntries(
    Object.entries(CRATE_TYPES).map(([id, crate]) => [id, crate.coinFactor]),
  ),
  'crates.slots': 4,
  'login.cycle': LOGIN_CYCLE,
  'login.streakBonusPerDay': LOGIN_STREAK_BONUS.perDay,
  'fairPlay.weights': FAIR_PLAY_WEIGHTS as Record<string, number>,
  'spectator.limits': SPECTATOR_LIMITS as Record<string, number>,
  'content.disabledBoards': [] as string[],
  'content.disabledStrikers': [] as string[],
  'content.disabledCoinSets': [] as string[],
  'events.active': [] as string[],
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

const CACHE_TTL_MS = 30_000;

let cache = new Map<string, unknown>();
let loadedAt = 0;
let loading: Promise<void> | null = null;

async function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const rows = await query<{ key: string; value: unknown }>('SELECT key, value FROM app_config');
      const next = new Map<string, unknown>();
      for (const row of rows) next.set(row.key, row.value);
      cache = next;
      loadedAt = Date.now();
    } catch (err) {
      // A config read failure must never take the game down; defaults apply.
      logger.error({ err }, 'could not load app_config, using defaults');
      loadedAt = Date.now();
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Warm the cache at boot so the first request is not the one that pays. */
export async function primeConfig(): Promise<void> {
  await load();
}

export function invalidateConfig(): void {
  loadedAt = 0;
}

/**
 * Read a tunable. Falls back to the shipped default when it has never been
 * overridden, and returns stale-but-valid values while a refresh is in flight.
 */
export function cfg<K extends ConfigKey>(key: K): (typeof CONFIG_DEFAULTS)[K] {
  if (Date.now() - loadedAt > CACHE_TTL_MS) void load();
  const stored = cache.get(key);
  return (stored ?? CONFIG_DEFAULTS[key]) as (typeof CONFIG_DEFAULTS)[K];
}

/** A single numeric field inside a config object, with a default fallback. */
export function cfgNumber<K extends ConfigKey>(key: K, field: string, fallback: number): number {
  const value = cfg(key) as Record<string, unknown>;
  const found = value?.[field];
  return typeof found === 'number' && Number.isFinite(found) ? found : fallback;
}

/* ---------------------------------- routes -------------------------------- */

configRouter.use(requireAuth, requireRole('moderator', 'admin'));

configRouter.get(
  '/',
  route(async (_req, res) => {
    await load();
    const rows = await query<{ key: string; value: unknown; description: string; updated_at: Date }>(
      'SELECT key, value, description, updated_at FROM app_config ORDER BY key',
    );
    const overrides = new Map(rows.map((row) => [row.key, row]));

    res.json({
      entries: (Object.keys(CONFIG_DEFAULTS) as ConfigKey[]).map((key) => {
        const override = overrides.get(key);
        return {
          key,
          value: override ? override.value : CONFIG_DEFAULTS[key],
          isDefault: !override,
          default: CONFIG_DEFAULTS[key],
          description: override?.description ?? '',
          updatedAt: override?.updated_at ?? null,
        };
      }),
    });
  }),
);

configRouter.put(
  '/:key',
  requireRole('admin'),
  route(async (req, res) => {
    const key = z.string().min(1).max(120).parse(req.params.key);
    if (!(key in CONFIG_DEFAULTS)) throw notFound('No such configuration key');

    const body = z
      .object({ value: z.unknown(), description: z.string().max(300).optional() })
      .parse(req.body);

    // Shape must match the default, so a typo cannot break the game at runtime.
    const expected = CONFIG_DEFAULTS[key as ConfigKey];
    if (!sameShape(expected, body.value)) {
      throw badRequest(
        'That value does not match the expected shape for this key',
        'config_shape_mismatch',
      );
    }

    await transaction(async (client) => {
      const previous = await client.query<{ value: unknown }>(
        'SELECT value FROM app_config WHERE key = $1',
        [key],
      );
      if (previous.rows[0]) {
        await client.query(
          'INSERT INTO app_config_history (key, value, updated_by) VALUES ($1,$2,$3)',
          [key, previous.rows[0].value, req.auth!.sub],
        );
      }

      await client.query(
        `INSERT INTO app_config (key, value, description, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           description = EXCLUDED.description,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [key, JSON.stringify(body.value), body.description ?? '', req.auth!.sub],
      );

      await client.query(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
         VALUES ($1,'config.update','app_config',$2,$3,$4)`,
        [req.auth!.sub, key, JSON.stringify({ value: body.value }), req.ip ?? null],
      );
    });

    invalidateConfig();
    await load();
    logger.warn({ key, by: req.auth!.username }, 'runtime configuration changed');

    res.json({ ok: true, key, value: cfg(key as ConfigKey) });
  }),
);

configRouter.delete(
  '/:key',
  requireRole('admin'),
  route(async (req, res) => {
    const key = z.string().min(1).max(120).parse(req.params.key);
    await query('DELETE FROM app_config WHERE key = $1', [key]);
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id)
       VALUES ($1,'config.reset','app_config',$2)`,
      [req.auth!.sub, key],
    );
    invalidateConfig();
    await load();
    res.json({ ok: true, key, value: CONFIG_DEFAULTS[key as ConfigKey] });
  }),
);

configRouter.get(
  '/:key/history',
  route(async (req, res) => {
    const key = z.string().min(1).max(120).parse(req.params.key);
    const rows = await query(
      `SELECT h.value, h.created_at, u.username AS changed_by
         FROM app_config_history h
         LEFT JOIN users u ON u.id = h.updated_by
        WHERE h.key = $1
        ORDER BY h.created_at DESC LIMIT 50`,
      [key],
    );
    res.json({ history: rows });
  }),
);

/**
 * Structural comparison, not a deep equality check: an override must be the
 * same kind of thing as the default (object with the same keys, array, number,
 * and so on), but its values are free to differ.
 */
function sameShape(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual);
  if (expected === null) return actual === null;

  const expectedType = typeof expected;
  if (expectedType !== 'object') return typeof actual === expectedType;

  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;

  const expectedKeys = Object.keys(expected as Record<string, unknown>);
  const actualKeys = Object.keys(actual as Record<string, unknown>);
  if (expectedKeys.length !== actualKeys.length) return false;

  return expectedKeys.every((key) =>
    sameShape(
      (expected as Record<string, unknown>)[key],
      (actual as Record<string, unknown>)[key],
    ),
  );
}

export async function configSnapshot(): Promise<Record<string, unknown>> {
  await load();
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(CONFIG_DEFAULTS) as ConfigKey[]) {
    snapshot[key] = cfg(key);
  }
  return snapshot;
}

export async function configEntry(key: ConfigKey) {
  await load();
  return one('SELECT * FROM app_config WHERE key = $1', [key]);
}
