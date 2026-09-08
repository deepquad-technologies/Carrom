/**
 * Daily and weekly missions. The server picks a deterministic set per player per
 * period, so everyone gets a stable list that refreshes on schedule.
 */
export type MissionMetric =
  | 'play_matches'
  | 'win_matches'
  | 'pocket_coins'
  | 'cover_queen'
  | 'win_ranked'
  | 'open_crates'
  | 'play_team'
  | 'win_streak'
  | 'perfect_game';

export type MissionPeriod = 'daily' | 'weekly';

export interface MissionTemplate {
  id: string;
  period: MissionPeriod;
  name: string;
  description: string;
  metric: MissionMetric;
  target: number;
  xp: number;
  coins: number;
  /** Crate granted on completion, if any. */
  crateKind?: 'rookie' | 'champion' | 'legendary';
}

export const DAILY_MISSIONS: MissionTemplate[] = [
  { id: 'md_play_3', period: 'daily', name: 'Warm Up', description: 'Play 3 matches.', metric: 'play_matches', target: 3, xp: 80, coins: 400 },
  { id: 'md_win_2', period: 'daily', name: 'Two Down', description: 'Win 2 matches.', metric: 'win_matches', target: 2, xp: 120, coins: 700 },
  { id: 'md_pocket_15', period: 'daily', name: 'Sharp Shooter', description: 'Pocket 15 carrom men.', metric: 'pocket_coins', target: 15, xp: 100, coins: 500 },
  { id: 'md_queen_1', period: 'daily', name: 'Take the Queen', description: 'Cover the queen once.', metric: 'cover_queen', target: 1, xp: 140, coins: 800 },
  { id: 'md_ranked_1', period: 'daily', name: 'Climb', description: 'Win a ranked match.', metric: 'win_ranked', target: 1, xp: 160, coins: 900 },
  { id: 'md_crate_1', period: 'daily', name: 'Unbox', description: 'Open a crate.', metric: 'open_crates', target: 1, xp: 70, coins: 300 },
  { id: 'md_team_1', period: 'daily', name: 'Partners', description: 'Play a team match.', metric: 'play_team', target: 1, xp: 110, coins: 600 },
];

export const WEEKLY_MISSIONS: MissionTemplate[] = [
  { id: 'mw_play_25', period: 'weekly', name: 'Regular', description: 'Play 25 matches.', metric: 'play_matches', target: 25, xp: 500, coins: 4_000 },
  { id: 'mw_win_12', period: 'weekly', name: 'Winner', description: 'Win 12 matches.', metric: 'win_matches', target: 12, xp: 700, coins: 6_000, crateKind: 'champion' },
  { id: 'mw_pocket_120', period: 'weekly', name: 'Marksman', description: 'Pocket 120 carrom men.', metric: 'pocket_coins', target: 120, xp: 600, coins: 5_000 },
  { id: 'mw_queen_8', period: 'weekly', name: 'Queen Hunter', description: 'Cover the queen 8 times.', metric: 'cover_queen', target: 8, xp: 800, coins: 7_000 },
  { id: 'mw_streak_3', period: 'weekly', name: 'On a Roll', description: 'Reach a 3 win streak.', metric: 'win_streak', target: 3, xp: 650, coins: 5_500 },
  { id: 'mw_perfect_1', period: 'weekly', name: 'Flawless', description: 'Win a perfect game.', metric: 'perfect_game', target: 1, xp: 1_000, coins: 9_000, crateKind: 'legendary' },
];

export const ALL_MISSIONS = [...DAILY_MISSIONS, ...WEEKLY_MISSIONS];

const BY_ID = new Map(ALL_MISSIONS.map((m) => [m.id, m]));

export function missionById(id: string): MissionTemplate | undefined {
  return BY_ID.get(id);
}

/** How many of each period a player holds at once. */
export const MISSION_SLOTS = { daily: 3, weekly: 2 } as const;

/** Deterministic pick so a player's list is stable for the whole period. */
export function pickMissions(userId: string, period: MissionPeriod, periodKey: string): MissionTemplate[] {
  const pool = period === 'daily' ? DAILY_MISSIONS : WEEKLY_MISSIONS;
  const slots = MISSION_SLOTS[period];

  let hash = 2166136261;
  for (const ch of `${userId}:${periodKey}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  const picked: MissionTemplate[] = [];
  const used = new Set<number>();
  let cursor = hash;
  while (picked.length < Math.min(slots, pool.length)) {
    cursor = (Math.imul(cursor, 1103515245) + 12345) >>> 0;
    const index = cursor % pool.length;
    if (used.has(index)) continue;
    used.add(index);
    picked.push(pool[index]);
  }
  return picked;
}

/** Period keys used to expire and refresh mission sets. */
export function dailyKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function weeklyKey(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
