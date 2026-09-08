import { BOARD_SIZE, PIECE_RADIUS, STRIKER_RADIUS } from '@carrom/config';
import { boardById, coinSetById, strikerById } from '@carrom/content';
import { clampAimAngle, normalOfSide, sideOfSeat, strikerSpot } from '@carrom/game-engine';
import type { Body, GameState } from '@carrom/types';
import { FRAME_WIDTH, OUTER_SIZE, drawBoard, drawPocketFlash } from './drawBoard';
import { drawPiece, drawTrail, type TrailPoint } from './drawPiece';
import { withAlpha, type Painter } from './painter';

/**
 * Composes a full frame: board, men, striker, aim guide and effects.
 *
 * The board is rotated so the viewer always shoots up the screen, whichever
 * side they are seated on. All coordinates below are board units; the caller
 * scales the surface to fit the device.
 */
export interface AimState {
  /** Striker position along the base line, 0..1 from the shooter's view. */
  pos: number;
  /** Aim direction in board space, radians. */
  angle: number;
  /** 0..1. */
  power: number;
  /** True while the player is dragging. */
  active: boolean;
}

export interface PocketFlash {
  pocketIndex: number;
  /** 0 at the moment of the pocket, 1 when the flash has faded. */
  progress: number;
  color: string;
}

export interface SceneOptions {
  state: GameState;
  /** Seat the viewer occupies; the board rotates to put it at the bottom. */
  viewSeat: number;
  time: number;
  aim?: AimState;
  trail?: TrailPoint[];
  flashes?: PocketFlash[];
  /** Turn off the ambient layer to save battery. */
  ambience?: boolean;
  /** Draw the predicted aim line. */
  showGuide?: boolean;
}

export const SCENE_SIZE = OUTER_SIZE;

/** Rotation applied to the whole board so the viewer shoots upward. */
export function viewRotation(state: GameState, viewSeat: number): number {
  return (-sideOfSeat(viewSeat, state.size) * Math.PI) / 2;
}

export function drawScene(p: Painter, opts: SceneOptions): void {
  const { state, viewSeat, time } = opts;
  const theme = boardById(state.boardId);
  const rotation = viewRotation(state, viewSeat);

  p.save();

  // Rotate about the centre of the whole scene.
  p.translate(OUTER_SIZE / 2, OUTER_SIZE / 2);
  p.rotate(rotation);
  p.translate(-OUTER_SIZE / 2, -OUTER_SIZE / 2);

  drawBoard(p, { theme, time, ambience: opts.ambience });

  for (const flash of opts.flashes ?? []) {
    drawPocketFlash(p, flash.pocketIndex, flash.progress, flash.color);
  }

  p.save();
  p.translate(FRAME_WIDTH, FRAME_WIDTH);

  const shooterSeat = state.turnSeat;
  const shooter = state.players.find((pl) => pl.seat === shooterSeat);
  const strikerItem = strikerById(shooter?.strikerSkinId);

  if (opts.trail?.length) {
    drawTrail(p, opts.trail, STRIKER_RADIUS, strikerItem, time);
  }

  if (opts.aim && state.status === 'playing') {
    drawAimGuide(p, state, opts.aim, theme.accent, opts.showGuide !== false);
  }

  drawBodies(p, state, time, state.status === 'playing' ? opts.aim : undefined);

  p.restore();
  p.restore();
}

function drawBodies(p: Painter, state: GameState, time: number, aim?: AimState): void {
  /**
   * Each side's men wear that player's own coin set, so both loadouts are on
   * the table. In solo practice only one seat exists, so the other side borrows
   * that player's set rather than falling back to the default — otherwise both
   * halves of the board would be drawn from the same ivory design.
   */
  const setFor = (kind: Body['kind']) => {
    const wanted = kind === 'black' ? 'black' : 'white';
    const owner =
      state.players.find((pl) => pl.color === wanted) ?? state.players[0];
    return coinSetById(owner?.coinSkinId);
  };

  for (const body of state.bodies) {
    if (body.pocketed || body.kind === 'striker') continue;
    drawPiece(p, body.x, body.y, body.r, {
      item: setFor(body.kind),
      // The set supplies the design; the side decides light or dark.
      side: body.kind === 'black' ? 'dark' : 'light',
      queen: body.kind === 'queen',
    }, time);
  }

  const striker = state.bodies.find((b) => b.kind === 'striker');
  if (striker && !striker.pocketed) {
    const shooter = state.players.find((pl) => pl.seat === state.turnSeat);

    // While a player is placing their shot, the striker belongs where *they*
    // have put it, not where the engine parked it between turns. Drawing the
    // body position here instead is what made dragging look broken: the solid
    // striker sat still at the centre of the base line while only a faint ghost
    // followed the finger.
    const at = aim
      ? strikerSpot(sideOfSeat(state.turnSeat, state.size), aim.pos)
      : { x: striker.x, y: striker.y };

    drawPiece(p, at.x, at.y, striker.r, { item: strikerById(shooter?.strikerSkinId) }, time);
  }
}

/**
 * Aim line plus a first-bounce preview. This is a guide only — the authoritative
 * result always comes from the server simulation.
 */
function drawAimGuide(
  p: Painter,
  state: GameState,
  aim: AimState,
  accent: string,
  showGuide: boolean,
): void {
  const side = sideOfSeat(state.turnSeat, state.size);
  const spot = strikerSpot(side, aim.pos);
  const normal = normalOfSide(side);

  // Draw the angle the server will actually play, so the guide never lies.
  const angle = clampAimAngle(aim.angle, normal.nx, normal.ny);

  // A ring around the striker, so it reads as the thing you are holding. The
  // striker itself is drawn solid at this spot by drawPieces.
  p.circle(spot.x, spot.y, STRIKER_RADIUS + 4, undefined, {
    color: withAlpha(accent, aim.active ? 0.8 : 0.4),
    width: 2,
  });

  if (!showGuide) return;

  const hit = castRay(state, spot.x, spot.y, angle);

  p.line(spot.x, spot.y, hit.x, hit.y, {
    color: withAlpha(accent, aim.active ? 0.85 : 0.4),
    width: 3,
    dash: [14, 10],
    cap: 'round',
  });

  // Where the striker would arrive.
  p.circle(hit.x, hit.y, STRIKER_RADIUS * 0.9, undefined, {
    color: withAlpha(accent, 0.5),
    width: 2,
    dash: [6, 6],
  });

  if (hit.bodyId) {
    const target = state.bodies.find((b) => b.id === hit.bodyId);
    if (target) {
      p.circle(target.x, target.y, target.r * 1.25, undefined, {
        color: withAlpha(accent, 0.8),
        width: 2.5,
      });
      // Rough direction the struck man would take.
      const away = Math.atan2(target.y - hit.y, target.x - hit.x);
      p.line(
        target.x,
        target.y,
        target.x + Math.cos(away) * 90,
        target.y + Math.sin(away) * 90,
        { color: withAlpha(accent, 0.45), width: 2, dash: [8, 8], cap: 'round' },
      );
    }
  }

  if (aim.active) {
    drawPowerArc(p, spot.x, spot.y, angle, aim.power, accent);
  }
}

/** First body or wall the striker would reach travelling in a straight line. */
function castRay(
  state: GameState,
  x: number,
  y: number,
  angle: number,
): { x: number; y: number; bodyId: string | null } {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  let best = Number.POSITIVE_INFINITY;
  let bodyId: string | null = null;

  for (const body of state.bodies) {
    if (body.pocketed || body.kind === 'striker') continue;
    const ox = body.x - x;
    const oy = body.y - y;
    const along = ox * dx + oy * dy;
    if (along <= 0) continue;

    const perp2 = ox * ox + oy * oy - along * along;
    const reach = body.r + STRIKER_RADIUS;
    if (perp2 > reach * reach) continue;

    const back = Math.sqrt(reach * reach - perp2);
    const distance = along - back;
    if (distance > 0 && distance < best) {
      best = distance;
      bodyId = body.id;
    }
  }

  // Otherwise it runs into a cushion.
  if (!Number.isFinite(best)) {
    const limits: number[] = [];
    if (dx > 1e-6) limits.push((BOARD_SIZE - STRIKER_RADIUS - x) / dx);
    if (dx < -1e-6) limits.push((STRIKER_RADIUS - x) / dx);
    if (dy > 1e-6) limits.push((BOARD_SIZE - STRIKER_RADIUS - y) / dy);
    if (dy < -1e-6) limits.push((STRIKER_RADIUS - y) / dy);
    best = Math.max(0, Math.min(...limits.filter((n) => n > 0)));
  }

  return { x: x + dx * best, y: y + dy * best, bodyId };
}

function drawPowerArc(
  p: Painter,
  x: number,
  y: number,
  angle: number,
  power: number,
  accent: string,
): void {
  const radius = STRIKER_RADIUS * 2.1;
  const sweep = Math.PI * 1.6 * Math.max(0.02, power);
  const start = angle - Math.PI * 0.8;

  p.circle(x, y, radius, undefined, { color: withAlpha('#000000', 0.25), width: 7 });
  p.path(
    [{ op: 'A', x, y, r: radius, from: start, to: start + sweep }],
    undefined,
    { color: withAlpha(accent, 0.95), width: 7, cap: 'round' },
  );
}

/* ------------------------------ input mapping ------------------------------ */

/**
 * Convert a pointer position on screen into board space, undoing the view
 * rotation so aiming works identically from every seat.
 */
export function screenToBoard(
  px: number,
  py: number,
  size: number,
  rotation: number,
): { x: number; y: number } {
  const scale = SCENE_SIZE / size;
  const sx = px * scale;
  const sy = py * scale;

  const cx = SCENE_SIZE / 2;
  const cy = SCENE_SIZE / 2;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);

  const dx = sx - cx;
  const dy = sy - cy;

  return {
    x: cx + dx * cos - dy * sin - FRAME_WIDTH,
    y: cy + dx * sin + dy * cos - FRAME_WIDTH,
  };
}

export { FRAME_WIDTH, PIECE_RADIUS, STRIKER_RADIUS };
