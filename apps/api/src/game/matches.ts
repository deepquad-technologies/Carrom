import type { PoolClient } from 'pg';
import type { GameState, Shot, ShotSummary } from '@carrom/types';
import { query, transaction } from '../db/pool.js';
import { moveCoins } from '../features/economy.js';
import { logger } from '../lib/logger.js';
import type { Room } from './rooms.js';

/**
 * Durable match records. A match row is written when the board starts, every
 * shot is appended as it is resolved, and the result is written when it ends.
 */

export async function persistMatchStart(room: Room): Promise<void> {
  const staked = room.mode.staked && !room.solo;
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO matches
         (id, mode_id, tier_id, board_id, table_size, room_code, is_private, is_ranked,
          entry_coins, pot_coins, turn_seconds, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'playing',now())
       ON CONFLICT (id) DO NOTHING`,
      [
        room.matchId,
        room.mode.id,
        room.tier.id,
        room.boardId,
        room.size,
        room.code,
        room.isPrivate,
        room.mode.ranked,
        staked ? room.tier.entry : 0,
        room.state?.pot ?? 0,
        room.state?.turnSeconds ?? 60,
      ],
    );

    for (const seat of room.seats) {
      await client.query(
        `INSERT INTO match_players
           (match_id, user_id, seat, color, striker_skin, coin_skin,
            level_before, trophies_before, balance_before)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (match_id, seat) DO NOTHING`,
        [
          room.matchId,
          seat.userId,
          seat.seat,
          seat.color,
          seat.strikerSkinId,
          seat.coinSkinId,
          seat.level,
          seat.trophies,
          seat.balanceBefore,
        ],
      );
    }
  });
}

export async function recordShot(
  matchId: string,
  seq: number,
  seat: number,
  shot: Shot,
  summary: ShotSummary,
  thinkMs: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO match_events (match_id, seq, seat, kind, payload, think_ms)
       VALUES ($1,$2,$3,'shot',$4,$5)
       ON CONFLICT (match_id, seq) DO NOTHING`,
      [
        matchId,
        seq,
        seat,
        JSON.stringify({
          shot,
          pocketed: summary.pocketed,
          foul: summary.foul,
          fouls: summary.fouls,
          queenEvent: summary.queenEvent,
          repeatTurn: summary.repeatTurn,
        }),
        thinkMs,
      ],
    );
  } catch (err) {
    logger.error({ err, matchId, seq }, 'could not record shot');
  }
}

export async function recordEvent(
  matchId: string,
  seq: number,
  kind: string,
  payload: Record<string, unknown>,
  seat: number | null = null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO match_events (match_id, seq, seat, kind, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (match_id, seq) DO NOTHING`,
      [matchId, seq, seat, kind, JSON.stringify(payload)],
    );
  } catch (err) {
    logger.error({ err, matchId, kind }, 'could not record match event');
  }
}

export type EndReason = 'complete' | 'forfeit' | 'abandoned' | 'cancelled' | 'decision';

export async function persistMatchEnd(
  client: PoolClient,
  room: Room,
  state: GameState | null,
  reason: EndReason,
): Promise<void> {
  await client.query(
    `UPDATE matches
        SET status = $2, winner_color = $3, end_reason = $4,
            points = $5, turn_count = $6, ended_at = now()
      WHERE id = $1`,
    [
      room.matchId,
      reason === 'cancelled' ? 'cancelled' : 'finished',
      state?.winner ?? null,
      reason,
      state?.points ?? 0,
      state?.turnCount ?? 0,
    ],
  );

  for (const seat of room.seats) {
    const won = state?.winner ? seat.color === state.winner : null;
    await client.query(
      `UPDATE match_players
          SET pocketed = $3, fouls = $4, won = $5, left_early = $6
        WHERE match_id = $1 AND seat = $2`,
      [
        room.matchId,
        seat.seat,
        state?.players.find((p) => p.seat === seat.seat)?.pocketed ?? 0,
        seat.fouls,
        won,
        !seat.connected,
      ],
    );
  }
}

/**
 * Void a match that was recorded but never actually started, so a failed
 * sit-down does not leave a phantom "playing" row behind.
 */
export async function markMatchCancelled(matchId: string, reason: string): Promise<void> {
  await query(
    `UPDATE matches SET status = 'cancelled', end_reason = 'cancelled', ended_at = now()
      WHERE id = $1`,
    [matchId],
  ).catch((err) => logger.error({ err, matchId, reason }, 'could not cancel match row'));
}

/** Take every entry fee. If any seat cannot pay, everyone is refunded. */
export async function collectEntries(room: Room): Promise<{ ok: boolean; error?: string }> {
  // A tournament board takes nothing: the entry was paid at registration.
  if (!room.mode.staked || room.solo || room.tournamentMatchId || room.tier.entry <= 0) {
    return { ok: true };
  }

  try {
    await transaction(async (client) => {
      for (const seat of room.seats) {
        await moveCoins(client, {
          userId: seat.userId,
          delta: -room.tier.entry,
          reason: 'entry',
          matchId: room.matchId,
          note: room.tier.id,
        });
      }
    });
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ matchId: room.matchId, err: message }, 'could not collect entries');
    return { ok: false, error: 'Someone at the table cannot cover the entry.' };
  }
}

/** Hand every stake back, for a board that never properly started or was void. */
export async function refundEntries(client: PoolClient, room: Room): Promise<void> {
  if (!room.mode.staked || room.solo || room.tournamentMatchId || room.tier.entry <= 0) return;
  for (const seat of room.seats) {
    await moveCoins(client, {
      userId: seat.userId,
      delta: room.tier.entry,
      reason: 'refund',
      matchId: room.matchId,
      note: 'match voided',
    });
  }
}

export interface MatchHistoryRow {
  id: string;
  mode_id: string;
  tier_id: string;
  board_id: string;
  status: string;
  end_reason: string | null;
  winner_color: string | null;
  points: number;
  created_at: Date;
  won: boolean | null;
  pocketed: number;
  coins_delta: number | null;
  xp_gained: number | null;
  trophies_delta: number | null;
  opponents: string[];
}

export interface HistoryFilter {
  limit?: number;
  offset?: number;
  /** 'win' | 'loss' — omit for both. */
  outcome?: 'win' | 'loss';
  modeId?: string;
  tierId?: string;
  /** Only matches newer than this many days. */
  days?: number;
}

/**
 * A player's own match history, filtered.
 *
 * Every filter is a bound parameter with a NULL escape, so one query plan
 * serves every combination and no filter can be injected. Ordering is always
 * newest first — history read any other way is a report, not a history.
 */
export function matchHistory(userId: string, filter: HistoryFilter = {}): Promise<MatchHistoryRow[]> {
  return query<MatchHistoryRow>(
    `SELECT m.id, m.mode_id, m.tier_id, m.board_id, m.status, m.end_reason,
            m.winner_color, m.points, m.created_at,
            mp.won, mp.pocketed,
            mr.coins_delta, mr.xp_gained, mr.trophies_delta,
            ARRAY(
              SELECT u.username FROM match_players o
                JOIN users u ON u.id = o.user_id
               WHERE o.match_id = m.id AND o.user_id <> $1
            ) AS opponents
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       LEFT JOIN match_results mr ON mr.match_id = m.id AND mr.user_id = $1
      WHERE mp.user_id = $1
        AND ($4::boolean IS NULL OR mp.won = $4)
        AND ($5::text IS NULL OR m.mode_id = $5)
        AND ($6::text IS NULL OR m.tier_id = $6)
        AND ($7::int IS NULL OR m.created_at > now() - ($7 || ' days')::interval)
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3`,
    [
      userId,
      Math.min(filter.limit ?? 25, 100),
      filter.offset ?? 0,
      filter.outcome === undefined ? null : filter.outcome === 'win',
      filter.modeId ?? null,
      filter.tierId ?? null,
      filter.days ?? null,
    ],
  );
}

/** Totals for the same filter, so the header can describe what is shown. */
export async function matchHistorySummary(userId: string, filter: HistoryFilter = {}) {
  const rows = await query<{
    total: string; wins: string; coins: string | null; pocketed: string | null;
  }>(
    `SELECT COUNT(*)::text                                        AS total,
            COUNT(*) FILTER (WHERE mp.won)::text                  AS wins,
            COALESCE(SUM(mr.coins_delta), 0)::text                AS coins,
            COALESCE(SUM(mp.pocketed), 0)::text                   AS pocketed
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       LEFT JOIN match_results mr ON mr.match_id = m.id AND mr.user_id = $1
      WHERE mp.user_id = $1
        AND ($2::boolean IS NULL OR mp.won = $2)
        AND ($3::text IS NULL OR m.mode_id = $3)
        AND ($4::text IS NULL OR m.tier_id = $4)
        AND ($5::int IS NULL OR m.created_at > now() - ($5 || ' days')::interval)`,
    [
      userId,
      filter.outcome === undefined ? null : filter.outcome === 'win',
      filter.modeId ?? null,
      filter.tierId ?? null,
      filter.days ?? null,
    ],
  );

  const row = rows[0];
  const total = Number(row?.total ?? 0);
  const wins = Number(row?.wins ?? 0);
  return {
    total,
    wins,
    losses: total - wins,
    winRate: total > 0 ? wins / total : 0,
    coins: Number(row?.coins ?? 0),
    pocketed: Number(row?.pocketed ?? 0),
  };
}

export function matchReplay(matchId: string) {
  return query(
    `SELECT seq, seat, kind, payload, think_ms, server_time
       FROM match_events WHERE match_id = $1 ORDER BY seq`,
    [matchId],
  );
}
