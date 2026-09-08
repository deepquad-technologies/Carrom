import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DIVISIONS, SEASON_LENGTH_DAYS, divisionForRating, nextDivision, ratingDelta,
  resetRating, themeForSeason,
} from '@carrom/config';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { keyFor, once } from '../lib/idempotency.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { moveCoins } from './economy.js';
import { grantXp } from './progression.js';
import { logger } from '../lib/logger.js';

/**
 * Seasons and the ranked ladder.
 *
 * Ranked results move a season rating; the rating maps to a division. When a
 * season ends its leaderboard is frozen, positions are calculated, rewards are
 * paid once per player (idempotently), and ratings are pulled toward the middle
 * rather than wiped — so a strong player still starts ahead but has to re-earn
 * the top.
 */
export const seasonRouter = Router();

export interface SeasonRow {
  id: string;
  number: number;
  name: string;
  theme_id: string;
  starts_at: Date;
  ends_at: Date;
  status: 'upcoming' | 'active' | 'frozen' | 'settled';
}

export async function activeSeason(): Promise<SeasonRow | null> {
  return one<SeasonRow>(
    `SELECT id, number, name, theme_id, starts_at, ends_at, status
       FROM seasons WHERE status = 'active' LIMIT 1`,
  );
}

/** Start the next season if none is running. Safe to call on every boot. */
export async function ensureSeason(): Promise<SeasonRow> {
  const current = await activeSeason();
  if (current) return current;

  return transaction(async (client) => {
    // Re-check inside the transaction; two nodes may boot together.
    const existing = await client.query<SeasonRow>(
      `SELECT id, number, name, theme_id, starts_at, ends_at, status
         FROM seasons WHERE status = 'active' LIMIT 1`,
    );
    if (existing.rows[0]) return existing.rows[0];

    const last = await client.query<{ number: number }>(
      'SELECT COALESCE(MAX(number), 0) AS number FROM seasons',
    );
    const number = Number(last.rows[0]?.number ?? 0) + 1;
    const theme = themeForSeason(number);
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + SEASON_LENGTH_DAYS * 86_400_000);

    const created = await client.query<SeasonRow>(
      `INSERT INTO seasons (number, name, theme_id, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       RETURNING id, number, name, theme_id, starts_at, ends_at, status`,
      [number, `Season ${number}: ${theme.name}`, theme.id, startsAt, endsAt],
    );

    logger.info({ number, theme: theme.id }, 'season started');
    return created.rows[0];
  });
}

/** A player's row for the current season, created on first ranked match. */
export async function ensureSeasonPlayer(
  client: PoolClient,
  seasonId: string,
  userId: string,
): Promise<{ rating: number; wins: number; losses: number }> {
  const existing = await client.query<{ rating: number; wins: number; losses: number }>(
    'SELECT rating, wins, losses FROM season_players WHERE season_id = $1 AND user_id = $2',
    [seasonId, userId],
  );
  if (existing.rows[0]) return existing.rows[0];

  // Carry a fraction of last season's rating into this one.
  const previous = await client.query<{ rating: number }>(
    `SELECT sp.rating FROM season_players sp
       JOIN seasons s ON s.id = sp.season_id
      WHERE sp.user_id = $1 AND s.status = 'settled'
      ORDER BY s.number DESC LIMIT 1`,
    [userId],
  );
  const seed = previous.rows[0] ? resetRating(previous.rows[0].rating) : 0;

  const created = await client.query<{ rating: number; wins: number; losses: number }>(
    `INSERT INTO season_players (season_id, user_id, rating, peak_rating, division)
     VALUES ($1,$2,$3,$3,$4)
     ON CONFLICT (season_id, user_id) DO UPDATE SET rating = season_players.rating
     RETURNING rating, wins, losses`,
    [seasonId, userId, seed, divisionForRating(seed).id],
  );
  return created.rows[0];
}

export interface RankedOutcome {
  before: number;
  after: number;
  delta: number;
  divisionBefore: string;
  divisionAfter: string;
  promoted: boolean;
  demoted: boolean;
}

/** Apply a ranked result. Called from match settlement, inside its transaction. */
export async function applyRankedResult(
  client: PoolClient,
  seasonId: string,
  userId: string,
  opponentRating: number,
  won: boolean,
  xpGained: number,
): Promise<RankedOutcome> {
  const player = await ensureSeasonPlayer(client, seasonId, userId);
  const games = player.wins + player.losses;

  const delta = ratingDelta(player.rating, opponentRating, won, games);
  const after = Math.max(0, player.rating + delta);

  const divisionBefore = divisionForRating(player.rating);
  const divisionAfter = divisionForRating(after);

  await client.query(
    `UPDATE season_players SET
       rating = $3,
       peak_rating = GREATEST(peak_rating, $3),
       division = $4,
       wins = wins + $5,
       losses = losses + $6,
       xp = xp + $7
     WHERE season_id = $1 AND user_id = $2`,
    [seasonId, userId, after, divisionAfter.id, won ? 1 : 0, won ? 0 : 1, xpGained],
  );

  return {
    before: player.rating,
    after,
    delta,
    divisionBefore: divisionBefore.id,
    divisionAfter: divisionAfter.id,
    promoted: divisionAfter.minRating > divisionBefore.minRating,
    demoted: divisionAfter.minRating < divisionBefore.minRating,
  };
}

export async function seasonRatingOf(seasonId: string, userId: string): Promise<number> {
  const row = await one<{ rating: number }>(
    'SELECT rating FROM season_players WHERE season_id = $1 AND user_id = $2',
    [seasonId, userId],
  );
  return row?.rating ?? 0;
}

/* --------------------------------- settling -------------------------------- */

/**
 * Freeze a season, rank everyone, pay out and open the next one. Rewards are
 * keyed per player so a retried or concurrent settlement pays nobody twice.
 */
/**
 * Settle a season: pay out placements, then roll into the next one.
 *
 * A season that has not reached its end date is refused unless `force` is
 * given. Settling early is not a small mistake — it pays every placement
 * reward, freezes the standings and resets everybody's rating partway through
 * a competition, and it cannot be undone. An operator who genuinely means to
 * cut a season short has to say so.
 */
export async function settleSeason(
  seasonId: string,
  force = false,
): Promise<{ players: number; paid: number; early: boolean }> {
  const season = await one<SeasonRow>(
    'SELECT id, number, name, theme_id, starts_at, ends_at, status FROM seasons WHERE id = $1',
    [seasonId],
  );
  if (!season) throw notFound('No such season');
  if (season.status === 'settled') throw conflict('That season is already settled');

  const ended = new Date(season.ends_at).getTime() <= Date.now();
  if (!ended && !force) {
    throw conflict(
      `${season.name} runs until ${new Date(season.ends_at).toISOString()}. ` +
        'Settling it now would pay every placement reward and reset all ratings. ' +
        'Pass force to do it anyway.',
      'season_still_running',
    );
  }
  if (!ended) {
    logger.warn(
      { seasonId, endsAt: season.ends_at },
      'season settled before its end date, by explicit force',
    );
  }

  await query(`UPDATE seasons SET status = 'frozen' WHERE id = $1`, [seasonId]);

  const standings = await query<{ user_id: string; rating: number; division: string }>(
    `SELECT user_id, rating, division FROM season_players
      WHERE season_id = $1 ORDER BY rating DESC, wins DESC`,
    [seasonId],
  );

  let paid = 0;
  for (let index = 0; index < standings.length; index++) {
    const player = standings[index];
    const position = index + 1;
    const division = DIVISIONS.find((d) => d.id === player.division) ?? DIVISIONS[0];

    const outcome = await once(
      keyFor.seasonReward(seasonId, player.user_id),
      'season_reward',
      player.user_id,
      async (client) => {
        // Top three get a share on top of their division reward.
        const placementBonus = position === 1 ? 3 : position === 2 ? 2 : position === 3 ? 1.5 : 1;
        const coins = Math.round(division.seasonCoins * placementBonus);

        await moveCoins(client, {
          userId: player.user_id,
          delta: coins,
          reason: 'tournament',
          note: `${season.name} · ${division.name} · #${position}`,
        });
        await grantXp(client, player.user_id, Math.round(coins / 20));

        if (division.seasonCrate) {
          await client.query(
            `INSERT INTO crates (user_id, kind, tier_entry, source) VALUES ($1,$2,$3,'tournament')`,
            [player.user_id, division.seasonCrate, 5_000],
          );
        }

        await client.query(
          `UPDATE season_players SET final_position = $3, rewarded_at = now()
            WHERE season_id = $1 AND user_id = $2`,
          [seasonId, player.user_id, position],
        );

        await client.query(
          `INSERT INTO notifications (user_id, kind, title, body, data)
           VALUES ($1,'season',$2,$3,$4)`,
          [
            player.user_id,
            `${season.name} finished`,
            `You placed #${position} in ${division.name}.`,
            JSON.stringify({ seasonId, position, division: division.id, coins }),
          ],
        );

        return { coins, position, division: division.id };
      },
    );

    if (outcome.fresh) paid++;
  }

  await query(`UPDATE seasons SET status = 'settled', settled_at = now() WHERE id = $1`, [seasonId]);
  const next = await ensureSeason();

  logger.info(
    { seasonId, players: standings.length, paid, nextSeason: next.number },
    'season settled',
  );
  return { players: standings.length, paid, early: !ended };
}

/** Called from the housekeeping tick. */
export async function settleExpiredSeasons(): Promise<void> {
  const expired = await query<{ id: string }>(
    `SELECT id FROM seasons WHERE status = 'active' AND ends_at <= now()`,
  );
  for (const season of expired) {
    await settleSeason(season.id).catch((err) =>
      logger.error({ err, seasonId: season.id }, 'season settlement failed'),
    );
  }
}

/* ---------------------------------- routes --------------------------------- */

seasonRouter.get(
  '/current',
  requireAuth,
  route(async (req, res) => {
    const season = await ensureSeason();
    const theme = themeForSeason(season.number);

    const mine = await one<{ rating: number; wins: number; losses: number; division: string; peak_rating: number }>(
      `SELECT rating, wins, losses, division, peak_rating
         FROM season_players WHERE season_id = $1 AND user_id = $2`,
      [season.id, req.auth!.sub],
    );

    const rating = mine?.rating ?? 0;
    const division = divisionForRating(rating);
    const next = nextDivision(rating);

    const position = await one<{ position: string }>(
      'SELECT COUNT(*) + 1 AS position FROM season_players WHERE season_id = $1 AND rating > $2',
      [season.id, rating],
    );

    res.json({
      season: {
        id: season.id,
        number: season.number,
        name: season.name,
        theme,
        startsAt: season.starts_at,
        endsAt: season.ends_at,
        daysLeft: Math.max(
          0,
          Math.ceil((season.ends_at.getTime() - Date.now()) / 86_400_000),
        ),
      },
      me: {
        rating,
        peakRating: mine?.peak_rating ?? 0,
        wins: mine?.wins ?? 0,
        losses: mine?.losses ?? 0,
        division,
        nextDivision: next,
        toNextDivision: next ? Math.max(0, next.minRating - rating) : 0,
        position: position ? Number(position.position) : null,
      },
      divisions: DIVISIONS,
    });
  }),
);

seasonRouter.get(
  '/leaderboard',
  requireAuth,
  route(async (req, res) => {
    const limit = z.coerce.number().min(1).max(100).default(50).parse(req.query.limit);
    const season = await ensureSeason();

    const rows = await query(
      `SELECT sp.user_id, sp.rating, sp.division, sp.wins, sp.losses,
              u.username, p.display_name, p.avatar_url, p.level, p.title_id
         FROM season_players sp
         JOIN users u ON u.id = sp.user_id
         JOIN profiles p ON p.user_id = sp.user_id
        WHERE sp.season_id = $1 AND NOT u.is_guest
        ORDER BY sp.rating DESC, sp.wins DESC
        LIMIT $2`,
      [season.id, limit],
    );

    res.json({
      season: { id: season.id, name: season.name, endsAt: season.ends_at },
      rows: rows.map((row, index) => ({ ...row, position: index + 1 })),
    });
  }),
);

seasonRouter.get(
  '/history',
  requireAuth,
  route(async (req, res) => {
    const rows = await query(
      `SELECT s.number, s.name, s.theme_id, s.ends_at,
              sp.rating, sp.peak_rating, sp.division, sp.wins, sp.losses, sp.final_position
         FROM season_players sp
         JOIN seasons s ON s.id = sp.season_id
        WHERE sp.user_id = $1 AND s.status = 'settled'
        ORDER BY s.number DESC LIMIT 20`,
      [req.auth!.sub],
    );
    res.json({ seasons: rows });
  }),
);

seasonRouter.post(
  '/:id/settle',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    // Cutting a season short is deliberate, explicit, and logged as such.
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});

    const result = await settleSeason(id, force);
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
       VALUES ($1,'season.settle','season',$2,$3)`,
      [req.auth!.sub, id, JSON.stringify({ ...result, force })],
    );
    res.json({ ok: true, ...result });
  }),
);
