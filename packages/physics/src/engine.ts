import {
  BOARD_SIZE, COLLISION_EPS, DRAG, DT, LINEAR_FRICTION, MAX_SIM_STEPS,
  PIECE_RESTITUTION, POCKETS, POCKET_RADIUS, REST_SPEED, WALL_RESTITUTION,
} from '@carrom/config';
import type { Body, BodyKind } from '@carrom/types';

export interface PocketEvent {
  id: string;
  kind: BodyKind;
}

export interface SimResult {
  pocketed: PocketEvent[];
  /** Id of the first carrom man the striker touched, or null if it hit nothing. */
  firstContact: string | null;
  strikerPocketed: boolean;
  steps: number;
}

interface ContactTracker {
  first: string | null;
}

export function anyMoving(bodies: Body[]): boolean {
  for (const b of bodies) {
    if (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) return true;
  }
  return false;
}

function collide(a: Body, b: Body, contact?: ContactTracker): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rsum = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rsum * rsum || d2 === 0) return;

  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const invA = 1 / a.m;
  const invB = 1 / b.m;
  const invSum = invA + invB;

  // Push the pair apart so stacked pieces never sink into each other.
  const overlap = rsum - d;
  a.x -= nx * overlap * (invA / invSum);
  a.y -= ny * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum);
  b.y += ny * overlap * (invB / invSum);

  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  // Already separating, or only jostling at rest: no impulse.
  if (vn > -COLLISION_EPS) return;

  if (contact && contact.first === null) {
    if (a.kind === 'striker' && b.kind !== 'striker') contact.first = b.id;
    else if (b.kind === 'striker' && a.kind !== 'striker') contact.first = a.id;
  }

  const j = (-(1 + PIECE_RESTITUTION) * vn) / invSum;
  a.vx -= j * nx * invA;
  a.vy -= j * ny * invA;
  b.vx += j * nx * invB;
  b.vy += j * ny * invB;
}

/**
 * Advance the world by one fixed timestep. Deterministic: the same input state
 * always yields the same output, which is what lets clients replay a shot
 * locally instead of streaming positions over the wire.
 */
export function stepWorld(bodies: Body[], contact?: ContactTracker): PocketEvent[] {
  const live: Body[] = [];
  for (const b of bodies) if (!b.pocketed) live.push(b);

  for (const b of live) {
    const s = Math.hypot(b.vx, b.vy);
    if (s > 0) {
      const next = Math.max(0, s - LINEAR_FRICTION * DT) * (1 - DRAG * DT);
      if (next <= REST_SPEED) {
        b.vx = 0;
        b.vy = 0;
      } else {
        const k = next / s;
        b.vx *= k;
        b.vy *= k;
      }
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  for (const b of live) {
    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * WALL_RESTITUTION;
    } else if (b.x > BOARD_SIZE - b.r) {
      b.x = BOARD_SIZE - b.r;
      b.vx = -Math.abs(b.vx) * WALL_RESTITUTION;
    }
    if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy) * WALL_RESTITUTION;
    } else if (b.y > BOARD_SIZE - b.r) {
      b.y = BOARD_SIZE - b.r;
      b.vy = -Math.abs(b.vy) * WALL_RESTITUTION;
    }
  }

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      collide(live[i], live[j], contact);
    }
  }

  const fell: PocketEvent[] = [];
  for (const b of live) {
    for (const p of POCKETS) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < POCKET_RADIUS) {
        b.pocketed = true;
        b.vx = 0;
        b.vy = 0;
        fell.push({ id: b.id, kind: b.kind });
        break;
      }
    }
  }
  return fell;
}

/** Run the world to rest. Mutates `bodies` into their final positions. */
export function simulate(bodies: Body[]): SimResult {
  const contact: ContactTracker = { first: null };
  const pocketed: PocketEvent[] = [];
  let steps = 0;

  while (steps < MAX_SIM_STEPS && anyMoving(bodies)) {
    const fell = stepWorld(bodies, contact);
    for (const f of fell) pocketed.push(f);
    steps++;
  }

  for (const b of bodies) {
    b.vx = 0;
    b.vy = 0;
  }

  const striker = bodies.find((b) => b.kind === 'striker');
  return {
    pocketed,
    firstContact: contact.first,
    strikerPocketed: striker ? striker.pocketed : false,
    steps,
  };
}

export function cloneBodies(bodies: Body[]): Body[] {
  return bodies.map((b) => ({ ...b }));
}
