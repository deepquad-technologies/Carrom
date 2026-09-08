import type { PoolClient } from 'pg';
import { computeFairPlay, fairPlayBand, matchmakingToleranceFor } from '@carrom/config';
import { one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Fair Play Score.
 *
 * A single 0-100 number derived from recorded behaviour: abandoned matches,
 * repeated disconnects, upheld reports and confirmed cheating pull it down;
 * finishing matches cleanly pulls it back up. It is deliberately recoverable —
 * a player who had a bad month can climb out — and it is never used to punish
 * on its own. Its one gameplay effect is matchmaking: players in poor standing
 * are preferentially matched with each other.
 */
export type FairPlayEvent =
  | 'abandon'
  | 'disconnect'
  | 'upheld_report'
  | 'confirmed_cheating'
  | 'clean_match';

const COLUMN: Record<FairPlayEvent, string> = {
  abandon: 'abandons',
  disconnect: 'disconnects',
  upheld_report: 'upheld_reports',
  confirmed_cheating: 'confirmed_cheating',
  clean_match: 'clean_matches',
};

interface FairPlayRow {
  score: number;
  abandons: number;
  disconnects: number;
  upheld_reports: number;
  confirmed_cheating: number;
  clean_matches: number;
}

async function ensureRow(client: PoolClient, userId: string): Promise<void> {
  await client.query('INSERT INTO fair_play (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

/** Record a behaviour event and recompute the score in the same transaction. */
export async function recordFairPlay(
  client: PoolClient,
  userId: string,
  event: FairPlayEvent,
  amount = 1,
): Promise<number> {
  await ensureRow(client, userId);

  const column = COLUMN[event];
  const updated = await client.query<FairPlayRow>(
    `UPDATE fair_play
        SET ${column} = ${column} + $2, computed_at = now()
      WHERE user_id = $1
      RETURNING score, abandons, disconnects, upheld_reports, confirmed_cheating, clean_matches`,
    [userId, amount],
  );

  const row = updated.rows[0];
  if (!row) return 100;

  const score = computeFairPlay({
    abandons: row.abandons,
    disconnects: row.disconnects,
    upheldReports: row.upheld_reports,
    confirmedCheating: row.confirmed_cheating,
    cleanMatches: row.clean_matches,
  });

  await client.query('UPDATE fair_play SET score = $2 WHERE user_id = $1', [userId, score]);
  return score;
}

export async function fairPlayFor(userId: string) {
  const row = await one<FairPlayRow>(
    `SELECT score, abandons, disconnects, upheld_reports, confirmed_cheating, clean_matches
       FROM fair_play WHERE user_id = $1`,
    [userId],
  );

  const score = row?.score ?? 100;
  const band = fairPlayBand(score);

  return {
    score,
    band: band.id,
    bandName: band.name,
    color: band.color,
    counters: {
      abandons: row?.abandons ?? 0,
      disconnects: row?.disconnects ?? 0,
      upheldReports: row?.upheld_reports ?? 0,
      confirmedCheating: row?.confirmed_cheating ?? 0,
      cleanMatches: row?.clean_matches ?? 0,
    },
    /** How much of the normal matchmaking pool this player can be paired with. */
    matchmakingTolerance: matchmakingToleranceFor(score),
    explanation:
      score >= 85
        ? 'You finish your matches and play fairly. Nothing to worry about.'
        : score >= 65
          ? 'Mostly clean. Finishing matches will bring this up.'
          : score >= 40
            ? 'Abandoned matches or reports have brought this down. It recovers as you play through matches.'
            : 'This account is in poor standing and is matched with similar players.',
  };
}

export async function fairPlayScore(userId: string): Promise<number> {
  const row = await one<{ score: number }>('SELECT score FROM fair_play WHERE user_id = $1', [userId]);
  return row?.score ?? 100;
}

/** Bulk read, so matchmaking does not issue one query per queued player. */
export async function fairPlayScores(userIds: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (userIds.length === 0) return scores;

  const rows = await query<{ user_id: string; score: number }>(
    'SELECT user_id, score FROM fair_play WHERE user_id = ANY($1::uuid[])',
    [userIds],
  );
  for (const row of rows) scores.set(row.user_id, row.score);
  for (const userId of userIds) {
    if (!scores.has(userId)) scores.set(userId, 100);
  }
  return scores;
}

/**
 * Called when a moderator upholds a report, so the decision feeds back into
 * matchmaking rather than only into the ban list.
 */
export async function applyModerationOutcome(
  client: PoolClient,
  userId: string,
  resolution: 'ban' | 'warn' | 'no_action' | 'duplicate',
  category: string,
): Promise<void> {
  if (resolution === 'no_action' || resolution === 'duplicate') return;

  const event: FairPlayEvent =
    resolution === 'ban' && (category === 'cheating' || category === 'bot')
      ? 'confirmed_cheating'
      : 'upheld_report';

  const score = await recordFairPlay(client, userId, event);
  logger.info({ userId, resolution, category, score }, 'fair play adjusted by moderation');
}
