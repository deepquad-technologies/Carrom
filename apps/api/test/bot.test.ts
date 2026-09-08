import { describe, expect, it } from 'vitest';
import { PIECES_PER_SIDE } from '@carrom/config';
import { BOT_NAME_POOL, buildBotNames } from '@carrom/content';
import { buildRoster } from '../src/features/bots.js';
import {
  BOT_PROFILES, applyShot, chooseShot, createGame, profileFor, remaining,
  skillForLevel, thinkTimeFor, validateShot,
} from '@carrom/game-engine';
import type { GamePlayer, GameState } from '@carrom/types';

/**
 * The bot.
 *
 * Two things matter here and nothing else really does: it must play *legally*
 * — the same rules a human is held to — and it must be good enough that a
 * player can lose to it. A bot that fouls constantly is worse than no bot.
 */
function seat(index: number, name: string): GamePlayer {
  return {
    userId: `p${index}`,
    username: name,
    displayName: name,
    seat: index,
    color: index % 2 === 0 ? 'white' : 'black',
    connected: true,
    provider: 'guest',
    level: 1,
    trophies: 0,
    balance: 0,
    strikerSkinId: 'str_classic',
    coinSkinId: 'set_classic',
    pocketed: 0,
  };
}

function freshBoard(): GameState {
  return createGame({
    matchId: 'bot-test',
    modeId: 'quick',
    size: '2p',
    players: [seat(0, 'Alpha'), seat(1, 'Bravo')],
    staked: false,
  });
}

/** Run the search with no yielding, so the tests stay synchronous and quick. */
const noYield = () => Promise.resolve();

describe('bot difficulty', () => {
  it('offers three profiles', () => {
    expect(Object.keys(BOT_PROFILES).sort()).toEqual(['easy', 'hard', 'medium']);
  });

  it('gets more precise as it gets harder', () => {
    expect(BOT_PROFILES.easy.aimNoise).toBeGreaterThan(BOT_PROFILES.medium.aimNoise);
    expect(BOT_PROFILES.medium.aimNoise).toBeGreaterThan(BOT_PROFILES.hard.aimNoise);
    expect(BOT_PROFILES.easy.blunderChance).toBeGreaterThan(BOT_PROFILES.hard.blunderChance);
  });

  it('searches more widely as it gets harder', () => {
    expect(BOT_PROFILES.hard.positions).toBeGreaterThan(BOT_PROFILES.easy.positions);
    expect(BOT_PROFILES.hard.spread).toBeGreaterThan(BOT_PROFILES.easy.spread);
  });

  it('matches difficulty to the opponent', () => {
    expect(skillForLevel(1, 0)).toBe('easy');
    expect(skillForLevel(8, 200)).toBe('medium');
    expect(skillForLevel(25, 1_200)).toBe('hard');
  });

  it('thinks for a believable amount of time', () => {
    for (const profile of Object.values(BOT_PROFILES)) {
      const think = thinkTimeFor(profile);
      expect(think).toBeGreaterThanOrEqual(profile.thinkMs[0]);
      expect(think).toBeLessThanOrEqual(profile.thinkMs[1]);
      // Instant is obviously a machine; a long pause is obviously broken.
      expect(think).toBeGreaterThan(500);
      expect(think).toBeLessThan(5_000);
    }
  });
});

describe('bot shot selection', () => {
  it('only ever returns a shot the server would accept', async () => {
    const state = freshBoard();

    for (let turn = 0; turn < 12; turn++) {
      const decision = await chooseShot(state, profileFor('medium'), 200, noYield);
      const check = validateShot(state, state.turnSeat, decision.shot);
      expect(check.ok, `turn ${turn}: ${check.reason}`).toBe(true);
      applyShot(state, decision.shot);
      if (state.status === 'finished') break;
    }
  });

  it('actually evaluates candidates on a full board', async () => {
    const decision = await chooseShot(freshBoard(), profileFor('hard'), 400, noYield);
    expect(decision.evaluated).toBeGreaterThan(20);
  });

  it('stays inside its time budget', async () => {
    const started = Date.now();
    await chooseShot(freshBoard(), profileFor('hard'), 120, noYield);
    // The budget is checked between batches, so allow one batch of overshoot.
    expect(Date.now() - started).toBeLessThan(600);
  });

  it('finds an open man in front of it', async () => {
    const state = freshBoard();
    // Clear the table and leave one white man sitting in front of a pocket.
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = true;
    }
    const white = state.bodies.find((b) => b.kind === 'white')!;
    white.pocketed = false;
    white.x = 120;
    white.y = 200;
    white.vx = 0;
    white.vy = 0;

    // Over a few attempts a competent bot should pocket a sitter at least once.
    let pocketed = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const trial: GameState = {
        ...state,
        bodies: state.bodies.map((b) => ({ ...b })),
        players: state.players.map((p) => ({ ...p })),
        due: { ...state.due },
      };
      const decision = await chooseShot(trial, profileFor('hard'), 300, noYield);
      applyShot(trial, decision.shot);
      if (remaining(trial, 'white') === 0) pocketed += 1;
    }
    expect(pocketed).toBeGreaterThan(0);
  });
});

describe('a full bot-versus-bot match', () => {
  it('finishes legally, without either side fouling constantly', async () => {
    const state = freshBoard();
    const profiles = [profileFor('hard'), profileFor('medium')];

    let shots = 0;
    let fouls = 0;

    while (state.status === 'playing' && shots < 260) {
      const profile = profiles[state.turnSeat % 2]!;
      const decision = await chooseShot(state, profile, 90, noYield);

      const check = validateShot(state, state.turnSeat, decision.shot);
      expect(check.ok, `shot ${shots}: ${check.reason}`).toBe(true);

      const summary = applyShot(state, decision.shot);
      if (summary.foul) fouls += 1;
      shots += 1;
    }

    expect(state.status).toBe('finished');

    // Fouling on more than half your shots is not a player, it is a bug.
    expect(fouls / shots).toBeLessThan(0.5);

    // And the board genuinely progressed rather than stalemating.
    const left = remaining(state, 'white') + remaining(state, 'black');
    expect(left).toBeLessThan(PIECES_PER_SIDE * 2);
  }, 120_000);
});

describe('the bot roster', () => {
  it('draws from a pool of more than a hundred names', () => {
    expect(BOT_NAME_POOL.length).toBeGreaterThan(100);
  });

  it('is the same roster on every boot', () => {
    // Seeding checks for a bot by username. A roster built from Math.random
    // would produce new names each restart and quietly create another set of
    // accounts every time the server came up — which is exactly what happened
    // before this was made deterministic.
    expect(buildRoster()).toEqual(buildRoster());
  });

  it('gives every bot a distinct name and username', () => {
    const roster = buildRoster();
    expect(new Set(roster.map((r) => r.username)).size).toBe(roster.length);
    expect(new Set(roster.map((r) => r.displayName)).size).toBe(roster.length);
  });

  it('spreads difficulty evenly', () => {
    const roster = buildRoster();
    const counts = new Map<string, number>();
    for (const entry of roster) counts.set(entry.skill, (counts.get(entry.skill) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === roster.length / 3)).toBe(true);
  });

  it('matches each bot’s shown level to how it actually plays', () => {
    // A "hard" bot displaying level 3 gives the game away immediately.
    for (const entry of buildRoster()) {
      if (entry.skill === 'easy') expect(entry.level).toBeLessThanOrEqual(7);
      if (entry.skill === 'hard') expect(entry.level).toBeGreaterThanOrEqual(20);
    }
  });

  it('uses human names, not machine ones', () => {
    for (const entry of buildRoster()) {
      expect(entry.displayName).toMatch(/^[A-Z][a-z]+( [A-Z]\.)?$/);
    }
  });

  it('can build more names than the pool holds', () => {
    const many = buildBotNames(BOT_NAME_POOL.length + 40);
    expect(many.length).toBe(BOT_NAME_POOL.length + 40);
    expect(new Set(many).size).toBe(many.length);
  });
});
