import { Router } from 'express';
import { z } from 'zod';
import { MATCH_TIERS, TIMERS, tierById } from '@carrom/config';
import { boardById } from '@carrom/content';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { moveCoins } from './economy.js';
import { grantXp } from './progression.js';
import { logger } from '../lib/logger.js';

/**
 * Single-elimination tournaments. Entry and prizes are virtual coins and
 * cosmetics; nothing here touches real money.
 *
 * The bracket is generated once when registration closes: players are seeded by
 * trophies, byes fill the top seeds when the field is not a power of two, and
 * each finished match promotes its winner into the next round.
 */
export const tournamentRouter = Router();

interface TournamentRow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'registration' | 'running' | 'finished' | 'cancelled';
  entry_coins: number;
  prize_pool: number;
  prize_crate: string | null;
  max_players: number;
  tier_id: string;
  board_id: string;
  timer_preset: string;
  min_level: number;
  starts_at: Date;
  winner_user_id: string | null;
}

tournamentRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const rows = await query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM tournament_players tp WHERE tp.tournament_id = t.id) AS registered,
              EXISTS (SELECT 1 FROM tournament_players tp
                       WHERE tp.tournament_id = t.id AND tp.user_id = $1) AS joined
         FROM tournaments t
        WHERE t.status IN ('registration','running','finished')
        ORDER BY
          CASE t.status WHEN 'running' THEN 0 WHEN 'registration' THEN 1 ELSE 2 END,
          t.starts_at DESC
        LIMIT 40`,
      [req.auth!.sub],
    );
    res.json({ tournaments: rows, notice: 'Entry and prizes are virtual coins only.' });
  }),
);

tournamentRouter.get(
  '/:id',
  requireAuth,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const tournament = await one<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [id]);
    if (!tournament) throw notFound('No such tournament');

    const [players, matches] = await Promise.all([
      query(
        `SELECT tp.user_id, tp.seed, tp.final_position, tp.eliminated_in, tp.points,
                u.username, p.display_name, p.avatar_url, p.level, p.trophies
           FROM tournament_players tp
           JOIN users u ON u.id = tp.user_id
           JOIN profiles p ON p.user_id = tp.user_id
          WHERE tp.tournament_id = $1
          ORDER BY tp.seed NULLS LAST, tp.registered_at`,
        [id],
      ),
      query(
        `SELECT tm.id, tm.round, tm.slot, tm.status, tm.player_a, tm.player_b,
                tm.winner_id, tm.match_id,
                ua.username AS player_a_name, ub.username AS player_b_name
           FROM tournament_matches tm
           LEFT JOIN users ua ON ua.id = tm.player_a
           LEFT JOIN users ub ON ub.id = tm.player_b
          WHERE tm.tournament_id = $1
          ORDER BY tm.round, tm.slot`,
        [id],
      ),
    ]);

    res.json({ tournament, players, matches, rounds: roundsFor(tournament.max_players) });
  }),
);

function roundsFor(size: number): number {
  return Math.ceil(Math.log2(size));
}

tournamentRouter.post(
  '/:id/register',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const userId = req.auth!.sub;

    const result = await transaction(async (client) => {
      const row = await client.query<TournamentRow>(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const tournament = row.rows[0];
      if (!tournament) throw notFound('No such tournament');
      if (tournament.status !== 'registration') {
        throw conflict('Registration is closed', 'registration_closed');
      }

      const already = await client.query(
        'SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND user_id = $2',
        [id, userId],
      );
      if (already.rowCount) throw conflict('You are already registered', 'already_registered');

      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tournament_players WHERE tournament_id = $1',
        [id],
      );
      if (Number(count.rows[0].count) >= tournament.max_players) {
        throw conflict('That tournament is full', 'tournament_full');
      }

      const profile = await client.query<{ level: number }>(
        'SELECT level FROM profiles WHERE user_id = $1',
        [userId],
      );
      if ((profile.rows[0]?.level ?? 1) < tournament.min_level) {
        throw conflict(`Reach level ${tournament.min_level} to enter`, 'level_locked');
      }

      let balance: number | undefined;
      if (Number(tournament.entry_coins) > 0) {
        balance = await moveCoins(client, {
          userId,
          delta: -Number(tournament.entry_coins),
          reason: 'tournament',
          note: tournament.name,
        });
        await client.query(
          'UPDATE tournaments SET prize_pool = prize_pool + $2 WHERE id = $1',
          [id, Number(tournament.entry_coins)],
        );
      }

      await client.query(
        'INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1,$2)',
        [id, userId],
      );

      return { balance, registered: Number(count.rows[0].count) + 1 };
    });

    res.json({ ok: true, ...result });
  }),
);

tournamentRouter.post(
  '/:id/withdraw',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const userId = req.auth!.sub;

    const balance = await transaction(async (client) => {
      const row = await client.query<TournamentRow>(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const tournament = row.rows[0];
      if (!tournament) throw notFound('No such tournament');
      if (tournament.status !== 'registration') {
        throw conflict('You can only withdraw before it starts', 'already_started');
      }

      const removed = await client.query(
        'DELETE FROM tournament_players WHERE tournament_id = $1 AND user_id = $2 RETURNING user_id',
        [id, userId],
      );
      if (removed.rowCount === 0) throw notFound('You are not registered');

      if (Number(tournament.entry_coins) > 0) {
        await client.query(
          'UPDATE tournaments SET prize_pool = GREATEST(0, prize_pool - $2) WHERE id = $1',
          [id, Number(tournament.entry_coins)],
        );
        return moveCoins(client, {
          userId,
          delta: Number(tournament.entry_coins),
          reason: 'refund',
          note: `${tournament.name} withdrawal`,
        });
      }
      return undefined;
    });

    res.json({ ok: true, balance });
  }),
);

/**
 * Close registration and build the bracket. Seeds are by trophies, and byes go
 * to the top seeds so the field collapses to a power of two in round one.
 */
export async function startTournament(tournamentId: string): Promise<void> {
  await transaction(async (client) => {
    const row = await client.query<TournamentRow>(
      'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId],
    );
    const tournament = row.rows[0];
    if (!tournament) throw notFound('No such tournament');
    if (tournament.status !== 'registration') throw conflict('Not in registration');

    const players = await client.query<{ user_id: string; trophies: number }>(
      `SELECT tp.user_id, p.trophies
         FROM tournament_players tp JOIN profiles p ON p.user_id = tp.user_id
        WHERE tp.tournament_id = $1
        ORDER BY p.trophies DESC`,
      [tournamentId],
    );

    if (players.rows.length < 2) throw badRequest('Not enough players to start');

    const seeded = players.rows;
    for (let i = 0; i < seeded.length; i++) {
      await client.query(
        'UPDATE tournament_players SET seed = $3 WHERE tournament_id = $1 AND user_id = $2',
        [tournamentId, seeded[i].user_id, i + 1],
      );
    }

    const bracketSize = 2 ** Math.ceil(Math.log2(seeded.length));
    const byes = bracketSize - seeded.length;

    // Round 1: the top `byes` seeds advance automatically.
    const firstRound: Array<{ a: string | null; b: string | null }> = [];
    const contenders = seeded.slice(byes);
    for (let i = 0; i < byes; i++) {
      firstRound.push({ a: seeded[i].user_id, b: null });
    }
    for (let i = 0; i < contenders.length; i += 2) {
      firstRound.push({
        a: contenders[i]?.user_id ?? null,
        b: contenders[i + 1]?.user_id ?? null,
      });
    }

    for (let slot = 0; slot < firstRound.length; slot++) {
      const pair = firstRound[slot];
      const isBye = pair.b === null;
      await client.query(
        `INSERT INTO tournament_matches
           (tournament_id, round, slot, player_a, player_b, status, winner_id)
         VALUES ($1,1,$2,$3,$4,$5,$6)`,
        [
          tournamentId,
          slot,
          pair.a,
          pair.b,
          isBye ? 'bye' : 'ready',
          isBye ? pair.a : null,
        ],
      );
    }

    // Empty shells for every later round, filled in as winners arrive.
    let slots = firstRound.length;
    let round = 2;
    while (slots > 1) {
      slots = Math.ceil(slots / 2);
      for (let slot = 0; slot < slots; slot++) {
        await client.query(
          `INSERT INTO tournament_matches (tournament_id, round, slot, status)
           VALUES ($1,$2,$3,'pending')`,
          [tournamentId, round, slot],
        );
      }
      round++;
    }

    await client.query(
      `UPDATE tournaments SET status = 'running' WHERE id = $1`,
      [tournamentId],
    );
  });

  await promoteByes(tournamentId);
  logger.info({ tournamentId }, 'tournament bracket created');
}

/** Move automatic winners into the next round as soon as the bracket exists. */
async function promoteByes(tournamentId: string): Promise<void> {
  const byes = await query<{ round: number; slot: number; winner_id: string }>(
    `SELECT round, slot, winner_id FROM tournament_matches
      WHERE tournament_id = $1 AND status = 'bye' AND winner_id IS NOT NULL`,
    [tournamentId],
  );
  for (const bye of byes) {
    await advanceWinner(tournamentId, bye.round, bye.slot, bye.winner_id);
  }
}

/** Place a winner into their next-round slot, and open that match when full. */
export async function advanceWinner(
  tournamentId: string,
  round: number,
  slot: number,
  winnerId: string,
): Promise<void> {
  const nextRound = round + 1;
  const nextSlot = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? 'player_a' : 'player_b';

  const next = await one<{ id: string; player_a: string | null; player_b: string | null }>(
    'SELECT id, player_a, player_b FROM tournament_matches WHERE tournament_id = $1 AND round = $2 AND slot = $3',
    [tournamentId, nextRound, nextSlot],
  );

  if (!next) {
    // No next round: this was the final.
    await finishTournament(tournamentId, winnerId);
    return;
  }

  await query(
    `UPDATE tournament_matches SET ${side} = $4 WHERE tournament_id = $1 AND round = $2 AND slot = $3`,
    [tournamentId, nextRound, nextSlot, winnerId],
  );

  const filled = await one<{ player_a: string | null; player_b: string | null }>(
    'SELECT player_a, player_b FROM tournament_matches WHERE tournament_id = $1 AND round = $2 AND slot = $3',
    [tournamentId, nextRound, nextSlot],
  );
  if (filled?.player_a && filled?.player_b) {
    await query(
      `UPDATE tournament_matches SET status = 'ready'
        WHERE tournament_id = $1 AND round = $2 AND slot = $3`,
      [tournamentId, nextRound, nextSlot],
    );
  }
}

/**
 * Bracket matches waiting to be played.
 *
 * A pairing becomes playable once both sides are known. The gateway polls this
 * and seats the two players when they are both connected — the tournament does
 * not wait on anybody clicking "ready", because a bracket that stalls on one
 * absent player is a bracket that never finishes.
 */
export interface PlayableTournamentMatch {
  id: string;
  tournamentId: string;
  tournamentName: string;
  round: number;
  slot: number;
  playerA: string;
  playerB: string;
  tierId: string;
  boardId: string;
  timerPreset: string;
}

export async function playableMatches(): Promise<PlayableTournamentMatch[]> {
  const rows = await query<{
    id: string; tournament_id: string; name: string; round: number; slot: number;
    player_a: string; player_b: string; tier_id: string; board_id: string; timer_preset: string;
  }>(
    `SELECT tm.id, tm.tournament_id, t.name, tm.round, tm.slot,
            tm.player_a, tm.player_b, t.tier_id, t.board_id, t.timer_preset
       FROM tournament_matches tm
       JOIN tournaments t ON t.id = tm.tournament_id
      WHERE t.status = 'running'
        AND tm.status = 'ready'
        AND tm.player_a IS NOT NULL
        AND tm.player_b IS NOT NULL
      ORDER BY tm.round, tm.slot
      LIMIT 20`,
  );

  return rows.map((row) => ({
    id: row.id,
    tournamentId: row.tournament_id,
    tournamentName: row.name,
    round: row.round,
    slot: row.slot,
    playerA: row.player_a,
    playerB: row.player_b,
    tierId: row.tier_id,
    boardId: row.board_id,
    timerPreset: row.timer_preset,
  }));
}

/**
 * Claim a bracket match for play.
 *
 * The status guard is what stops two nodes seating the same pairing twice: only
 * the update that moves it out of 'ready' returns a row.
 */
export async function claimForPlay(tournamentMatchId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `UPDATE tournament_matches SET status = 'running'
      WHERE id = $1 AND status = 'ready'
      RETURNING id`,
    [tournamentMatchId],
  );
  return Boolean(row);
}

/** Hand a claimed match back if it could not actually be seated. */
export async function releaseClaim(tournamentMatchId: string): Promise<void> {
  await query(
    `UPDATE tournament_matches SET status = 'ready'
      WHERE id = $1 AND status = 'running' AND winner_id IS NULL`,
    [tournamentMatchId],
  );
}

/** Called when a tournament match finishes in the game gateway. */
export async function reportTournamentResult(
  tournamentMatchId: string,
  winnerId: string,
  matchId: string,
): Promise<void> {
  const row = await one<{ tournament_id: string; round: number; slot: number; player_a: string | null; player_b: string | null }>(
    `UPDATE tournament_matches
        SET winner_id = $2, match_id = $3, status = 'finished', finished_at = now()
      WHERE id = $1 AND status IN ('ready','running')
      RETURNING tournament_id, round, slot, player_a, player_b`,
    [tournamentMatchId, winnerId, matchId],
  );
  if (!row) return;

  const loser = row.player_a === winnerId ? row.player_b : row.player_a;
  if (loser) {
    await query(
      `UPDATE tournament_players SET eliminated_in = $3, points = points + $4
        WHERE tournament_id = $1 AND user_id = $2`,
      [row.tournament_id, loser, row.round, row.round * 10],
    );
  }
  await query(
    `UPDATE tournament_players SET points = points + $3
      WHERE tournament_id = $1 AND user_id = $2`,
    [row.tournament_id, winnerId, row.round * 15],
  );

  await advanceWinner(row.tournament_id, row.round, row.slot, winnerId);
}

async function finishTournament(tournamentId: string, winnerId: string): Promise<void> {
  await transaction(async (client) => {
    const row = await client.query<TournamentRow>(
      `SELECT * FROM tournaments WHERE id = $1 AND status = 'running' FOR UPDATE`,
      [tournamentId],
    );
    const tournament = row.rows[0];
    if (!tournament) return;

    const prize = Number(tournament.prize_pool);
    if (prize > 0) {
      await moveCoins(client, {
        userId: winnerId,
        delta: prize,
        reason: 'tournament',
        note: `${tournament.name} winner`,
      });
    }
    if (tournament.prize_crate) {
      await client.query(
        `INSERT INTO crates (user_id, kind, tier_entry, source)
         VALUES ($1,$2,$3,'tournament')`,
        [winnerId, tournament.prize_crate, Number(tournament.entry_coins) || 1_000],
      );
    }

    await grantXp(client, winnerId, 1_000);
    await client.query(
      `UPDATE profiles SET tournament_wins = tournament_wins + 1,
                           tournament_points = tournament_points + 100
        WHERE user_id = $1`,
      [winnerId],
    );
    await client.query(
      'UPDATE tournament_players SET final_position = 1 WHERE tournament_id = $1 AND user_id = $2',
      [tournamentId, winnerId],
    );
    await client.query(
      `UPDATE tournaments SET status = 'finished', winner_user_id = $2, finished_at = now()
        WHERE id = $1`,
      [tournamentId, winnerId],
    );
    await client.query(
      `INSERT INTO notifications (user_id, kind, title, body, data)
       VALUES ($1,'tournament','Tournament won',$2,$3)`,
      [winnerId, `You won ${tournament.name}`, JSON.stringify({ tournamentId, prize })],
    );
  });

  logger.info({ tournamentId, winnerId }, 'tournament finished');
}

/* ----------------------------- admin management ---------------------------- */

tournamentRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(3).max(80),
        description: z.string().max(500).default(''),
        entryCoins: z.number().int().min(0).max(1_000_000).default(1_000),
        maxPlayers: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]),
        tierId: z.string().default(MATCH_TIERS[0].id),
        boardId: z.string().default('royal_gold'),
        timerPreset: z.enum(['quick', 'classic', 'pro', 'tournament']).default('tournament'),
        minLevel: z.number().int().min(1).max(60).default(1),
        prizeCrate: z.enum(['rookie', 'champion', 'legendary']).optional(),
        startsAt: z.string().datetime(),
      })
      .parse(req.body);

    if (!tierById(body.tierId)) throw badRequest('Unknown tier');
    if (!TIMERS[body.timerPreset]) throw badRequest('Unknown timer');

    const row = await one<{ id: string }>(
      `INSERT INTO tournaments
         (name, description, status, entry_coins, max_players, tier_id, board_id,
          timer_preset, min_level, prize_crate, starts_at, created_by)
       VALUES ($1,$2,'registration',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        body.name,
        body.description,
        body.entryCoins,
        body.maxPlayers,
        body.tierId,
        boardById(body.boardId).id,
        body.timerPreset,
        body.minLevel,
        body.prizeCrate ?? null,
        new Date(body.startsAt),
        req.auth!.sub,
      ],
    );

    res.status(201).json({ ok: true, tournamentId: row?.id });
  }),
);

tournamentRouter.post(
  '/:id/start',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await startTournament(id);
    res.json({ ok: true });
  }),
);

tournamentRouter.post(
  '/:id/cancel',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    await transaction(async (client) => {
      const row = await client.query<TournamentRow>(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const tournament = row.rows[0];
      if (!tournament) throw notFound('No such tournament');
      if (tournament.status === 'finished') throw conflict('That tournament already finished');

      // Cancelling always returns every entry.
      if (Number(tournament.entry_coins) > 0) {
        const players = await client.query<{ user_id: string }>(
          'SELECT user_id FROM tournament_players WHERE tournament_id = $1',
          [id],
        );
        for (const player of players.rows) {
          await moveCoins(client, {
            userId: player.user_id,
            delta: Number(tournament.entry_coins),
            reason: 'refund',
            note: `${tournament.name} cancelled`,
          });
        }
      }

      await client.query(
        `UPDATE tournaments SET status = 'cancelled', prize_pool = 0 WHERE id = $1`,
        [id],
      );
    });

    res.json({ ok: true });
  }),
);
