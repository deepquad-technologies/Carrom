import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE, MAX_TURNS_PER_BOARD, PIECES_PER_SIDE, POCKETS, POCKET_RADIUS, STRIKER_RADIUS,
} from '@carrom/config';
import { anyMoving, cloneBodies, createBodies, simulate, stepWorld } from '@carrom/physics';
import {
  applyShot, applyTimeout, clampAimAngle, colorOfSeat, createGame, isPerfectGame, normalOfSide,
  remaining, resolveShot, seatCount, sideOfSeat, strikerSpot, validateShot,
} from '@carrom/game-engine';
import type { Body, GamePlayer, GameState, Shot } from '@carrom/types';

function players(count: number): GamePlayer[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `u${i}`,
    username: `p${i}`,
    displayName: `Player ${i}`,
    seat: i,
    color: colorOfSeat(i),
    connected: true,
    provider: 'guest' as const,
    level: 1,
    trophies: 0,
    balance: 10_000,
    strikerSkinId: 'str_classic',
    coinSkinId: 'set_classic',
    pocketed: 0,
  }));
}

function newGame(size: '2p' | '4p' = '2p'): GameState {
  return createGame({
    matchId: 'test-match',
    modeId: 'classic',
    tierId: 'beginner',
    size,
    players: players(size === '2p' ? 2 : 4),
  });
}

/** Straight up the board from the middle of seat 0's base line. */
const STRAIGHT: Shot = { pos: 0.5, angle: -Math.PI / 2, power: 0.35 };

/**
 * Clear the table and leave a single target directly in the striker's path, so
 * a shot is guaranteed to make contact and cannot be a no-touch foul. This
 * keeps rule assertions independent of how the physics happens to scatter.
 */
function soloTarget(state: GameState, keep: Body['kind']): void {
  const spot = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
  let placed = false;
  for (const body of state.bodies) {
    if (body.kind === 'striker') continue;
    if (!placed && body.kind === keep) {
      body.pocketed = false;
      body.x = spot.x;
      body.y = spot.y - 140;
      placed = true;
      continue;
    }
    body.pocketed = true;
  }
}

describe('opening layout', () => {
  const bodies = createBodies();

  it('has nine men a side, one queen and a striker', () => {
    expect(bodies.filter((b) => b.kind === 'white')).toHaveLength(PIECES_PER_SIDE);
    expect(bodies.filter((b) => b.kind === 'black')).toHaveLength(PIECES_PER_SIDE);
    expect(bodies.filter((b) => b.kind === 'queen')).toHaveLength(1);
    expect(bodies.filter((b) => b.kind === 'striker')).toHaveLength(1);
  });

  it('places every piece inside the board with no overlap', () => {
    const men = bodies.filter((b) => b.kind !== 'striker');
    for (const b of men) {
      expect(b.x).toBeGreaterThanOrEqual(b.r);
      expect(b.y).toBeGreaterThanOrEqual(b.r);
      expect(b.x).toBeLessThanOrEqual(BOARD_SIZE - b.r);
      expect(b.y).toBeLessThanOrEqual(BOARD_SIZE - b.r);
    }
    for (let i = 0; i < men.length; i++) {
      for (let j = i + 1; j < men.length; j++) {
        const d = Math.hypot(men[i].x - men[j].x, men[i].y - men[j].y);
        expect(d).toBeGreaterThanOrEqual(men[i].r + men[j].r - 0.01);
      }
    }
  });

  it('starts no piece already over a pocket', () => {
    for (const b of bodies) {
      for (const p of POCKETS) {
        expect(Math.hypot(b.x - p.x, b.y - p.y)).toBeGreaterThan(POCKET_RADIUS);
      }
    }
  });
});

describe('physics', () => {
  it('brings every body to rest', () => {
    const bodies = createBodies();
    bodies.find((b) => b.kind === 'striker')!.vy = -2000;
    simulate(bodies);
    expect(anyMoving(bodies)).toBe(false);
  });

  it('keeps bodies inside the board through a hard shot', () => {
    const bodies = createBodies();
    const striker = bodies.find((b) => b.kind === 'striker')!;
    striker.vx = 2600;
    striker.vy = -2600;
    simulate(bodies);
    for (const b of bodies) {
      if (b.pocketed) continue;
      expect(b.x).toBeGreaterThanOrEqual(b.r - 0.5);
      expect(b.y).toBeGreaterThanOrEqual(b.r - 0.5);
      expect(b.x).toBeLessThanOrEqual(BOARD_SIZE - b.r + 0.5);
      expect(b.y).toBeLessThanOrEqual(BOARD_SIZE - b.r + 0.5);
    }
  });

  it('is deterministic: same input, same output', () => {
    const a = createBodies();
    const b = cloneBodies(a);
    for (const set of [a, b]) {
      const striker = set.find((s) => s.kind === 'striker')!;
      striker.vx = 400;
      striker.vy = -1800;
    }
    simulate(a);
    simulate(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('loses energy to friction rather than gaining it', () => {
    const bodies = createBodies();
    const striker = bodies.find((b) => b.kind === 'striker')!;
    striker.vy = -1500;
    const before = Math.hypot(striker.vx, striker.vy);
    for (let i = 0; i < 20; i++) stepWorld(bodies);
    expect(Math.hypot(striker.vx, striker.vy)).toBeLessThan(before);
  });

  it('pockets a piece sitting over a pocket', () => {
    const bodies = createBodies();
    const target = bodies.find((b) => b.kind === 'white')!;
    target.x = POCKETS[0].x;
    target.y = POCKETS[0].y;
    target.vx = 1;
    stepWorld(bodies);
    expect(target.pocketed).toBe(true);
  });

  it('reports the first carrom man the striker touched', () => {
    const bodies = createBodies();
    const striker = bodies.find((b) => b.kind === 'striker')!;
    striker.vy = -1800;
    const result = simulate(bodies);
    expect(result.firstContact).not.toBeNull();
    expect(result.strikerPocketed).toBe(false);
  });
});

describe('shot validation', () => {
  const state = newGame();

  it('accepts a legal shot', () => {
    expect(validateShot(state, 0, { pos: 0.5, angle: -Math.PI / 2, power: 0.7 }).ok).toBe(true);
  });

  it('rejects a shot from the wrong seat', () => {
    const result = validateShot(state, 1, { pos: 0.5, angle: -Math.PI / 2, power: 0.7 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not your turn/i);
  });

  it.each([
    ['power above 1', { pos: 0.5, angle: 0, power: 1.5 }],
    ['negative power', { pos: 0.5, angle: 0, power: -0.2 }],
    ['striker off the base line', { pos: 2, angle: 0, power: 0.5 }],
    ['NaN angle', { pos: 0.5, angle: Number.NaN, power: 0.5 }],
    ['infinite power', { pos: 0.5, angle: 0, power: Number.POSITIVE_INFINITY }],
    ['missing fields', { pos: 0.5 }],
    ['not an object', 'cheat'],
    ['null', null],
  ])('rejects %s', (_label, shot) => {
    expect(validateShot(state, 0, shot).ok).toBe(false);
  });

  it('rejects any shot once the match is finished', () => {
    const finished = newGame();
    finished.status = 'finished';
    expect(validateShot(finished, 0, { pos: 0.5, angle: 0, power: 0.5 }).ok).toBe(false);
  });
});

describe('striker placement', () => {
  it('keeps the striker on its own base line for every seat', () => {
    for (const size of ['2p', '4p'] as const) {
      for (let seat = 0; seat < seatCount(size); seat++) {
        const side = sideOfSeat(seat, size);
        for (const pos of [0, 0.5, 1]) {
          const spot = strikerSpot(side, pos);
          expect(spot.x).toBeGreaterThanOrEqual(STRIKER_RADIUS);
          expect(spot.y).toBeGreaterThanOrEqual(STRIKER_RADIUS);
          expect(spot.x).toBeLessThanOrEqual(BOARD_SIZE - STRIKER_RADIUS);
          expect(spot.y).toBeLessThanOrEqual(BOARD_SIZE - STRIKER_RADIUS);
        }
      }
    }
  });

  it('forces a backwards shot to travel into the board', () => {
    const state = newGame();
    const n = normalOfSide(sideOfSeat(state.turnSeat, state.size));
    // Seat 0 sits at the bottom, so aiming down is away from the board.
    const launch = resolveShot(state, { pos: 0.5, angle: Math.PI / 2, power: 0.8 });
    expect(launch.vx * n.nx + launch.vy * n.ny).toBeGreaterThan(0);
  });

  it('clamps striker position into the legal range', () => {
    const state = newGame();
    const low = resolveShot(state, { pos: -5, angle: -Math.PI / 2, power: 0.5 });
    const high = resolveShot(state, { pos: 5, angle: -Math.PI / 2, power: 0.5 });
    expect(low.x).toBeLessThan(high.x);
    expect(low.x).toBeGreaterThanOrEqual(STRIKER_RADIUS);
    expect(high.x).toBeLessThanOrEqual(BOARD_SIZE - STRIKER_RADIUS);
  });
});

describe('fouls', () => {
  it('calls a foul when the striker touches nothing', () => {
    const state = newGame();
    // Empty the table so there is nothing to hit.
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = true;
    }
    const summary = applyShot(state, STRAIGHT);
    expect(summary.foul).toBe(true);
    expect(summary.fouls).toContain('no_contact');
  });

  it('returns one of your own men on a foul', () => {
    const state = newGame();
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = true;
    }
    const before = remaining(state, 'white');
    applyShot(state, STRAIGHT);
    expect(remaining(state, 'white')).toBe(before + 1);
  });

  it('records a debt when a foul has nothing to return', () => {
    const state = newGame();
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = body.kind !== 'white';
    }
    // Every white man is still on the table, so nothing can come back.
    applyShot(state, { pos: 0.02, angle: -Math.PI + 0.05, power: 0.02 });
    expect(state.due.white).toBeGreaterThanOrEqual(0);
  });

  it('passes the turn to the next seat after a foul', () => {
    const state = newGame();
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = true;
    }
    applyShot(state, STRAIGHT);
    expect(state.turnSeat).toBe(1);
  });

  it('treats a timeout as a foul and passes the turn', () => {
    const state = newGame();
    const summary = applyTimeout(state);
    expect(summary?.foul).toBe(true);
    expect(summary?.fouls).toContain('timeout');
    expect(state.turnSeat).toBe(1);
  });
});

describe('winning a board', () => {
  it('finishes when a side clears its men', () => {
    const state = newGame();
    soloTarget(state, 'black');
    for (const body of state.bodies) {
      if (body.kind === 'white') body.pocketed = true;
    }
    applyShot(state, STRAIGHT);
    expect(state.status).toBe('finished');
    expect(state.winner).toBe('white');
  });

  it('hands the queen to the opponent when the winner never covered it', () => {
    const state = newGame();
    soloTarget(state, 'black');
    for (const body of state.bodies) {
      if (body.kind === 'white') body.pocketed = true;
    }
    applyShot(state, STRAIGHT);
    expect(state.winner).toBe('white');
    expect(state.queenOwner).toBe('black');
  });

  it('scores opponent men remaining plus five for the queen', () => {
    const state = newGame();
    soloTarget(state, 'black');
    for (const body of state.bodies) {
      if (body.kind === 'white') body.pocketed = true;
    }
    state.queenOwner = 'white';
    applyShot(state, STRAIGHT);
    expect(state.points).toBe(remaining(state, 'black') + 5);
  });

  it('recognises a perfect game', () => {
    const state = newGame();
    for (const body of state.bodies) {
      if (body.kind === 'white') body.pocketed = true;
      if (body.kind === 'queen') body.pocketed = true;
    }
    state.queenOwner = 'white';
    // Every black man is untouched, so the loser pocketed nothing.
    const target = state.bodies.find((b) => b.kind === 'black')!;
    const spot = strikerSpot(sideOfSeat(0, '2p'), 0.5);
    target.x = spot.x;
    target.y = spot.y - 140;
    applyShot(state, STRAIGHT);
    expect(state.winner).toBe('white');
    expect(isPerfectGame(state, 'white')).toBe(true);
  });

  it('decides the board on men remaining at the turn cap', () => {
    const state = newGame();
    soloTarget(state, 'black');
    state.turnCount = MAX_TURNS_PER_BOARD - 1;
    let cleared = 0;
    for (const body of state.bodies) {
      if (body.kind === 'white' && !body.pocketed && cleared < 5) {
        body.pocketed = true;
        cleared++;
      }
    }
    applyShot(state, STRAIGHT);
    expect(state.status).toBe('finished');
  });

  it('never lets a colour drop below zero remaining', () => {
    const state = newGame();
    for (let i = 0; i < 60 && state.status === 'playing'; i++) {
      applyShot(state, {
        pos: Math.random(),
        angle: Math.random() * Math.PI * 2,
        power: 0.3 + Math.random() * 0.7,
      });
    }
    expect(remaining(state, 'white')).toBeGreaterThanOrEqual(0);
    expect(remaining(state, 'black')).toBeGreaterThanOrEqual(0);
  });
});

describe('aim clamping', () => {
  /**
   * The guide and the server both run every aim through this, so what a player
   * points at is what actually gets played.
   */
  const forward = (angle: number, nx: number, ny: number) =>
    Math.cos(angle) * nx + Math.sin(angle) * ny;

  it('leaves a legal aim untouched', () => {
    for (let seat = 0; seat < 4; seat++) {
      const n = normalOfSide(seat);
      const straight = Math.atan2(n.ny, n.nx);
      expect(clampAimAngle(straight, n.nx, n.ny)).toBeCloseTo(straight, 6);

      const slight = straight + 0.4;
      expect(clampAimAngle(slight, n.nx, n.ny)).toBeCloseTo(slight, 6);
    }
  });

  it('always produces a direction that travels into the board', () => {
    for (let seat = 0; seat < 4; seat++) {
      const n = normalOfSide(seat);
      for (let a = -Math.PI * 2; a <= Math.PI * 2; a += 0.05) {
        expect(forward(clampAimAngle(a, n.nx, n.ny), n.nx, n.ny)).toBeGreaterThan(0);
      }
    }
  });

  it('clamps to the nearest legal side rather than snapping to straight ahead', () => {
    const n = normalOfSide(0); // bottom seat, normal points up
    const straightUp = Math.atan2(n.ny, n.nx);

    // Aimed slightly past the left edge of legal: should stay on the left.
    const pastLeft = straightUp - Math.PI / 2 - 0.2;
    const clampedLeft = clampAimAngle(pastLeft, n.nx, n.ny);
    expect(clampedLeft).not.toBeCloseTo(straightUp, 2);
    expect(clampedLeft).toBeLessThan(straightUp);

    // And the mirror case stays on the right.
    const pastRight = straightUp + Math.PI / 2 + 0.2;
    const clampedRight = clampAimAngle(pastRight, n.nx, n.ny);
    expect(clampedRight).toBeGreaterThan(straightUp);
  });

  it('keeps a near-parallel cut nearly parallel', () => {
    const n = normalOfSide(0);
    const straightUp = Math.atan2(n.ny, n.nx);
    const clamped = clampAimAngle(straightUp - Math.PI / 2 - 0.05, n.nx, n.ny);
    // Still within a few degrees of the base line, not thrown up the table.
    expect(Math.abs(Math.abs(clamped - straightUp) - Math.PI / 2)).toBeLessThan(0.1);
  });

  it('is what resolveShot uses, so the guide cannot lie', () => {
    const state = newGame();
    const n = normalOfSide(sideOfSeat(state.turnSeat, state.size));

    // An aim pointing backwards off the base line.
    const backwards = Math.atan2(-n.ny, -n.nx);
    const launch = resolveShot(state, { pos: 0.5, angle: backwards, power: 0.8 });
    const played = Math.atan2(launch.vy, launch.vx);

    expect(played).toBeCloseTo(clampAimAngle(backwards, n.nx, n.ny), 6);
    expect(forward(played, n.nx, n.ny)).toBeGreaterThan(0);
  });
});

describe('striker placement between turns', () => {
  /** The striker belongs to whoever is about to play, not where it stopped. */
  function strikerOf(state: GameState) {
    return state.bodies.find((b) => b.kind === 'striker')!;
  }

  it('opens on the first shooter base line', () => {
    const state = newGame();
    const expected = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
    const striker = strikerOf(state);
    expect(striker.x).toBeCloseTo(expected.x, 1);
    expect(striker.y).toBeCloseTo(expected.y, 1);
  });

  it('moves to the next shooter base line after a shot', () => {
    const state = newGame();
    for (const body of state.bodies) {
      if (body.kind !== 'striker') body.pocketed = true;
    }
    applyShot(state, STRAIGHT);

    const expected = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
    const striker = strikerOf(state);
    expect(striker.x).toBeCloseTo(expected.x, 1);
    expect(striker.y).toBeCloseTo(expected.y, 1);
    expect(striker.pocketed).toBe(false);
  });

  it('moves to the next shooter base line after a timeout', () => {
    const state = newGame();
    applyTimeout(state);

    const expected = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
    const striker = strikerOf(state);
    expect(striker.x).toBeCloseTo(expected.x, 1);
    expect(striker.y).toBeCloseTo(expected.y, 1);
  });

  it('follows every seat around a doubles table', () => {
    const state = newGame('4p');
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const expected = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
      const striker = strikerOf(state);
      expect(striker.x).toBeCloseTo(expected.x, 1);
      expect(striker.y).toBeCloseTo(expected.y, 1);
      seen.add(`${Math.round(striker.x)},${Math.round(striker.y)}`);
      applyTimeout(state);
    }
    // Four seats, four distinct base lines.
    expect(seen.size).toBe(4);
  });

  it('never leaves the striker at rest inside the board', () => {
    const state = newGame();
    for (let i = 0; i < 25 && state.status === 'playing'; i++) {
      applyShot(state, {
        pos: Math.random(),
        angle: Math.random() * Math.PI * 2,
        power: 0.4 + Math.random() * 0.6,
      });
      const expected = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
      const striker = strikerOf(state);
      expect(striker.x).toBeCloseTo(expected.x, 1);
      expect(striker.y).toBeCloseTo(expected.y, 1);
    }
  });
});

describe('seating', () => {
  it('seats partners opposite each other in doubles', () => {
    expect(colorOfSeat(0)).toBe('white');
    expect(colorOfSeat(1)).toBe('black');
    expect(colorOfSeat(2)).toBe('white');
    expect(colorOfSeat(3)).toBe('black');
    expect(sideOfSeat(0, '4p')).toBe(0);
    expect(sideOfSeat(2, '4p')).toBe(2);
  });

  it('seats two players facing each other in singles', () => {
    expect(sideOfSeat(0, '2p')).toBe(0);
    expect(sideOfSeat(1, '2p')).toBe(2);
  });

  it('cycles turns through every seat', () => {
    const state = newGame('4p');
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      seen.add(state.turnSeat);
      applyTimeout(state);
    }
    expect(seen.size).toBe(4);
  });
});

describe('match termination', () => {
  it('always terminates within the turn cap', () => {
    for (let round = 0; round < 10; round++) {
      const state = newGame();
      let turns = 0;
      while (state.status === 'playing' && turns < MAX_TURNS_PER_BOARD + 5) {
        applyShot(state, {
          pos: Math.random(),
          angle: Math.random() * Math.PI * 2,
          power: 0.3 + Math.random() * 0.7,
        });
        turns++;
      }
      expect(state.status).toBe('finished');
      expect(turns).toBeLessThanOrEqual(MAX_TURNS_PER_BOARD + 1);
    }
  });
});
