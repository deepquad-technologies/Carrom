import { describe, expect, it } from 'vitest';
import { BOARD_SIZE, STRIKER_RADIUS } from '@carrom/config';
import { createGame, sideOfSeat, strikerSpot } from '@carrom/game-engine';
import { drawScene, type Painter, type Paint, type Stroke } from '@carrom/ui';
import type { GamePlayer, GameState } from '@carrom/types';

/**
 * Where the striker is drawn.
 *
 * This is the bug players actually felt: dragging the striker changed the aim
 * state, but `drawScene` drew the striker at its *body* position — which the
 * engine parks at the middle of the base line between turns — so the solid
 * striker sat still while only a faint ghost followed the finger. It read as
 * "I cannot move the striker".
 *
 * Testing it through a recording Painter means the assertion is about the draw
 * call itself, not about pixels, so it holds regardless of screen size.
 */

/** A Painter that records every circle it is asked to draw. */
function recorder() {
  const circles: Array<{ x: number; y: number; r: number }> = [];
  const painter: Painter = {
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    alpha() {},
    circle(x: number, y: number, r: number, _fill?: Paint, _stroke?: Stroke) {
      circles.push({ x, y, r });
    },
    ring() {},
    wedge() {},
    rect() {},
    line() {},
    path() {},
    clipCircle() {},
    glow() {},
  };
  return { painter, circles };
}

function seat(index: number): GamePlayer {
  return {
    userId: `p${index}`,
    username: `p${index}`,
    displayName: `Player ${index}`,
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

function board(): GameState {
  return createGame({
    matchId: 'draw-test',
    modeId: 'quick',
    size: '2p',
    players: [seat(0), seat(1)],
    staked: false,
  });
}

/** Did anything get drawn as a striker-sized disc near this point? */
function drewDiscNear(
  circles: Array<{ x: number; y: number; r: number }>,
  x: number,
  y: number,
  tolerance = 6,
): boolean {
  return circles.some(
    (c) =>
      Math.abs(c.r - STRIKER_RADIUS) < 3 && Math.hypot(c.x - x, c.y - y) < tolerance,
  );
}

describe('the striker follows the drag', () => {
  it('draws the striker where the player has moved it, not where it is parked', () => {
    const state = board();
    const side = sideOfSeat(state.turnSeat, state.size);

    // The engine parks the striker at the middle of the base line.
    const parked = strikerSpot(side, 0.5);
    const striker = state.bodies.find((b) => b.kind === 'striker')!;
    striker.x = parked.x;
    striker.y = parked.y;

    // The player has dragged it well to the left.
    const moved = strikerSpot(side, 0.15);

    const { painter, circles } = recorder();
    drawScene(painter, {
      state,
      viewSeat: 0,
      time: 0,
      aim: { pos: 0.15, angle: -Math.PI / 2, power: 0.7, active: true },
    });

    expect(drewDiscNear(circles, moved.x, moved.y), 'striker drawn where dragged').toBe(true);
  });

  it('leaves it at the body position when nobody is aiming', () => {
    // A spectator, or a board being replayed, has no aim — then the striker
    // belongs exactly where the simulation left it.
    const state = board();
    const striker = state.bodies.find((b) => b.kind === 'striker')!;
    striker.x = 260;
    striker.y = 300;

    const { painter, circles } = recorder();
    drawScene(painter, { state, viewSeat: 0, time: 0 });

    expect(drewDiscNear(circles, 260, 300)).toBe(true);
  });

  it('tracks the striker across the whole base line', () => {
    const state = board();
    const side = sideOfSeat(state.turnSeat, state.size);

    for (const pos of [0, 0.25, 0.5, 0.75, 1]) {
      const spot = strikerSpot(side, pos);
      const { painter, circles } = recorder();
      drawScene(painter, {
        state,
        viewSeat: 0,
        time: 0,
        aim: { pos, angle: -Math.PI / 2, power: 0.6, active: false },
      });
      expect(drewDiscNear(circles, spot.x, spot.y), `pos ${pos}`).toBe(true);
    }
  });

  it('keeps the striker inside the board at both extremes', () => {
    // A striker drawn half off the frame would look broken even if the physics
    // were fine.
    const side = sideOfSeat(0, '2p');
    for (const pos of [0, 1]) {
      const spot = strikerSpot(side, pos);
      expect(spot.x).toBeGreaterThan(STRIKER_RADIUS);
      expect(spot.x).toBeLessThan(BOARD_SIZE - STRIKER_RADIUS);
      expect(spot.y).toBeGreaterThan(STRIKER_RADIUS);
      expect(spot.y).toBeLessThan(BOARD_SIZE - STRIKER_RADIUS);
    }
  });

  it('puts the striker on the shooting seat’s own base line', () => {
    // Seat 1 sits opposite, so their striker must appear on the far side —
    // otherwise the second player is dragging a striker that is not theirs.
    const state = board();
    state.turnSeat = 1;

    const bottom = strikerSpot(sideOfSeat(0, '2p'), 0.5);
    const top = strikerSpot(sideOfSeat(1, '2p'), 0.5);
    expect(top.y).not.toBeCloseTo(bottom.y, 0);

    const { painter, circles } = recorder();
    drawScene(painter, {
      state,
      viewSeat: 1,
      time: 0,
      aim: { pos: 0.5, angle: Math.PI / 2, power: 0.6, active: true },
    });

    expect(drewDiscNear(circles, top.x, top.y)).toBe(true);
  });
});
