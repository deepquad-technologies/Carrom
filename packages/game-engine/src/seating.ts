import {
  BASE_HALF_LENGTH, BASE_OFFSET, BOARD_SIZE, CENTER, STRIKER_RADIUS,
} from '@carrom/config';
import type { Color, TableSize } from '@carrom/types';

/** Physical side of the board a seat sits at: 0 bottom, 1 right, 2 top, 3 left. */
export function sideOfSeat(seat: number, size: TableSize): number {
  return size === '2p' ? (seat === 0 ? 0 : 2) : seat % 4;
}

export function colorOfSeat(seat: number): Color {
  return seat % 2 === 0 ? 'white' : 'black';
}

export function otherColor(c: Color): Color {
  return c === 'white' ? 'black' : 'white';
}

export function seatCount(size: TableSize): number {
  return size === '2p' ? 2 : 4;
}

/** Inward-pointing unit normal for a board side. */
export function normalOfSide(side: number): { nx: number; ny: number } {
  switch (side) {
    case 0: return { nx: 0, ny: -1 };
    case 1: return { nx: -1, ny: 0 };
    case 2: return { nx: 0, ny: 1 };
    default: return { nx: 1, ny: 0 };
  }
}

const REACH = BASE_HALF_LENGTH - STRIKER_RADIUS;

/**
 * Where the striker sits for a given seat. `pos` runs 0..1 left-to-right
 * from that player's own point of view.
 */
export function strikerSpot(side: number, pos: number): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, pos));
  const along = -REACH + t * (REACH * 2);
  switch (side) {
    case 0: return { x: CENTER + along, y: BOARD_SIZE - BASE_OFFSET };
    case 1: return { x: BOARD_SIZE - BASE_OFFSET, y: CENTER - along };
    case 2: return { x: CENTER - along, y: BASE_OFFSET };
    default: return { x: BASE_OFFSET, y: CENTER + along };
  }
}

/** The two endpoints of a base line, for rendering. */
export function baseLine(side: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = strikerSpot(side, 0);
  const b = strikerSpot(side, 1);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/**
 * Bring an aim angle into the half-plane that faces the board.
 *
 * A shot must travel away from your own base line. Rather than discarding an
 * illegal angle — which makes the aim guide freeze and look broken — or
 * snapping it to straight ahead, this slides it to the nearest legal direction.
 * Aim slightly behind the line and you get the sharpest legal cut on that side,
 * which is what the player was reaching for.
 *
 * Both the client guide and the server use this, so what you aim at is what
 * gets played.
 */
export function clampAimAngle(angle: number, nx: number, ny: number): number {
  if (Math.cos(angle) * nx + Math.sin(angle) * ny > 0) return angle;

  const normal = Math.atan2(ny, nx);
  let offset = angle - normal;
  while (offset > Math.PI) offset -= Math.PI * 2;
  while (offset < -Math.PI) offset += Math.PI * 2;

  // Just inside a right angle, so the shot always has some forward travel.
  const limit = Math.PI / 2 - 0.03;
  return normal + (offset >= 0 ? limit : -limit);
}

/** Rotation (radians) that maps board space into a seat's own view. */
export function viewRotationForSide(side: number): number {
  return (-side * Math.PI) / 2;
}
