import { STREAK_REWARDS, XP_REWARDS, payout } from '@carrom/config';
import { CRATE_TYPES } from '@carrom/content';
import { isPerfectGame } from '@carrom/game-engine';
import type { Color, GameState, MatchResult, PlayerReward } from '@carrom/types';
import { transaction } from '../db/pool.js';
import { moveCoins } from '../features/economy.js';
import { advanceMissions, evaluateAchievements, grantTrophies, grantXp } from '../features/progression.js';
import { awardCrate } from '../features/crates.js';
import { eventMultipliers } from '../features/events.js';
import { addPassXp } from '../features/pass.js';
import { logger } from '../lib/logger.js';
import { reviewWinRate } from './antiCheat.js';
import { recordFairPlay } from '../features/fairplay.js';
import {
  activeSeason, applyRankedResult, seasonRatingOf, type RankedOutcome,
} from '../features/seasons.js';
import { persistMatchEnd, refundEntries, type EndReason } from './matches.js';
import type { Room } from './rooms.js';

/**
 * Settle a finished board: pay the pot, move trophies and XP, update the
 * career record, drop a crate, then re-check achievements and missions.
 *
 * The whole settlement is one transaction, so a player can never be charged an
 * entry without the board being recorded, or credited twice for one win.
 */
export async function settleMatch(
  room: Room,
  reason: EndReason,
  forcedWinner: Color | null = null,
): Promise<MatchResult> {
  const state = room.state;
  const winner = forcedWinner ?? state?.winner ?? null;

  if (room.settled) {
    return {
      matchId: room.matchId,
      winner,
      points: state?.points ?? 0,
      pot: state?.pot ?? 0,
      perPlayer: 0,
      reason: reason === 'decision' ? 'complete' : reason,
      rewards: {},
    };
  }
  room.settled = true;

  const staked = room.mode.staked && !room.solo && room.tier.entry > 0;
  const rewards: Record<string, PlayerReward> = {};

  // A drawn or voided board returns every stake and changes nothing else.
  if (winner === null || reason === 'cancelled') {
    await transaction(async (client) => {
      await refundEntries(client, room);
      await persistMatchEnd(client, room, state, reason);
    });
    for (const seat of room.seats) {
      rewards[seat.userId] = {
        userId: seat.userId,
        won: false,
        coins: 0,
        xp: 0,
        trophies: 0,
        levelBefore: seat.level,
        levelAfter: seat.level,
        crateId: null,
        crateKind: null,
        achievements: [],
        streak: 0,
        balance: seat.balanceBefore,
        note: reason === 'cancelled' ? 'Match cancelled, stake returned' : 'Draw, stake returned',
      };
    }
    return {
      matchId: room.matchId,
      winner: null,
      points: 0,
      pot: state?.pot ?? 0,
      perPlayer: 0,
      reason: reason === 'decision' ? 'complete' : reason,
      rewards,
    };
  }

  const winners = room.seats.filter((s) => s.color === winner);
  const gross = staked ? payout(room.tier.entry, room.seats.length) : 0;
  const perPlayer = winners.length > 0 ? Math.floor(gross / winners.length) : 0;

  // Ranked results move a season rating; casual play leaves it alone.
  const season = room.mode.ranked ? await activeSeason() : null;
  const ratingsBefore = new Map<string, number>();
  if (season) {
    for (const seat of room.seats) {
      ratingsBefore.set(seat.userId, await seasonRatingOf(season.id, seat.userId));
    }
  }
  const rankedOutcomes: Record<string, RankedOutcome> = {};

  // Read once for the whole settlement, so both seats get the same event.
  const boost = await eventMultipliers();

  // Collected inside the settlement transaction, applied after it commits:
  // a pass season that has just ended must never roll back a payout.
  const passXpToAward: Array<[string, number]> = [];

  await transaction(async (client) => {
    for (const seat of room.seats) {
      const won = seat.color === winner;
      const player = state?.players.find((p) => p.seat === seat.seat);
      const pocketed = player?.pocketed ?? 0;

      /* ------------------------------- coins ------------------------------- */
      let balance = seat.balanceBefore;
      // Only the winnings above the stake are boosted; a player's own entry
      // coming back is not a reward and must not be multiplied.
      const winnings = won ? perPlayer + Math.floor(Math.max(0, perPlayer - room.tier.entry) * (boost.coins - 1)) : 0;
      if (won && winnings > 0) {
        balance = await moveCoins(client, {
          userId: seat.userId,
          delta: winnings,
          reason: 'payout',
          matchId: room.matchId,
          note: boost.coins > 1 ? `${room.tier.id} win (event x${boost.coins})` : `${room.tier.id} win`,
        });
      }

      /* --------------------------------- xp -------------------------------- */
      let xpGain: number = won ? XP_REWARDS.win : XP_REWARDS.loss;
      xpGain += pocketed * XP_REWARDS.pocket;
      if (state && state.queenOwner === seat.color) xpGain += XP_REWARDS.queenCovered;

      const perfect = Boolean(state && won && isPerfectGame(state, seat.color));
      if (perfect) xpGain += XP_REWARDS.perfectGame;

      // Practice is for practising: no stake, no reward.
      if (room.solo || !room.mode.staked) xpGain = Math.floor(xpGain * 0.15);

      // A live XP event multiplies what the board earned, never the entry.
      if (boost.xp > 1) xpGain = Math.floor(xpGain * boost.xp);

      const xp = await grantXp(client, seat.userId, xpGain);

      // The pass advances on the same XP the account does, so playing at all
      // moves it — there is no separate grind to keep up with.
      passXpToAward.push([seat.userId, xpGain]);

      /* ------------------------------ trophies ----------------------------- */
      let trophyDelta = 0;
      if (room.mode.ranked) {
        trophyDelta = won ? room.tier.trophyStake : -Math.ceil(room.tier.trophyStake * 0.6);
        await grantTrophies(client, seat.userId, trophyDelta);
      }

      /* --------------------------- career record --------------------------- */
      const record = await client.query<{ current_streak: number; best_streak: number }>(
        `UPDATE profiles SET
           games_played = games_played + 1,
           wins = wins + $2,
           losses = losses + $3,
           current_streak = CASE WHEN $2 = 1 THEN current_streak + 1 ELSE 0 END,
           best_streak = GREATEST(best_streak,
                          CASE WHEN $2 = 1 THEN current_streak + 1 ELSE 0 END),
           perfect_games = perfect_games + $4,
           queen_covers = queen_covers + $5
         WHERE user_id = $1
         RETURNING current_streak, best_streak`,
        [
          seat.userId,
          won ? 1 : 0,
          won ? 0 : 1,
          perfect ? 1 : 0,
          state?.queenOwner === seat.color ? 1 : 0,
        ],
      );
      const streak = record.rows[0]?.current_streak ?? 0;

      /* ------------------------------ ranked ------------------------------- */
      if (season) {
        // Average the other side's rating so doubles are scored sensibly.
        const opponents = room.seats.filter((other) => other.color !== seat.color);
        const opponentRating =
          opponents.length > 0
            ? Math.round(
                opponents.reduce((sum, o) => sum + (ratingsBefore.get(o.userId) ?? 0), 0) /
                  opponents.length,
              )
            : 0;

        rankedOutcomes[seat.userId] = await applyRankedResult(
          client,
          season.id,
          seat.userId,
          opponentRating,
          won,
          xpGain,
        );
      }

      /* ------------------------------ fair play ---------------------------- */
      // Finishing a board cleanly is what pulls a fair-play score back up.
      if (reason === 'complete' || reason === 'decision') {
        await recordFairPlay(client, seat.userId, 'clean_match');
      } else if (reason === 'forfeit' || reason === 'abandoned') {
        // Only the side that walked away is penalised.
        if (!won) await recordFairPlay(client, seat.userId, 'abandon');
      }

      /* -------------------------------- crate ------------------------------ */
      let crate: { id: string; kind: string } | null = null;
      if (won && room.mode.awardsCrate && !room.solo) {
        crate = await awardCrate(client, seat.userId, room.tier.id, room.tier.entry, room.matchId);
      }

      /* ----------------------------- win streaks --------------------------- */
      let streakNote: string | undefined;
      if (won) {
        const milestone = STREAK_REWARDS.find((s) => s.wins === streak);
        if (milestone) {
          await moveCoins(client, {
            userId: seat.userId,
            delta: milestone.coins,
            reason: 'streak',
            matchId: room.matchId,
            note: milestone.label,
          });
          await grantXp(client, seat.userId, milestone.xp);
          if (milestone.crate) {
            await client.query(
              `INSERT INTO crates (user_id, kind, tier_entry, source, match_id)
               VALUES ($1,$2,$3,'streak',$4)`,
              [seat.userId, milestone.crate, room.tier.entry, room.matchId],
            );
          }
          streakNote = `${milestone.label}: +${milestone.coins} coins`;
        }
      }

      /* ------------------------------ missions ----------------------------- */
      await advanceMissions(client, seat.userId, 'play_matches');
      if (won) await advanceMissions(client, seat.userId, 'win_matches');
      if (won && room.mode.ranked) await advanceMissions(client, seat.userId, 'win_ranked');
      if (room.size === '4p') await advanceMissions(client, seat.userId, 'play_team');
      if (pocketed > 0) await advanceMissions(client, seat.userId, 'pocket_coins', pocketed);
      if (state?.queenOwner === seat.color) await advanceMissions(client, seat.userId, 'cover_queen');
      if (perfect) await advanceMissions(client, seat.userId, 'perfect_game');
      if (won && streak >= 3) await advanceMissions(client, seat.userId, 'win_streak', streak);

      /* ---------------------------- achievements --------------------------- */
      const unlocked = await evaluateAchievements(client, seat.userId);

      const ranked = rankedOutcomes[seat.userId];
      if (ranked) {
        await client.query(
          `UPDATE match_players SET rating_before = $3, rating_after = $4
            WHERE match_id = $1 AND seat = $2`,
          [room.matchId, seat.seat, ranked.before, ranked.after],
        );
      }

      await client.query(
        `INSERT INTO match_results
           (match_id, user_id, won, coins_delta, xp_gained, trophies_delta,
            level_before, level_after, crate_id, streak_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [
          room.matchId,
          seat.userId,
          won,
          won ? perPlayer : staked ? -room.tier.entry : 0,
          xpGain,
          trophyDelta,
          xp.levelBefore,
          xp.levelAfter,
          crate?.id ?? null,
          streak,
        ],
      );

      rewards[seat.userId] = {
        userId: seat.userId,
        won,
        coins: winnings,
        xp: xpGain,
        trophies: trophyDelta,
        levelBefore: xp.levelBefore,
        levelAfter: xp.levelAfter,
        crateId: crate?.id ?? null,
        crateKind: crate ? CRATE_TYPES[crate.kind as keyof typeof CRATE_TYPES].name : null,
        achievements: unlocked.map((a) => a.name),
        streak,
        balance,
        note: streakNote,
        rating: rankedOutcomes[seat.userId]
          ? {
              before: rankedOutcomes[seat.userId].before,
              after: rankedOutcomes[seat.userId].after,
              delta: rankedOutcomes[seat.userId].delta,
              division: rankedOutcomes[seat.userId].divisionAfter,
              promoted: rankedOutcomes[seat.userId].promoted,
              demoted: rankedOutcomes[seat.userId].demoted,
            }
          : null,
      };
    }

    await persistMatchEnd(client, room, state, reason);
  });

  // Pattern checks run after the money is settled, and never block it.
  for (const seat of room.seats) {
    reviewWinRate(seat.userId).catch((err) =>
      logger.error({ err, userId: seat.userId }, 'win rate review failed'),
    );
  }

  // Same for the pass: a failure here costs a player some pass progress, which
  // support can fix, rather than costing them the match payout.
  for (const [userId, xp] of passXpToAward) {
    addPassXp(userId, xp).catch((err) =>
      logger.error({ err, userId }, 'pass xp award failed'),
    );
  }

  return {
    matchId: room.matchId,
    winner,
    points: state?.points ?? 0,
    pot: state?.pot ?? 0,
    perPlayer,
    reason: reason === 'decision' ? 'complete' : reason,
    rewards,
  };
}

/** Used when a board ends because someone walked away. */
export function forfeitWinner(state: GameState | null, quittingColor: Color): Color {
  void state;
  return quittingColor === 'white' ? 'black' : 'white';
}
