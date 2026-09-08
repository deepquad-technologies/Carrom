import { SPECTATOR_LIMITS } from '@carrom/config';
import type { GameState } from '@carrom/types';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { Room } from './rooms.js';

/**
 * Spectating.
 *
 * A spectator is not a seat. They are never added to `room.seats`, never appear
 * in `state.players`, and the gateway resolves a shooter by looking up a *seat*
 * — so a spectator has no seat index to act from and cannot influence the board
 * even if they forge a `game:shot`. Their only outbound message is a reaction,
 * which is rate limited and never reaches game state.
 *
 * The board they receive is also redacted: velocities are stripped, so a
 * spectator client cannot be used as an aim assist for a player on another
 * device.
 */
export interface Spectator {
  userId: string;
  socketId: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: number;
  /** Reactions sent in the current minute, for the cooldown. */
  reactionWindow: number;
  reactionCount: number;
}

/** matchId -> spectators. Kept beside the room, never inside it. */
const spectators = new Map<string, Map<string, Spectator>>();
/** userId -> matchId, so a player only watches one match at a time. */
const watching = new Map<string, string>();

export interface JoinVerdict {
  ok: boolean;
  reason?: string;
  count?: number;
}

export function spectatorsOf(matchId: string): Spectator[] {
  return [...(spectators.get(matchId)?.values() ?? [])];
}

export function spectatorCount(matchId: string): number {
  return spectators.get(matchId)?.size ?? 0;
}

export function matchWatchedBy(userId: string): string | null {
  return watching.get(userId) ?? null;
}

export function isSpectating(matchId: string, userId: string): boolean {
  return spectators.get(matchId)?.has(userId) ?? false;
}

export function addSpectator(room: Room, spectator: Omit<Spectator, 'joinedAt' | 'reactionWindow' | 'reactionCount'>): JoinVerdict {
  const state = room.state;
  if (!state || state.status !== 'playing') {
    return { ok: false, reason: 'That match is not in play' };
  }
  if (!room.isSpectatable) {
    return { ok: false, reason: 'That match is private' };
  }

  // A player at the table can never also be a spectator of it.
  if (room.seats.some((seat) => seat.userId === spectator.userId)) {
    return { ok: false, reason: 'You are playing in that match' };
  }

  const existing = watching.get(spectator.userId);
  if (existing && existing !== room.matchId) {
    return { ok: false, reason: 'You are already watching another match' };
  }

  let bucket = spectators.get(room.matchId);
  if (!bucket) {
    bucket = new Map();
    spectators.set(room.matchId, bucket);
  }

  if (!bucket.has(spectator.userId) && bucket.size >= SPECTATOR_LIMITS.perMatch) {
    return { ok: false, reason: 'That match already has the maximum number of viewers' };
  }

  bucket.set(spectator.userId, {
    ...spectator,
    joinedAt: Date.now(),
    reactionWindow: 0,
    reactionCount: 0,
  });
  watching.set(spectator.userId, room.matchId);

  const count = bucket.size;
  room.spectatorPeak = Math.max(room.spectatorPeak, count);

  void query(
    'INSERT INTO spectator_sessions (match_id, user_id) VALUES ($1,$2)',
    [room.matchId, spectator.userId],
  ).catch((err) => logger.error({ err }, 'could not record spectator session'));

  return { ok: true, count };
}

export function removeSpectator(matchId: string, userId: string): number {
  const bucket = spectators.get(matchId);
  if (bucket) {
    bucket.delete(userId);
    if (bucket.size === 0) spectators.delete(matchId);
  }
  if (watching.get(userId) === matchId) watching.delete(userId);

  void query(
    `UPDATE spectator_sessions SET left_at = now()
      WHERE match_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [matchId, userId],
  ).catch(() => undefined);

  return bucket?.size ?? 0;
}

export function removeSpectatorEverywhere(userId: string): string | null {
  const matchId = watching.get(userId);
  if (!matchId) return null;
  removeSpectator(matchId, userId);
  return matchId;
}

export function clearMatch(matchId: string): void {
  const bucket = spectators.get(matchId);
  if (!bucket) return;
  for (const userId of bucket.keys()) watching.delete(userId);
  spectators.delete(matchId);

  void query(
    'UPDATE spectator_sessions SET left_at = now() WHERE match_id = $1 AND left_at IS NULL',
    [matchId],
  ).catch(() => undefined);

  void query('UPDATE matches SET spectator_peak = GREATEST(spectator_peak, $2) WHERE id = $1', [
    matchId,
    bucket.size,
  ]).catch(() => undefined);
}

/** Reaction cooldown, per spectator. */
export function canReact(matchId: string, userId: string): boolean {
  const spectator = spectators.get(matchId)?.get(userId);
  if (!spectator) return false;

  const window = Math.floor(Date.now() / 60_000);
  if (spectator.reactionWindow !== window) {
    spectator.reactionWindow = window;
    spectator.reactionCount = 0;
  }
  if (spectator.reactionCount >= SPECTATOR_LIMITS.reactionsPerMinute) return false;

  spectator.reactionCount += 1;
  return true;
}

/**
 * The board as a spectator sees it. Velocities are zeroed, because a live
 * velocity field is exactly what an aim-assist tool would want, and a spectator
 * has no legitimate use for it.
 */
export function redactForSpectator(state: GameState): GameState {
  return {
    ...state,
    bodies: state.bodies.map((body) => ({ ...body, vx: 0, vy: 0 })),
    players: state.players.map((player) => ({ ...player, balance: 0 })),
  };
}

export interface LiveMatchSummary {
  matchId: string;
  code: string;
  modeName: string;
  tierName: string;
  boardId: string;
  spectators: number;
  turnCount: number;
  players: Array<{
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    level: number;
    trophies: number;
    color: string;
    pocketed: number;
  }>;
}

/** Matches a player could watch right now. */
export function liveMatches(rooms: Room[], limit = 30): LiveMatchSummary[] {
  return rooms
    .filter((room) => room.state?.status === 'playing' && room.isSpectatable && !room.solo)
    .sort((a, b) => spectatorCount(b.matchId) - spectatorCount(a.matchId))
    .slice(0, limit)
    .map((room) => ({
      matchId: room.matchId,
      code: room.code,
      modeName: room.mode.name,
      tierName: room.tier.name,
      boardId: room.boardId,
      spectators: spectatorCount(room.matchId),
      turnCount: room.state?.turnCount ?? 0,
      players: room.seats.map((seat) => ({
        userId: seat.userId,
        displayName: seat.displayName,
        avatarUrl: seat.avatarUrl,
        level: seat.level,
        trophies: seat.trophies,
        color: seat.color,
        pocketed: room.state?.players.find((p) => p.seat === seat.seat)?.pocketed ?? 0,
      })),
    }));
}

export function totalSpectators(): number {
  let total = 0;
  for (const bucket of spectators.values()) total += bucket.size;
  return total;
}
