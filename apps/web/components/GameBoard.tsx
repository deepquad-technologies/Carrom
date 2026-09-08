'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STRIKER_RADIUS } from '@carrom/config';
import { boardById } from '@carrom/content';
import { clampAimAngle, normalOfSide, sideOfSeat, strikerSpot } from '@carrom/game-engine';
import type { GameState, Shot } from '@carrom/types';
import {
  CanvasPainter, SCENE_SIZE, drawScene, screenToBoard, viewRotation,
  type AimState, type PocketFlash, type TrailPoint,
} from '@carrom/ui';

/**
 * The board.
 *
 * Two gestures, kept strictly apart so neither can trigger the other:
 *
 *   - **Drag the striker** to slide it along your base line. Releasing never
 *     fires a shot.
 *   - **Drag anywhere else** to aim. The line points from the striker straight
 *     at your pointer, so the aim always follows your finger exactly. Release
 *     to shoot.
 *
 * Power is its own control rather than being derived from drag distance. That
 * was the old design, and it made the two impossible to set independently:
 * aiming at something close forced a weak shot.
 */
interface GameBoardProps {
  state: GameState;
  viewSeat: number;
  interactive: boolean;
  pockets: Array<{ id: string; kind: string; pocketIndex: number; at: number }>;
  trail: TrailPoint[];
  onShoot(shot: Shot): void;
  /** Lower the effect budget on weak devices. */
  ambience?: boolean;
}

type Gesture = 'none' | 'moving' | 'aiming';

/** How far from the striker counts as grabbing it. */
const GRAB_RADIUS = STRIKER_RADIUS * 2.6;

export default function GameBoard({
  state,
  viewSeat,
  interactive,
  pockets,
  trail,
  onShoot,
  ambience = true,
}: GameBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const startedAt = useRef(performance.now());
  const gesture = useRef<Gesture>('none');
  /** Where the current gesture began, for telling a tap from a drag. */
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const movedFar = useRef(false);

  const [size, setSize] = useState(640);
  const [aim, setAim] = useState<AimState>({
    pos: 0.5,
    angle: -Math.PI / 2,
    power: 0.7,
    active: false,
  });

  const side = sideOfSeat(state.turnSeat, state.size);
  const normal = useMemo(() => normalOfSide(side), [side]);

  // Latest values for the render loop, without restarting it every frame.
  const latest = useRef({ state, viewSeat, aim, pockets, trail, interactive, ambience });
  latest.current = { state, viewSeat, aim, pockets, trail, interactive, ambience };

  /**
   * A fresh turn starts from a sensible default rather than the last player's aim.
   *
   * `pos` resets to 0.5 because that is exactly where the engine parks the
   * striker between turns. Leaving it wherever the previous shot ended put the
   * striker you can *see* and the striker you can *grab* in two different
   * places, so touching the visible one missed the grab radius and was treated
   * as an aim drag — which fired a shot nobody asked for.
   */
  useEffect(() => {
    setAim((prev) => ({
      ...prev,
      pos: 0.5,
      angle: Math.atan2(normal.ny, normal.nx),
      active: false,
    }));
  }, [state.turnSeat, normal.nx, normal.ny]);

  /* --------------------------------- sizing -------------------------------- */

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize(Math.max(280, Math.min(box.width, box.height || box.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* --------------------------------- render -------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const render = () => {
      const now = performance.now();
      const current = latest.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const scale = size / SCENE_SIZE;
      ctx.save();
      ctx.scale(scale, scale);

      const painter = new CanvasPainter(ctx);
      const theme = boardById(current.state.boardId);

      const flashes: PocketFlash[] = current.pockets.map((p) => ({
        pocketIndex: p.pocketIndex,
        progress: Math.min(1, (now - p.at) / 700),
        color: p.kind === 'queen' ? '#ff5252' : theme.accent,
      }));

      drawScene(painter, {
        state: current.state,
        viewSeat: current.viewSeat,
        time: (now - startedAt.current) / 1000,
        aim: current.interactive ? current.aim : undefined,
        trail: current.trail,
        flashes,
        ambience: current.ambience,
        showGuide: current.interactive,
      });

      ctx.restore();
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [size]);

  /* -------------------------------- geometry -------------------------------- */

  const boardPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return screenToBoard(
        clientX - rect.left,
        clientY - rect.top,
        rect.width,
        viewRotation(state, viewSeat),
      );
    },
    [state, viewSeat],
  );

  /** Where along this seat's base line a board-space point lands, as 0..1. */
  const posFromPoint = useCallback(
    (point: { x: number; y: number }) => {
      const a = strikerSpot(side, 0);
      const b = strikerSpot(side, 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy || 1;
      return Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    },
    [side],
  );

  /** Aim straight at the pointer, clamped to a direction that is actually legal. */
  const aimAt = useCallback(
    (point: { x: number; y: number }, pos: number) => {
      const spot = strikerSpot(side, pos);
      const dx = point.x - spot.x;
      const dy = point.y - spot.y;
      if (Math.hypot(dx, dy) < STRIKER_RADIUS * 0.5) return null;
      return clampAimAngle(Math.atan2(dy, dx), normal.nx, normal.ny);
    },
    [side, normal.nx, normal.ny],
  );

  /* --------------------------------- input --------------------------------- */

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      event.currentTarget.setPointerCapture(event.pointerId);

      const point = boardPoint(event.clientX, event.clientY);
      if (!point) return;

      startPoint.current = point;
      movedFar.current = false;

      const spot = strikerSpot(side, aim.pos);
      const grabbedStriker = Math.hypot(point.x - spot.x, point.y - spot.y) < GRAB_RADIUS;

      if (grabbedStriker) {
        gesture.current = 'moving';
        setAim((prev) => ({ ...prev, active: false }));
        return;
      }

      gesture.current = 'aiming';
      const angle = aimAt(point, aim.pos);
      setAim((prev) => ({ ...prev, angle: angle ?? prev.angle, active: true }));
    },
    [interactive, boardPoint, side, aim.pos, aimAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive || gesture.current === 'none') return;

      const point = boardPoint(event.clientX, event.clientY);
      if (!point) return;

      const from = startPoint.current;
      if (from && Math.hypot(point.x - from.x, point.y - from.y) > STRIKER_RADIUS) {
        movedFar.current = true;
      }

      if (gesture.current === 'moving') {
        // Project onto the base line, so the striker slides rather than jumps.
        setAim((prev) => ({ ...prev, pos: posFromPoint(point) }));
        return;
      }

      const angle = aimAt(point, aim.pos);
      if (angle !== null) setAim((prev) => ({ ...prev, angle, active: true }));
    },
    [interactive, boardPoint, posFromPoint, aimAt, aim.pos],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      event.currentTarget.releasePointerCapture?.(event.pointerId);

      const finished = gesture.current;
      const dragged = movedFar.current;
      gesture.current = 'none';
      startPoint.current = null;
      movedFar.current = false;
      setAim((prev) => ({ ...prev, active: false }));

      // Moving the striker never shoots. Neither does a tap — that only points
      // the aim somewhere, so you can line a shot up, adjust it, and take it
      // when you are ready. A deliberate drag is the shot.
      if (finished === 'aiming' && dragged) {
        onShoot({ pos: aim.pos, angle: aim.angle, power: aim.power });
      }
    },
    [interactive, aim, onShoot],
  );

  const onPointerCancel = useCallback(() => {
    gesture.current = 'none';
    startPoint.current = null;
    movedFar.current = false;
    setAim((prev) => ({ ...prev, active: false }));
  }, []);

  /* -------------------------------- keyboard -------------------------------- */

  useEffect(() => {
    if (!interactive) return;

    const onKey = (event: KeyboardEvent) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      switch (event.key) {
        case 'ArrowLeft':
          setAim((p) => ({ ...p, pos: Math.max(0, p.pos - step) }));
          break;
        case 'ArrowRight':
          setAim((p) => ({ ...p, pos: Math.min(1, p.pos + step) }));
          break;
        case 'ArrowUp':
          setAim((p) => ({ ...p, power: Math.min(1, p.power + 0.05) }));
          break;
        case 'ArrowDown':
          setAim((p) => ({ ...p, power: Math.max(0.05, p.power - 0.05) }));
          break;
        case 'a':
        case 'A':
          setAim((p) => ({
            ...p,
            angle: clampAimAngle(p.angle - (event.shiftKey ? 0.1 : 0.02), normal.nx, normal.ny),
          }));
          break;
        case 'd':
        case 'D':
          setAim((p) => ({
            ...p,
            angle: clampAimAngle(p.angle + (event.shiftKey ? 0.1 : 0.02), normal.nx, normal.ny),
          }));
          break;
        case ' ':
        case 'Enter':
          event.preventDefault();
          onShoot({ pos: aim.pos, angle: aim.angle, power: aim.power });
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive, aim, onShoot, normal.nx, normal.ny]);

  /* --------------------------------- markup -------------------------------- */

  const powerPercent = Math.round(aim.power * 100);

  return (
    <div className="w-full">
      <div ref={wrapRef} className="relative flex w-full items-center justify-center">
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          style={{ width: size, height: size, touchAction: 'none' }}
          className={`rounded-3xl shadow-card ${interactive ? 'cursor-crosshair' : 'cursor-default'}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          role="img"
          aria-label="Carrom board"
        />

        {interactive && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-xs text-white/75 backdrop-blur">
            Drag the striker to slide it · tap to aim · drag and release to shoot
          </div>
        )}
      </div>

      {interactive && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/10 bg-ink-900/80 px-4 py-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-white/45" htmlFor="power">
            Power
          </label>

          <input
            id="power"
            type="range"
            min={5}
            max={100}
            value={powerPercent}
            onChange={(e) => setAim((p) => ({ ...p, power: Number(e.target.value) / 100 }))}
            className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-brass-400"
            aria-label="Shot power"
          />

          <span className="w-12 text-right text-sm font-bold tabular-nums text-brass-400">
            {powerPercent}%
          </span>

          <button
            type="button"
            className="btn-primary px-5 py-2 text-sm"
            onClick={() => onShoot({ pos: aim.pos, angle: aim.angle, power: aim.power })}
          >
            Shoot
          </button>
        </div>
      )}
    </div>
  );
}
