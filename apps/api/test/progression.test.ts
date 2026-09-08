import { describe, expect, it } from 'vitest';
import {
  DIVISIONS, FAIR_PLAY_BANDS, LEVEL_TITLES, LOGIN_CYCLE, SEASON_THEMES,
  computeFairPlay, connectionBand, divisionForRating, fairPlayBand, levelForXp,
  matchmakingToleranceFor, nextDivision, nextTitle, ratingDelta, resetRating,
  themeForSeason, titleForLevel, xpForLevel,
} from '@carrom/config';

describe('level titles', () => {
  it('matches the published ladder', () => {
    expect(titleForLevel(1).name).toBe('Beginner');
    expect(titleForLevel(9).name).toBe('Beginner');
    expect(titleForLevel(10).name).toBe('Rookie');
    expect(titleForLevel(20).name).toBe('Skilled');
    expect(titleForLevel(30).name).toBe('Pro');
    expect(titleForLevel(40).name).toBe('Expert');
    expect(titleForLevel(50).name).toBe('Master');
    expect(titleForLevel(75).name).toBe('Grandmaster');
    expect(titleForLevel(100).name).toBe('Legend');
    expect(titleForLevel(140).name).toBe('Legend');
  });

  it('never goes backwards as level rises', () => {
    let seen = -1;
    for (let level = 1; level <= 120; level++) {
      const index = LEVEL_TITLES.indexOf(titleForLevel(level));
      expect(index).toBeGreaterThanOrEqual(seen);
      seen = index;
    }
  });

  it('points at the next title until the last one', () => {
    expect(nextTitle(1)?.name).toBe('Rookie');
    expect(nextTitle(99)?.name).toBe('Legend');
    expect(nextTitle(100)).toBeNull();
  });
});

describe('xp curve', () => {
  it('is monotonic', () => {
    for (let level = 1; level < 60; level++) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
  });

  it('round-trips xp back to the right level', () => {
    for (let level = 1; level <= 55; level++) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
      // One XP short of the threshold is still the previous level.
      if (level > 1) expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });

  it('starts everyone at level 1', () => {
    expect(levelForXp(0)).toBe(1);
    expect(xpForLevel(1)).toBe(0);
  });
});

describe('ranked divisions', () => {
  it('orders divisions by rating', () => {
    for (let i = 1; i < DIVISIONS.length; i++) {
      expect(DIVISIONS[i].minRating).toBeGreaterThan(DIVISIONS[i - 1].minRating);
    }
  });

  it('maps a rating to the right division', () => {
    expect(divisionForRating(0).id).toBe('bronze');
    expect(divisionForRating(399).id).toBe('bronze');
    expect(divisionForRating(400).id).toBe('silver');
    expect(divisionForRating(5_000).id).toBe('legend');
  });

  it('stops offering a next division at the top', () => {
    expect(nextDivision(0)?.id).toBe('silver');
    expect(nextDivision(99_999)).toBeNull();
  });

  it('rewards a win and penalises a loss', () => {
    const win = ratingDelta(1_000, 1_000, true, 50);
    const loss = ratingDelta(1_000, 1_000, false, 50);
    expect(win).toBeGreaterThan(0);
    expect(loss).toBeLessThan(0);
    // Evenly matched, so the swing should be symmetric.
    expect(Math.abs(win + loss)).toBeLessThanOrEqual(1);
  });

  it('pays more for beating a stronger opponent', () => {
    const upset = ratingDelta(1_000, 1_600, true, 50);
    const expected = ratingDelta(1_000, 1_000, true, 50);
    expect(upset).toBeGreaterThan(expected);
  });

  it('moves new players faster than established ones', () => {
    expect(ratingDelta(1_000, 1_000, true, 5)).toBeGreaterThan(
      ratingDelta(1_000, 1_000, true, 200),
    );
  });

  it('pulls a season reset toward the middle without wiping it', () => {
    const high = resetRating(4_000);
    expect(high).toBeLessThan(4_000);
    expect(high).toBeGreaterThan(DIVISIONS[1].minRating);
    // A player at the bottom cannot be pushed below zero.
    expect(resetRating(0)).toBeGreaterThanOrEqual(0);
  });
});

describe('seasons', () => {
  it('cycles through the themes', () => {
    expect(themeForSeason(1).id).toBe(SEASON_THEMES[0].id);
    expect(themeForSeason(SEASON_THEMES.length + 1).id).toBe(SEASON_THEMES[0].id);
  });

  it('gives every theme a real board', () => {
    for (const theme of SEASON_THEMES) {
      expect(theme.boardId.length).toBeGreaterThan(0);
      expect(theme.exclusiveItemIds.length).toBeGreaterThan(0);
    }
  });
});

describe('fair play', () => {
  it('starts a clean account at the top', () => {
    expect(
      computeFairPlay({
        abandons: 0,
        disconnects: 0,
        upheldReports: 0,
        confirmedCheating: 0,
        cleanMatches: 0,
      }),
    ).toBe(100);
  });

  it('drops for abandons and reports', () => {
    const score = computeFairPlay({
      abandons: 3,
      disconnects: 2,
      upheldReports: 1,
      confirmedCheating: 0,
      cleanMatches: 0,
    });
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThan(0);
  });

  it('is recoverable through clean play', () => {
    const damaged = computeFairPlay({
      abandons: 4,
      disconnects: 0,
      upheldReports: 0,
      confirmedCheating: 0,
      cleanMatches: 0,
    });
    const recovered = computeFairPlay({
      abandons: 4,
      disconnects: 0,
      upheldReports: 0,
      confirmedCheating: 0,
      cleanMatches: 60,
    });
    expect(recovered).toBeGreaterThan(damaged);
  });

  it('never leaves the 0-100 range', () => {
    const floor = computeFairPlay({
      abandons: 999,
      disconnects: 999,
      upheldReports: 999,
      confirmedCheating: 999,
      cleanMatches: 0,
    });
    const ceiling = computeFairPlay({
      abandons: 0,
      disconnects: 0,
      upheldReports: 0,
      confirmedCheating: 0,
      cleanMatches: 100_000,
    });
    expect(floor).toBe(0);
    expect(ceiling).toBe(100);
  });

  it('bands the score sensibly', () => {
    expect(fairPlayBand(100).id).toBe('excellent');
    expect(fairPlayBand(70).id).toBe('good');
    expect(fairPlayBand(50).id).toBe('fair');
    expect(fairPlayBand(10).id).toBe('poor');
  });

  it('covers every score with a band', () => {
    for (let score = 0; score <= 100; score++) {
      expect(FAIR_PLAY_BANDS).toContain(fairPlayBand(score));
    }
  });

  it('narrows matchmaking only for poor standing', () => {
    expect(matchmakingToleranceFor(95)).toBe(1);
    expect(matchmakingToleranceFor(50)).toBeLessThan(1);
    expect(matchmakingToleranceFor(10)).toBeLessThan(matchmakingToleranceFor(50));
  });
});

describe('daily login cycle', () => {
  it('has seven days, numbered in order', () => {
    expect(LOGIN_CYCLE).toHaveLength(7);
    LOGIN_CYCLE.forEach((reward, index) => {
      expect(reward.day).toBe(index + 1);
      expect(reward.label.length).toBeGreaterThan(0);
    });
  });

  it('gives every entry something to hand out', () => {
    for (const reward of LOGIN_CYCLE) {
      const hasPayload =
        reward.amount !== undefined || reward.crateKind !== undefined || reward.itemId !== undefined;
      expect(hasPayload).toBe(true);
    }
  });

  it('saves the best reward for day seven', () => {
    expect(LOGIN_CYCLE[6].kind).toBe('crate');
    expect(LOGIN_CYCLE[6].crateKind).toBe('legendary');
  });
});

describe('connection bands', () => {
  it('degrades as ping rises', () => {
    expect(connectionBand(20)).toBe('excellent');
    expect(connectionBand(120)).toBe('good');
    expect(connectionBand(220)).toBe('average');
    expect(connectionBand(600)).toBe('poor');
  });
});
