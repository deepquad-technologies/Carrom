import { PRESENCE_TIMEOUTS, type PresenceState } from '@carrom/config';
import { query } from '../db/pool.js';
import { kvGet, kvSet, redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Who is around, and what they are doing.
 *
 * Redis is the live store — it is fast and expires on its own. Postgres holds a
 * mirror so a friend list can read presence in a single join and so state
 * survives a restart. The mirror is written on transitions, not on every
 * heartbeat.
 */
export interface Presence {
  state: PresenceState;
  matchId: string | null;
  since: number;
  updatedAt: number;
}

const KEY = (userId: string) => `presence:${userId}`;
const TTL_SECONDS = Math.ceil(PRESENCE_TIMEOUTS.offlineMs / 1000);

/** In-process mirror, used when Redis is unavailable. */
const local = new Map<string, Presence>();

export async function setPresence(
  userId: string,
  state: PresenceState,
  matchId: string | null = null,
): Promise<void> {
  const now = Date.now();
  const previous = await getPresence(userId);
  const since = previous?.state === state ? previous.since : now;

  const presence: Presence = { state, matchId, since, updatedAt: now };
  local.set(userId, presence);
  await kvSet(KEY(userId), JSON.stringify(presence), TTL_SECONDS).catch(() => undefined);

  // Only persist when the state or match actually changed.
  if (previous?.state !== state || previous?.matchId !== matchId) {
    await query(
      'UPDATE profiles SET presence = $2, current_match_id = $3, last_seen_at = now() WHERE user_id = $1',
      [userId, state, matchId],
    ).catch((err) => logger.error({ err, userId }, 'could not persist presence'));
  }
}

export async function getPresence(userId: string): Promise<Presence | null> {
  const raw = await kvGet(KEY(userId)).catch(() => null);
  if (raw) {
    try {
      return JSON.parse(raw) as Presence;
    } catch {
      // Fall through to the local mirror.
    }
  }
  return local.get(userId) ?? null;
}

/** Refresh the TTL without rewriting state. Called on socket heartbeats. */
export async function touchPresence(userId: string): Promise<void> {
  const presence = await getPresence(userId);
  if (!presence) return;
  presence.updatedAt = Date.now();
  local.set(userId, presence);
  await kvSet(KEY(userId), JSON.stringify(presence), TTL_SECONDS).catch(() => undefined);
}

export async function clearPresence(userId: string): Promise<void> {
  local.delete(userId);
  await setPresence(userId, 'offline', null);
}

/** Bulk read for friend lists and the social lobby. */
export async function presenceFor(userIds: string[]): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  if (userIds.length === 0) return result;

  const client = redis();
  if (client) {
    const raw = await client.mget(userIds.map(KEY)).catch(() => null);
    if (raw) {
      userIds.forEach((userId, index) => {
        const value = raw[index];
        if (!value) return;
        try {
          result.set(userId, JSON.parse(value) as Presence);
        } catch {
          // Ignore a malformed entry rather than failing the whole read.
        }
      });
      return result;
    }
  }

  for (const userId of userIds) {
    const presence = local.get(userId);
    if (presence) result.set(userId, presence);
  }
  return result;
}

/**
 * A session that stopped heartbeating drifts to away, then offline. Called
 * from the server tick.
 */
export async function ageOutPresence(): Promise<void> {
  const now = Date.now();
  for (const [userId, presence] of local.entries()) {
    const idle = now - presence.updatedAt;

    if (presence.state === 'offline') {
      if (idle > PRESENCE_TIMEOUTS.offlineMs) local.delete(userId);
      continue;
    }

    // A player at the board is busy, not away.
    if (presence.state === 'in_game') continue;

    if (idle > PRESENCE_TIMEOUTS.offlineMs) {
      await clearPresence(userId);
    } else if (idle > PRESENCE_TIMEOUTS.awayMs && presence.state !== 'away') {
      await setPresence(userId, 'away', presence.matchId);
    }
  }
}

export function onlineCount(): number {
  let count = 0;
  for (const presence of local.values()) {
    if (presence.state !== 'offline') count++;
  }
  return count;
}

/** Players currently online, for the social lobby. */
export async function onlinePlayers(limit = 60) {
  return query(
    `SELECT p.user_id, u.username, p.display_name, p.avatar_url, p.level, p.trophies,
            p.presence, p.current_match_id, p.title_id, p.frame_id
       FROM profiles p
       JOIN users u ON u.id = p.user_id
      WHERE p.presence <> 'offline'
        AND NOT u.is_guest
        AND p.last_seen_at > now() - INTERVAL '10 minutes'
      ORDER BY p.trophies DESC
      LIMIT $1`,
    [limit],
  );
}

/** Highest-rated players who have played recently, for the lobby's trending row. */
export async function trendingPlayers(limit = 12) {
  return query(
    `SELECT p.user_id, u.username, p.display_name, p.avatar_url, p.level,
            p.trophies, p.presence, p.current_streak,
            COUNT(mr.match_id)::int AS recent_matches
       FROM profiles p
       JOIN users u ON u.id = p.user_id
       JOIN match_results mr ON mr.user_id = p.user_id
      WHERE mr.created_at > now() - INTERVAL '24 hours'
        AND NOT u.is_guest
      GROUP BY p.user_id, u.username, p.display_name, p.avatar_url,
               p.level, p.trophies, p.presence, p.current_streak
      ORDER BY p.trophies DESC, recent_matches DESC
      LIMIT $1`,
    [limit],
  );
}
