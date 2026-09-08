import { randomUUID } from 'node:crypto';
import { GAME_MODES, MATCH_TIERS, modeById, tierById } from '@carrom/config';
import { kvSet, redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Matchmaking queues.
 *
 * A live match is owned by the node holding its sockets, so a queue entry
 * records which node a player is connected to and only that node completes the
 * match. Redis is the shared store, which keeps queue depth accurate across the
 * fleet and lets any node see what is waiting; with several nodes and no sticky
 * routing this degrades to per-node matching rather than pairing players who
 * could never share a room.
 */
export const NODE_ID = process.env.NODE_ID ?? randomUUID().slice(0, 8);

export interface QueueEntry {
  userId: string;
  socketId: string;
  nodeId: string;
  /** Displayed trophies, used to keep ranked pairings close. */
  trophies: number;
  queuedAt: number;
}

function queueKey(modeId: string, tierId: string): string {
  return `mm:${modeId}:${tierId}`;
}

/** Node-local mirror, and the only store when Redis is unavailable. */
const local = new Map<string, QueueEntry[]>();

function localQueue(key: string): QueueEntry[] {
  let list = local.get(key);
  if (!list) {
    list = [];
    local.set(key, list);
  }
  return list;
}

async function publishDepth(key: string, depth: number): Promise<void> {
  await kvSet(`${key}:depth`, String(depth), 120).catch(() => undefined);
}

export interface EnqueueResult {
  matched: QueueEntry[] | null;
  waiting: number;
}

/**
 * Join a queue. Returns the group to seat when enough compatible players are
 * waiting on this node, otherwise reports how many are queued.
 */
export async function enqueue(
  modeId: string,
  tierId: string,
  entry: Omit<QueueEntry, 'nodeId' | 'queuedAt'>,
): Promise<EnqueueResult> {
  const mode = modeById(modeId) ?? GAME_MODES.classic;
  const tier = tierById(tierId) ?? MATCH_TIERS[0];
  const key = queueKey(mode.id, tier.id);
  const queue = localQueue(key);

  // Never let one account hold two places in the same queue.
  const deduped = queue.filter((q) => q.userId !== entry.userId);
  deduped.push({ ...entry, nodeId: NODE_ID, queuedAt: Date.now() });

  const needed = mode.seats;
  if (deduped.length < needed) {
    local.set(key, deduped);
    await publishDepth(key, deduped.length);
    return { matched: null, waiting: deduped.length };
  }

  const group = mode.ranked ? pickRankedGroup(deduped, needed) : deduped.slice(0, needed);
  const remaining = deduped.filter((q) => !group.includes(q));
  local.set(key, remaining);
  await publishDepth(key, remaining.length);

  logger.info(
    { mode: mode.id, tier: tier.id, players: group.length },
    'match formed',
  );
  return { matched: group, waiting: remaining.length };
}

/**
 * For ranked, pair the closest trophy counts rather than the longest wait, and
 * widen the acceptable gap the longer someone has been waiting.
 */
function pickRankedGroup(queue: QueueEntry[], needed: number): QueueEntry[] {
  const sorted = [...queue].sort((a, b) => a.trophies - b.trophies);
  let best: QueueEntry[] = sorted.slice(0, needed);
  let bestSpread = Number.POSITIVE_INFINITY;

  for (let i = 0; i + needed <= sorted.length; i++) {
    const window = sorted.slice(i, i + needed);
    const spread = window[window.length - 1].trophies - window[0].trophies;
    const oldestWaitMs = Date.now() - Math.min(...window.map((w) => w.queuedAt));
    // Every 10 seconds of waiting forgives another 100 trophies of gap.
    const tolerance = 150 + Math.floor(oldestWaitMs / 10_000) * 100;
    if (spread <= tolerance && spread < bestSpread) {
      best = window;
      bestSpread = spread;
    }
  }
  return best;
}

export async function dequeueSocket(socketId: string): Promise<void> {
  for (const [key, queue] of local.entries()) {
    const next = queue.filter((q) => q.socketId !== socketId);
    if (next.length !== queue.length) {
      local.set(key, next);
      await publishDepth(key, next.length);
    }
  }
}

export async function dequeueUser(userId: string): Promise<void> {
  for (const [key, queue] of local.entries()) {
    const next = queue.filter((q) => q.userId !== userId);
    if (next.length !== queue.length) {
      local.set(key, next);
      await publishDepth(key, next.length);
    }
  }
}

export function localDepth(modeId: string, tierId: string): number {
  return local.get(queueKey(modeId, tierId))?.length ?? 0;
}

/** Queue depth across the fleet, when Redis is available. */
export async function fleetDepth(modeId: string, tierId: string): Promise<number> {
  const r = redis();
  if (!r) return localDepth(modeId, tierId);
  const raw = await r.get(`${queueKey(modeId, tierId)}:depth`).catch(() => null);
  return raw ? Number(raw) : localDepth(modeId, tierId);
}

/** Drop entries whose socket went away without a clean leave. */
export async function sweepQueues(isAlive: (socketId: string) => boolean): Promise<number> {
  let removed = 0;
  for (const [key, queue] of local.entries()) {
    const next = queue.filter((q) => isAlive(q.socketId));
    removed += queue.length - next.length;
    if (next.length !== queue.length) {
      local.set(key, next);
      await publishDepth(key, next.length);
    }
  }
  return removed;
}

/**
 * How long a player waits before we offer them a computer opponent.
 *
 * Long enough that a real match is genuinely preferred and a second human
 * arriving still gets paired, short enough that nobody stares at a spinner.
 */
export const BOT_FALLBACK_MS = 12_000;

export interface StaleEntry extends QueueEntry {
  modeId: string;
  tierId: string;
  waitedMs: number;
}

/**
 * Queued players who have waited past the fallback and should be given a bot.
 *
 * Entries are returned, not removed — the caller only dequeues once it has
 * actually seated somebody, so a failed seating leaves the player in the queue
 * for a real opponent rather than dropping them.
 */
export function staleEntries(now = Date.now(), afterMs = BOT_FALLBACK_MS): StaleEntry[] {
  const stale: StaleEntry[] = [];

  for (const [key, queue] of local.entries()) {
    const [, modeId, tierId] = key.split(':');
    for (const entry of queue) {
      const waitedMs = now - entry.queuedAt;
      if (waitedMs >= afterMs) {
        stale.push({ ...entry, modeId: modeId!, tierId: tierId!, waitedMs });
      }
    }
  }

  // Longest wait first, so nobody is overtaken.
  return stale.sort((a, b) => b.waitedMs - a.waitedMs);
}

export function queueSnapshot(): Array<{ mode: string; tier: string; waiting: number }> {
  return [...local.entries()]
    .filter(([, queue]) => queue.length > 0)
    .map(([key, queue]) => {
      const [, mode, tier] = key.split(':');
      return { mode, tier, waiting: queue.length };
    });
}
