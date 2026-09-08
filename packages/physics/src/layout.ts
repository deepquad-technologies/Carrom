import {
  CENTER, CENTER_CIRCLE_RADIUS, INNER_RING_RADIUS, OUTER_RING_RADIUS,
  PIECE_MASS, PIECE_RADIUS, STRIKER_MASS, STRIKER_RADIUS, BOARD_SIZE,
} from '@carrom/config';
import type { Body, BodyKind } from '@carrom/types';

function make(id: string, kind: BodyKind, x: number, y: number): Body {
  const striker = kind === 'striker';
  return {
    id,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    r: striker ? STRIKER_RADIUS : PIECE_RADIUS,
    m: striker ? STRIKER_MASS : PIECE_MASS,
    pocketed: false,
  };
}

/**
 * Standard opening arrangement: queen at the centre, an inner ring of six
 * alternating men, and an outer ring of twelve laid out so three blacks and
 * three whites radiate outward — the classic "Y".
 */
export function createBodies(): Body[] {
  const bodies: Body[] = [make('queen', 'queen', CENTER, CENTER)];

  for (let i = 0; i < 6; i++) {
    const a = (i * 60 * Math.PI) / 180;
    bodies.push(
      make(
        `in${i}`,
        i % 2 === 0 ? 'black' : 'white',
        CENTER + Math.cos(a) * INNER_RING_RADIUS,
        CENTER + Math.sin(a) * INNER_RING_RADIUS,
      ),
    );
  }

  const blackOuter = new Set([11, 0, 3, 4, 7, 8]);
  for (let j = 0; j < 12; j++) {
    const a = ((j * 30 + 15) * Math.PI) / 180;
    bodies.push(
      make(
        `out${j}`,
        blackOuter.has(j) ? 'black' : 'white',
        CENTER + Math.cos(a) * OUTER_RING_RADIUS,
        CENTER + Math.sin(a) * OUTER_RING_RADIUS,
      ),
    );
  }

  bodies.push(make('striker', 'striker', CENTER, BOARD_SIZE - 97));
  return bodies;
}

/**
 * Find an empty spot to drop a returned piece, spiralling out from the centre
 * so penalties and uncovered queens land where the rules expect them.
 */
export function findFreeSpot(bodies: Body[], r: number): { x: number; y: number } {
  const occupied = bodies.filter((b) => !b.pocketed);
  const clear = (x: number, y: number) =>
    occupied.every((b) => Math.hypot(b.x - x, b.y - y) >= b.r + r + 0.5);

  if (clear(CENTER, CENTER)) return { x: CENTER, y: CENTER };

  for (let ring = 1; ring <= 14; ring++) {
    const radius = ring * (r * 0.9);
    const slots = Math.max(6, Math.round((2 * Math.PI * radius) / (r * 1.6)));
    for (let k = 0; k < slots; k++) {
      const a = (k / slots) * Math.PI * 2 + ring * 0.37;
      const x = CENTER + Math.cos(a) * radius;
      const y = CENTER + Math.sin(a) * radius;
      if (x < r || y < r || x > BOARD_SIZE - r || y > BOARD_SIZE - r) continue;
      if (radius > CENTER_CIRCLE_RADIUS * 3) continue;
      if (clear(x, y)) return { x, y };
    }
  }
  return { x: CENTER, y: CENTER };
}
