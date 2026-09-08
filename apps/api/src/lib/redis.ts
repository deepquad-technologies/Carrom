import Redis from 'ioredis';
import { REDIS_ENABLED, REDIS_URL } from './env.js';
import { logger } from './logger.js';

/**
 * Redis backs presence, matchmaking queues and rate limiting, which is what
 * lets the API run as more than one instance. When it is not available the
 * process falls back to in-memory equivalents so a single node still works in
 * development — the fallbacks are correct for one instance and no more.
 */
let client: Redis | null = null;
let usable = false;

if (REDIS_ENABLED) {
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  client.on('ready', () => {
    usable = true;
    logger.info('redis connected');
  });
  client.on('error', (err) => {
    if (usable) logger.warn({ err: err.message }, 'redis error');
    usable = false;
  });
  client.on('end', () => {
    usable = false;
  });

  client.connect().catch((err) => {
    logger.warn(
      { err: err.message },
      'redis unavailable — falling back to in-process state (single instance only)',
    );
  });
}

export function redis(): Redis | null {
  return usable && client ? client : null;
}

export function redisReady(): boolean {
  return usable;
}

/* ------------------------------ memory fallback ---------------------------- */

const memory = new Map<string, { value: string; expiresAt: number | null }>();

function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of memory) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) memory.delete(key);
  }
}
setInterval(sweep, 30_000).unref();

/** Key/value with TTL, backed by Redis when it is up. */
export async function kvSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const r = redis();
  if (r) {
    if (ttlSeconds) await r.set(key, value, 'EX', ttlSeconds);
    else await r.set(key, value);
    return;
  }
  memory.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

export async function kvGet(key: string): Promise<string | null> {
  const r = redis();
  if (r) return r.get(key);
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

export async function kvDel(key: string): Promise<void> {
  const r = redis();
  if (r) {
    await r.del(key);
    return;
  }
  memory.delete(key);
}

/** Fixed-window counter used for rate limiting. Returns the count after this hit. */
export async function incrWindow(key: string, windowSeconds: number): Promise<number> {
  const r = redis();
  if (r) {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, windowSeconds);
    return count;
  }
  const entry = memory.get(key);
  const now = Date.now();
  if (!entry || (entry.expiresAt !== null && entry.expiresAt <= now)) {
    memory.set(key, { value: '1', expiresAt: now + windowSeconds * 1000 });
    return 1;
  }
  const next = Number(entry.value) + 1;
  entry.value = String(next);
  return next;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
    usable = false;
  }
}
