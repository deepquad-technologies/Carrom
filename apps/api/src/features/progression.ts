import type { PoolClient } from 'pg';
import {
  ACHIEVEMENTS, achievementById, dailyKey, missionById, pickMissions, weeklyKey,
  type AchievementMetric, type MissionMetric,
} from '@carrom/content';
import { RANKS, levelForXp, rankForTrophies, xpForLevel } from '@carrom/config';
import { one, query, transaction } from '../db/pool.js';
import { moveCoins } from './economy.js';

/**
 * XP, levels, achievements and missions. Everything here is driven by match
 * results the server computed itself; nothing is ever taken from the client.
 */

export interface XpResult {
  xp: number;
  levelBefore: number;
  levelAfter: number;
  leveledUp: boolean;
}

export async function grantXp(client: PoolClient, userId: string, amount: number): Promise<XpResult> {
  const before = await client.query<{ xp: number; level: number }>(
    'SELECT xp, level FROM profiles WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  const current = before.rows[0];
  if (!current) return { xp: 0, levelBefore: 1, levelAfter: 1, leveledUp: false };

  const levelBefore = current.level;
  const totalXp = Number(current.xp) + amount;
  const levelAfter = levelForXp(totalXp);

  await client.query('UPDATE profiles SET xp = $2, level = $3 WHERE user_id = $1', [
    userId,
    totalXp,
    levelAfter,
  ]);

  return { xp: totalXp, levelBefore, levelAfter, leveledUp: levelAfter > levelBefore };
}

export async function grantTrophies(
  client: PoolClient,
  userId: string,
  delta: number,
): Promise<number> {
  const result = await client.query<{ trophies: number }>(
    `UPDATE profiles
        SET trophies = GREATEST(0, trophies + $2)
      WHERE user_id = $1
      RETURNING trophies`,
    [userId, delta],
  );
  return result.rows[0]?.trophies ?? 0;
}

/* ------------------------------- achievements ------------------------------ */

/** The counters an achievement can watch, read straight from the profile. */
async function metricValues(
  client: PoolClient,
  userId: string,
): Promise<Record<AchievementMetric, number>> {
  const profile = await client.query<{
    wins: number; games_played: number; perfect_games: number; queen_covers: number;
    best_streak: number; comebacks: number; tournament_wins: number; trophies: number;
  }>(
    `SELECT wins, games_played, perfect_games, queen_covers,
            best_streak, comebacks, tournament_wins, trophies
       FROM profiles WHERE user_id = $1`,
    [userId],
  );
  const p = profile.rows[0];

  const owned = await client.query<{ category: string; count: string }>(
    `SELECT i.category, COUNT(*)::text AS count
       FROM inventory inv
       JOIN items i ON i.id = inv.item_id
      WHERE inv.user_id = $1
      GROUP BY i.category`,
    [userId],
  );
  const byCategory = new Map(owned.rows.map((r) => [r.category, Number(r.count)]));
  const totalOwned = [...byCategory.values()].reduce((sum, n) => sum + n, 0);

  return {
    wins: p?.wins ?? 0,
    games: p?.games_played ?? 0,
    perfect_games: p?.perfect_games ?? 0,
    queen_covers: p?.queen_covers ?? 0,
    best_streak: p?.best_streak ?? 0,
    comebacks: p?.comebacks ?? 0,
    tournament_wins: p?.tournament_wins ?? 0,
    trophies: p?.trophies ?? 0,
    items_owned: totalOwned,
    strikers_owned: byCategory.get('striker') ?? 0,
    boards_owned: byCategory.get('board') ?? 0,
    coin_sets_owned: byCategory.get('coin_set') ?? 0,
  };
}

export interface AchievementUnlock {
  id: string;
  name: string;
  xp: number;
  coins: number;
  itemId: string | null;
}

/**
 * Re-evaluate every achievement for a user and award the ones newly met.
 * Idempotent: an achievement already recorded as unlocked is never paid twice.
 */
export async function evaluateAchievements(
  client: PoolClient,
  userId: string,
): Promise<AchievementUnlock[]> {
  const values = await metricValues(client, userId);

  const existing = await client.query<{ achievement_id: string; unlocked_at: Date | null }>(
    'SELECT achievement_id, unlocked_at FROM player_achievements WHERE user_id = $1',
    [userId],
  );
  const unlockedAlready = new Set(
    existing.rows.filter((r) => r.unlocked_at !== null).map((r) => r.achievement_id),
  );

  const unlocked: AchievementUnlock[] = [];

  for (const achievement of ACHIEVEMENTS) {
    const progress = values[achievement.metric] ?? 0;
    const met = progress >= achievement.target;

    await client.query(
      `INSERT INTO player_achievements (user_id, achievement_id, progress, unlocked_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, achievement_id) DO UPDATE SET
         progress = EXCLUDED.progress,
         unlocked_at = COALESCE(player_achievements.unlocked_at, EXCLUDED.unlocked_at)`,
      [userId, achievement.id, Math.min(progress, achievement.target), met ? new Date() : null],
    );

    if (!met || unlockedAlready.has(achievement.id)) continue;

    if (achievement.coins > 0) {
      await moveCoins(client, {
        userId,
        delta: achievement.coins,
        reason: 'achievement',
        note: achievement.id,
      });
    }
    if (achievement.xp > 0) await grantXp(client, userId, achievement.xp);

    if (achievement.grantsItemId) {
      await client.query(
        `INSERT INTO inventory (user_id, item_id, source)
         VALUES ($1,$2,'achievement')
         ON CONFLICT (user_id, item_id) DO NOTHING`,
        [userId, achievement.grantsItemId],
      );
    }

    await client.query(
      `INSERT INTO notifications (user_id, kind, title, body, data)
       VALUES ($1,'achievement',$2,$3,$4)`,
      [
        userId,
        'Achievement unlocked',
        achievement.name,
        JSON.stringify({ achievementId: achievement.id }),
      ],
    );

    unlocked.push({
      id: achievement.id,
      name: achievement.name,
      xp: achievement.xp,
      coins: achievement.coins,
      itemId: achievement.grantsItemId ?? null,
    });
  }

  return unlocked;
}

export async function achievementsFor(userId: string) {
  const rows = await query<{ achievement_id: string; progress: number; unlocked_at: Date | null }>(
    'SELECT achievement_id, progress, unlocked_at FROM player_achievements WHERE user_id = $1',
    [userId],
  );
  const byId = new Map(rows.map((r) => [r.achievement_id, r]));

  return ACHIEVEMENTS.map((a) => {
    const row = byId.get(a.id);
    return {
      ...a,
      progress: row?.progress ?? 0,
      unlockedAt: row?.unlocked_at?.toISOString() ?? null,
    };
  });
}

/* --------------------------------- missions -------------------------------- */

function periodEnd(period: 'daily' | 'weekly'): Date {
  const now = new Date();
  if (period === 'daily') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }
  const daysToMonday = ((8 - (now.getUTCDay() || 7)) % 7) || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday));
}

/** Make sure the player holds a mission set for the current day and week. */
export async function ensureMissions(userId: string): Promise<void> {
  await transaction(async (client) => {
    for (const period of ['daily', 'weekly'] as const) {
      const key = period === 'daily' ? dailyKey() : weeklyKey();
      const chosen = pickMissions(userId, period, key);
      for (const mission of chosen) {
        await client.query(
          `INSERT INTO player_missions (user_id, mission_id, period_key, expires_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, mission_id, period_key) DO NOTHING`,
          [userId, mission.id, key, periodEnd(period)],
        );
      }
    }
  });
}

/** Advance every active mission that watches this metric. */
export async function advanceMissions(
  client: PoolClient,
  userId: string,
  metric: MissionMetric,
  amount = 1,
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `UPDATE player_missions pm
        SET progress = LEAST(m.target, pm.progress + $3)
       FROM missions m
      WHERE m.id = pm.mission_id
        AND pm.user_id = $1
        AND m.metric = $2
        AND pm.claimed_at IS NULL
        AND pm.expires_at > now()`,
    [userId, metric, amount],
  );
}

export async function missionsFor(userId: string) {
  await ensureMissions(userId);
  const rows = await query<{
    mission_id: string; period_key: string; progress: number;
    claimed_at: Date | null; expires_at: Date;
  }>(
    `SELECT mission_id, period_key, progress, claimed_at, expires_at
       FROM player_missions
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY expires_at`,
    [userId],
  );

  return rows.flatMap((row) => {
    const template = missionById(row.mission_id);
    if (!template) return [];
    return [{
      ...template,
      periodKey: row.period_key,
      progress: row.progress,
      complete: row.progress >= template.target,
      claimed: row.claimed_at !== null,
      expiresAt: row.expires_at.toISOString(),
    }];
  });
}

export interface MissionClaim {
  ok: boolean;
  message: string;
  coins?: number;
  xp?: number;
  crateKind?: string;
  balance?: number;
}

/** Pay out a completed mission exactly once. */
export async function claimMission(userId: string, missionId: string): Promise<MissionClaim> {
  const template = missionById(missionId);
  if (!template) return { ok: false, message: 'No such mission' };

  return transaction(async (client) => {
    const row = await client.query<{ progress: number; claimed_at: Date | null; period_key: string }>(
      `SELECT progress, claimed_at, period_key
         FROM player_missions
        WHERE user_id = $1 AND mission_id = $2 AND expires_at > now()
        ORDER BY expires_at DESC
        LIMIT 1
        FOR UPDATE`,
      [userId, missionId],
    );
    const mission = row.rows[0];
    if (!mission) return { ok: false, message: 'That mission is not active' };
    if (mission.claimed_at) return { ok: false, message: 'Already claimed' };
    if (mission.progress < template.target) return { ok: false, message: 'Not finished yet' };

    await client.query(
      `UPDATE player_missions SET claimed_at = now()
        WHERE user_id = $1 AND mission_id = $2 AND period_key = $3`,
      [userId, missionId, mission.period_key],
    );

    const balance = await moveCoins(client, {
      userId,
      delta: template.coins,
      reason: 'mission',
      note: template.id,
    });
    await grantXp(client, userId, template.xp);

    if (template.crateKind) {
      await client.query(
        `INSERT INTO crates (user_id, kind, tier_entry, source)
         VALUES ($1,$2,$3,'mission')`,
        [userId, template.crateKind, 1_000],
      );
    }

    return {
      ok: true,
      message: `${template.name} claimed`,
      coins: template.coins,
      xp: template.xp,
      crateKind: template.crateKind,
      balance,
    };
  });
}

/* ---------------------------------- stats ---------------------------------- */

export async function profileStats(userId: string) {
  const row = await one<{ level: number; xp: number; trophies: number; wins: number; games_played: number }>(
    'SELECT level, xp, trophies, wins, games_played FROM profiles WHERE user_id = $1',
    [userId],
  );
  if (!row) return null;

  const level = row.level;
  const xp = Number(row.xp);
  const currentFloor = xpForLevel(level);
  const nextFloor = xpForLevel(level + 1);
  const rank = rankForTrophies(row.trophies);
  const nextRank = RANKS.find((r) => r.minTrophies > row.trophies) ?? null;

  const position = await one<{ position: string }>(
    'SELECT COUNT(*) + 1 AS position FROM profiles WHERE trophies > $1',
    [row.trophies],
  );

  return {
    level,
    xp,
    xpIntoLevel: xp - currentFloor,
    xpForNextLevel: Math.max(1, nextFloor - currentFloor),
    winRate: row.games_played > 0 ? Math.round((row.wins / row.games_played) * 1000) / 10 : 0,
    rank: { id: rank.id, name: rank.name, color: rank.color },
    nextRank: nextRank ? { name: nextRank.name, at: nextRank.minTrophies } : null,
    globalPosition: position ? Number(position.position) : null,
  };
}

export { achievementById };
