import type { Rarity } from './rarity';

/**
 * Achievements are evaluated server-side from match results, so a modified
 * client cannot grant itself one. Each carries an XP and coin reward, and some
 * unlock a cosmetic outright.
 */
export type AchievementMetric =
  | 'wins'
  | 'games'
  | 'perfect_games'
  | 'queen_covers'
  | 'best_streak'
  | 'comebacks'
  | 'tournament_wins'
  | 'trophies'
  | 'items_owned'
  | 'strikers_owned'
  | 'boards_owned'
  | 'coin_sets_owned';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  metric: AchievementMetric;
  target: number;
  xp: number;
  coins: number;
  /** Cosmetic granted on unlock, if any. */
  grantsItemId?: string;
  tier: Rarity;
  icon: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'ach_first_win', name: 'First Win', description: 'Win your first match.', metric: 'wins', target: 1, xp: 150, coins: 500, tier: 'common', icon: 'trophy' },
  { id: 'ach_win_10', name: '10 Wins', description: 'Win 10 matches.', metric: 'wins', target: 10, xp: 300, coins: 2_000, grantsItemId: 'str_thunder', tier: 'common', icon: 'trophy' },
  { id: 'ach_win_50', name: '50 Wins', description: 'Win 50 matches.', metric: 'wins', target: 50, xp: 800, coins: 10_000, grantsItemId: 'str_royal', tier: 'rare', icon: 'trophy' },
  { id: 'ach_win_100', name: '100 Wins', description: 'Win 100 matches.', metric: 'wins', target: 100, xp: 1_600, coins: 30_000, grantsItemId: 'str_golden_crown', tier: 'epic', icon: 'trophy' },

  { id: 'ach_perfect', name: 'Perfect Game', description: 'Win without your opponent pocketing a single man.', metric: 'perfect_games', target: 1, xp: 500, coins: 5_000, tier: 'rare', icon: 'star' },
  { id: 'ach_queen_master', name: 'Queen Master', description: 'Cover the queen 25 times.', metric: 'queen_covers', target: 25, xp: 700, coins: 8_000, grantsItemId: 'set_royal', tier: 'rare', icon: 'crown' },
  { id: 'ach_comeback', name: 'Comeback King', description: 'Win from five men down.', metric: 'comebacks', target: 1, xp: 600, coins: 6_000, tier: 'rare', icon: 'flame' },

  { id: 'ach_streak_5', name: 'Five Win Streak', description: 'Win five matches in a row.', metric: 'best_streak', target: 5, xp: 400, coins: 4_000, tier: 'rare', icon: 'bolt' },
  { id: 'ach_streak_10', name: 'Ten Win Streak', description: 'Win ten matches in a row.', metric: 'best_streak', target: 10, xp: 1_000, coins: 15_000, tier: 'epic', icon: 'bolt' },

  { id: 'ach_tournament_winner', name: 'Tournament Winner', description: 'Win a tournament.', metric: 'tournament_wins', target: 1, xp: 1_200, coins: 25_000, grantsItemId: 'str_legendary_one', tier: 'epic', icon: 'medal' },
  { id: 'ach_champion', name: 'Champion', description: 'Reach 2,000 trophies.', metric: 'trophies', target: 2_000, xp: 1_500, coins: 40_000, grantsItemId: 'set_royal_crown', tier: 'mythic', icon: 'shield' },
  { id: 'ach_master', name: 'Master', description: 'Reach 2,800 trophies.', metric: 'trophies', target: 2_800, xp: 2_200, coins: 80_000, tier: 'mythic', icon: 'shield' },
  { id: 'ach_grandmaster', name: 'Grandmaster', description: 'Reach 3,800 trophies.', metric: 'trophies', target: 3_800, xp: 4_000, coins: 200_000, grantsItemId: 'str_ultimate', tier: 'legendary', icon: 'shield' },

  { id: 'ach_collector', name: 'Collector', description: 'Own 60 cosmetics.', metric: 'items_owned', target: 60, xp: 1_500, coins: 30_000, grantsItemId: 'set_ultimate', tier: 'mythic', icon: 'chest' },
  { id: 'ach_striker_collector', name: 'Striker Collector', description: 'Own 25 strikers.', metric: 'strikers_owned', target: 25, xp: 800, coins: 12_000, tier: 'epic', icon: 'disc' },
  { id: 'ach_board_collector', name: 'Board Collector', description: 'Own 10 boards.', metric: 'boards_owned', target: 10, xp: 800, coins: 12_000, tier: 'epic', icon: 'grid' },
  { id: 'ach_coin_collector', name: 'Coin Collector', description: 'Own 25 coin sets.', metric: 'coin_sets_owned', target: 25, xp: 800, coins: 12_000, tier: 'epic', icon: 'coins' },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

export function achievementsForMetric(metric: AchievementMetric): Achievement[] {
  return ACHIEVEMENTS.filter((a) => a.metric === metric);
}
