import { Router } from 'express';
import { LOGIN_CYCLE, LOGIN_STREAK_BONUS, type LoginReward } from '@carrom/config';
import { CRATE_TYPES } from '@carrom/content';
import { one, query } from '../db/pool.js';
import { conflict, route } from '../lib/errors.js';
import { keyFor, once } from '../lib/idempotency.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';
import { moveCoins } from './economy.js';
import { grantXp } from './progression.js';
import { cfg } from './config.js';

/**
 * The seven-day login cycle.
 *
 * A claim is once per UTC calendar day, enforced by a unique index on
 * (user_id, claim_on) *and* an idempotency key — so a double tap, a retry or a
 * replayed request can never pay twice.
 *
 * Missing a day resets the consecutive streak but keeps the player's place in
 * the cycle. Someone who drops off for a week comes back to the day they were
 * on rather than starting over, which is the difference between a reason to
 * return and a reason not to.
 */
export const dailyRouter = Router();

interface StreakRow {
  cycle_day: number;
  current_streak: number;
  best_streak: number;
  last_claim_on: Date | null;
  cycles_done: number;
}

function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function daysBetween(from: Date, toIso: string): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const to = new Date(`${toIso}T00:00:00Z`);
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

async function loadStreak(userId: string): Promise<StreakRow> {
  const existing = await one<StreakRow>(
    'SELECT cycle_day, current_streak, best_streak, last_claim_on, cycles_done FROM login_streaks WHERE user_id = $1',
    [userId],
  );
  if (existing) return existing;

  await query('INSERT INTO login_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  return { cycle_day: 1, current_streak: 0, best_streak: 0, last_claim_on: null, cycles_done: 0 };
}

export interface CalendarDay extends LoginReward {
  claimed: boolean;
  isToday: boolean;
  locked: boolean;
}

/** The calendar as the client draws it: seven cards, one highlighted. */
export async function loginCalendar(userId: string) {
  const streak = await loadStreak(userId);
  const today = utcDate();
  const claimedToday = streak.last_claim_on ? utcDate(streak.last_claim_on) === today : false;
  const cycle = cfg('login.cycle') as LoginReward[];

  const days: CalendarDay[] = cycle.map((reward) => ({
    ...reward,
    claimed: reward.day < streak.cycle_day || (claimedToday && reward.day === streak.cycle_day),
    isToday: reward.day === streak.cycle_day && !claimedToday,
    locked: reward.day > streak.cycle_day,
  }));

  return {
    days,
    cycleDay: streak.cycle_day,
    currentStreak: streak.current_streak,
    bestStreak: streak.best_streak,
    cyclesCompleted: streak.cycles_done,
    claimedToday,
    /** Bonus coins riding on the current consecutive streak. */
    streakBonus: Math.min(
      streak.current_streak * (cfg('login.streakBonusPerDay') as number),
      LOGIN_STREAK_BONUS.maxDays * (cfg('login.streakBonusPerDay') as number),
    ),
    nextResetsAt: `${today}T24:00:00Z`,
  };
}

dailyRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    res.json(await loginCalendar(req.auth!.sub));
  }),
);

dailyRouter.post(
  '/claim',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const userId = req.auth!.sub;
    const today = utcDate();

    const outcome = await once(
      keyFor.loginClaim(userId, today),
      'login_claim',
      userId,
      async (client) => {
        const locked = await client.query<StreakRow>(
          `SELECT cycle_day, current_streak, best_streak, last_claim_on, cycles_done
             FROM login_streaks WHERE user_id = $1 FOR UPDATE`,
          [userId],
        );
        const streak =
          locked.rows[0] ??
          (
            await client.query<StreakRow>(
              `INSERT INTO login_streaks (user_id) VALUES ($1)
               RETURNING cycle_day, current_streak, best_streak, last_claim_on, cycles_done`,
              [userId],
            )
          ).rows[0];

        if (streak.last_claim_on && utcDate(streak.last_claim_on) === today) {
          throw conflict('Already claimed today', 'already_claimed');
        }

        // Consecutive only when the last claim was yesterday.
        const gap = streak.last_claim_on ? daysBetween(streak.last_claim_on, today) : null;
        const consecutive = gap === 1;
        const nextStreak = consecutive ? streak.current_streak + 1 : 1;

        const cycle = cfg('login.cycle') as LoginReward[];
        const reward = cycle.find((entry) => entry.day === streak.cycle_day) ?? cycle[0];

        const perDay = cfg('login.streakBonusPerDay') as number;
        const bonusCoins = Math.min(nextStreak, LOGIN_STREAK_BONUS.maxDays) * perDay;

        let coins = bonusCoins;
        let xp = 0;
        let crateKind: string | null = null;
        let fragments = 0;

        switch (reward.kind) {
          case 'coins':
            coins += reward.amount ?? 0;
            break;
          case 'xp':
            xp += reward.amount ?? 0;
            break;
          case 'crate':
            crateKind = reward.crateKind ?? 'rookie';
            break;
          case 'fragments':
            fragments = reward.amount ?? 0;
            await client.query(
              `INSERT INTO fragments (user_id, rarity, amount) VALUES ($1,$2,$3)
               ON CONFLICT (user_id, rarity) DO UPDATE SET amount = fragments.amount + EXCLUDED.amount`,
              [userId, reward.rarity ?? 'rare', fragments],
            );
            break;
          case 'item':
            if (reward.itemId) {
              await client.query(
                `INSERT INTO inventory (user_id, item_id, source) VALUES ($1,$2,'admin')
                 ON CONFLICT DO NOTHING`,
                [userId, reward.itemId],
              );
            }
            break;
        }

        const balance =
          coins > 0
            ? await moveCoins(client, {
                userId,
                delta: coins,
                reason: 'bonus',
                note: `daily day ${streak.cycle_day}`,
              })
            : undefined;

        const levels = xp > 0 ? await grantXp(client, userId, xp) : null;

        if (crateKind) {
          await client.query(
            `INSERT INTO crates (user_id, kind, tier_entry, source) VALUES ($1,$2,$3,'mission')`,
            [userId, crateKind, 1_000],
          );
        }

        const finishedCycle = streak.cycle_day >= cycle.length;
        await client.query(
          `UPDATE login_streaks SET
             cycle_day = $2,
             current_streak = $3,
             best_streak = GREATEST(best_streak, $3),
             last_claim_on = $4::date,
             cycles_done = cycles_done + $5,
             updated_at = now()
           WHERE user_id = $1`,
          [userId, finishedCycle ? 1 : streak.cycle_day + 1, nextStreak, today, finishedCycle ? 1 : 0],
        );

        await client.query(
          `INSERT INTO login_claims (user_id, claim_on, cycle_day, reward)
           VALUES ($1,$2::date,$3,$4)`,
          [
            userId,
            today,
            streak.cycle_day,
            JSON.stringify({ coins, xp, crateKind, fragments, streak: nextStreak }),
          ],
        );

        return {
          day: streak.cycle_day,
          label: reward.label,
          coins,
          bonusCoins,
          xp,
          fragments,
          crateKind: crateKind ? CRATE_TYPES[crateKind as keyof typeof CRATE_TYPES].name : null,
          streak: nextStreak,
          missedDays: gap !== null && gap > 1 ? gap - 1 : 0,
          balance,
          levelUp: levels?.leveledUp ? levels.levelAfter : null,
          cycleComplete: finishedCycle,
        };
      },
    );

    res.json({
      ok: true,
      alreadyClaimed: !outcome.fresh,
      ...(outcome.result as Record<string, unknown>),
      calendar: await loginCalendar(userId),
    });
  }),
);

dailyRouter.get(
  '/history',
  requireAuth,
  route(async (req, res) => {
    const rows = await query(
      `SELECT claim_on, cycle_day, reward, created_at
         FROM login_claims WHERE user_id = $1
        ORDER BY claim_on DESC LIMIT 60`,
      [req.auth!.sub],
    );
    res.json({ claims: rows });
  }),
);

export { LOGIN_CYCLE };
