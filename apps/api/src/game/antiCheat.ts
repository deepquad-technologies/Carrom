import { RATE_LIMITS, SHOT_LIMITS, SUSPICION_THRESHOLDS } from '@carrom/config';
import { one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Anti-cheat.
 *
 * The server is the only authority on game state, so the goal here is not to
 * "detect" a cheat that already worked — it is to reject impossible input at
 * the door and record the pattern for a human to look at. Nothing in this file
 * bans anyone: it raises flags that land in the moderation queue.
 */
export type CheatSignal =
  | 'invalid_shot'
  | 'impossible_shot'
  | 'rapid_actions'
  | 'turn_too_fast'
  | 'abnormal_win_rate'
  | 'state_mismatch'
  | 'packet_flood'
  | 'multi_session';

export interface FlagInput {
  userId: string;
  matchId?: string | null;
  signal: CheatSignal;
  severity?: 1 | 2 | 3 | 4 | 5;
  detail?: Record<string, unknown>;
}

export async function raiseFlag(input: FlagInput): Promise<void> {
  try {
    await query(
      `INSERT INTO cheat_flags (user_id, match_id, signal, severity, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.userId,
        input.matchId ?? null,
        input.signal,
        input.severity ?? 1,
        JSON.stringify(input.detail ?? {}),
      ],
    );
    logger.warn({ ...input }, 'cheat flag raised');
  } catch (err) {
    logger.error({ err, signal: input.signal }, 'could not record cheat flag');
  }
}

/* --------------------------- per-connection state -------------------------- */

interface ConnectionState {
  userId: string;
  /** Rolling counts, reset each minute. */
  window: number;
  counts: Record<string, number>;
  /** Consecutive rejected shots. */
  strikes: number;
  lastShotAt: number;
  lastTurnStartedAt: number;
}

const connections = new Map<string, ConnectionState>();

export function trackConnection(socketId: string, userId: string): void {
  connections.set(socketId, {
    userId,
    window: currentWindow(),
    counts: {},
    strikes: 0,
    lastShotAt: 0,
    lastTurnStartedAt: 0,
  });
}

export function dropConnection(socketId: string): void {
  connections.delete(socketId);
}

function currentWindow(): number {
  return Math.floor(Date.now() / 60_000);
}

function stateOf(socketId: string): ConnectionState | undefined {
  const state = connections.get(socketId);
  if (!state) return undefined;
  const now = currentWindow();
  if (state.window !== now) {
    state.window = now;
    state.counts = {};
  }
  return state;
}

export interface RateVerdict {
  ok: boolean;
  reason?: string;
  /** Set when the behaviour is bad enough to close the connection. */
  disconnect?: boolean;
}

/** Per-socket message ceilings. Exceeding them repeatedly raises a flag. */
export async function checkRate(socketId: string, bucket: keyof typeof BUCKETS): Promise<RateVerdict> {
  const state = stateOf(socketId);
  if (!state) return { ok: true };

  const limit = BUCKETS[bucket];
  const count = (state.counts[bucket] ?? 0) + 1;
  state.counts[bucket] = count;

  if (count <= limit) return { ok: true };

  if (count === limit + 1 || count % 50 === 0) {
    await raiseFlag({
      userId: state.userId,
      signal: bucket === 'generic' ? 'packet_flood' : 'rapid_actions',
      severity: count > limit * 4 ? 4 : 2,
      detail: { bucket, count, limit },
    });
  }

  return {
    ok: false,
    reason: 'You are sending actions too quickly',
    disconnect: count > limit * 6,
  };
}

const BUCKETS = {
  shot: RATE_LIMITS.shotsPerMinute,
  chat: RATE_LIMITS.chatPerMinute,
  lobby: RATE_LIMITS.lobbyActionsPerMinute,
  generic: RATE_LIMITS.genericPerMinute,
} as const;

/* --------------------------------- shots ---------------------------------- */

export interface ShotCheck {
  ok: boolean;
  reason?: string;
  disconnect?: boolean;
}

/**
 * Timing checks around a shot, on top of the engine's own range validation.
 * Two shots closer together than a human can physically manage, or a turn
 * answered faster than the client could have rendered it, are both signals.
 */
export async function checkShotTiming(
  socketId: string,
  matchId: string,
  turnStartedAt: number,
): Promise<ShotCheck> {
  const state = stateOf(socketId);
  if (!state) return { ok: true };

  const now = Date.now();
  const sinceLast = now - state.lastShotAt;
  state.lastShotAt = now;

  if (state.lastShotAt > 0 && sinceLast < SHOT_LIMITS.minMsBetweenShots) {
    await raiseFlag({
      userId: state.userId,
      matchId,
      signal: 'rapid_actions',
      severity: 3,
      detail: { sinceLastMs: sinceLast, minimum: SHOT_LIMITS.minMsBetweenShots },
    });
    return { ok: false, reason: 'That was too fast, try again' };
  }

  const thinkMs = now - turnStartedAt;
  if (turnStartedAt > 0 && thinkMs < SUSPICION_THRESHOLDS.minTurnMs) {
    await raiseFlag({
      userId: state.userId,
      matchId,
      signal: 'turn_too_fast',
      severity: 2,
      detail: { thinkMs, minimum: SUSPICION_THRESHOLDS.minTurnMs },
    });
  }

  return { ok: true };
}

/** Record a rejected shot. Enough in a row and the connection is closed. */
export async function noteInvalidShot(
  socketId: string,
  matchId: string,
  reason: string,
  shot: unknown,
): Promise<ShotCheck> {
  const state = stateOf(socketId);
  if (!state) return { ok: false, reason };

  state.strikes += 1;

  await raiseFlag({
    userId: state.userId,
    matchId,
    signal: 'invalid_shot',
    severity: state.strikes >= SUSPICION_THRESHOLDS.invalidShotStrikes ? 4 : 1,
    detail: { reason, shot, strikes: state.strikes },
  });

  return {
    ok: false,
    reason,
    disconnect: state.strikes >= SUSPICION_THRESHOLDS.invalidShotStrikes,
  };
}

export function noteValidShot(socketId: string): void {
  const state = stateOf(socketId);
  if (state) state.strikes = 0;
}

export function markTurnStart(socketId: string): void {
  const state = stateOf(socketId);
  if (state) state.lastTurnStartedAt = Date.now();
}

/* --------------------------- longer-term patterns -------------------------- */

/**
 * Win rate is a weak signal on its own — a genuinely strong player wins a lot —
 * so this only flags above a high threshold with a meaningful sample, and it
 * never acts on its own.
 */
export async function reviewWinRate(userId: string): Promise<void> {
  const row = await one<{ games_played: number; wins: number }>(
    'SELECT games_played, wins FROM profiles WHERE user_id = $1',
    [userId],
  );
  if (!row || row.games_played < SUSPICION_THRESHOLDS.sampleSize) return;

  const rate = row.wins / row.games_played;
  if (rate < SUSPICION_THRESHOLDS.winRate) return;

  // Do not re-flag the same account every match.
  const recent = await one(
    `SELECT 1 FROM cheat_flags
      WHERE user_id = $1 AND signal = 'abnormal_win_rate'
        AND created_at > now() - INTERVAL '24 hours'`,
    [userId],
  );
  if (recent) return;

  await raiseFlag({
    userId,
    signal: 'abnormal_win_rate',
    severity: 2,
    detail: { games: row.games_played, wins: row.wins, rate: Math.round(rate * 1000) / 10 },
  });
}

/**
 * The same account playing from two live connections at once is worth noting —
 * it is how a player sits on both sides of a table.
 */
export async function noteMultiSession(userId: string, sessions: number): Promise<void> {
  if (sessions < 2) return;
  await raiseFlag({
    userId,
    signal: 'multi_session',
    severity: 2,
    detail: { sessions },
  });
}

/**
 * Two accounts that only ever play each other are colluding to farm coins.
 * Run periodically rather than per match.
 */
export async function detectCollusion(minShared = 12): Promise<void> {
  const pairs = await query<{ a: string; b: string; shared: string; total_a: string }>(
    `WITH pairs AS (
       SELECT LEAST(x.user_id::text, y.user_id::text) AS a,
              GREATEST(x.user_id::text, y.user_id::text) AS b,
              COUNT(*) AS shared
         FROM match_players x
         JOIN match_players y ON y.match_id = x.match_id AND y.user_id <> x.user_id
         JOIN matches m ON m.id = x.match_id
        WHERE m.created_at > now() - INTERVAL '7 days'
        GROUP BY 1, 2
       HAVING COUNT(*) >= $1
     )
     SELECT p.a, p.b, p.shared::text,
            (SELECT COUNT(*) FROM match_players mp
               JOIN matches m2 ON m2.id = mp.match_id
              WHERE mp.user_id = p.a::uuid
                AND m2.created_at > now() - INTERVAL '7 days')::text AS total_a
       FROM pairs p`,
    [minShared],
  );

  for (const pair of pairs) {
    const shared = Number(pair.shared);
    const total = Number(pair.total_a);
    // Only interesting when the pair is most of that account's activity.
    if (total === 0 || shared / total < 0.7) continue;

    for (const userId of [pair.a, pair.b]) {
      await raiseFlag({
        userId,
        signal: 'multi_session',
        severity: 3,
        detail: { pairedWith: userId === pair.a ? pair.b : pair.a, sharedMatches: shared, totalMatches: total },
      });
    }
  }
}

export function connectionCount(): number {
  return connections.size;
}
