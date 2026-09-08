'use client';

import { useEffect, useRef } from 'react';
import type { BoardTheme, CosmeticItem } from '@carrom/content';
import { CanvasPainter, drawBoard, drawPiece, SCENE_SIZE } from '@carrom/ui';

/**
 * Renders a single cosmetic — striker, coin set or board — using the exact
 * drawing code the match uses, so what you see in the locker is what you get on
 * the table. Animation only runs while the tile is on screen.
 */
export function ItemPreview({
  item,
  size = 96,
  animate = true,
  queen = false,
}: {
  item: CosmeticItem;
  size?: number;
  animate?: boolean;
  queen?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const visible = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry.isIntersecting;
      },
      { rootMargin: '120px' },
    );
    observer.observe(canvas);

    const started = performance.now();
    const painter = new CanvasPainter(ctx);
    const radius = size * 0.36;

    const render = () => {
      if (visible.current) {
        const time = animate ? (performance.now() - started) / 1000 : 0;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        drawPiece(painter, size / 2, size / 2, radius, { item, queen }, time);
      }
      frameRef.current = requestAnimationFrame(render);
    };

    frameRef.current = requestAnimationFrame(render);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [item, size, animate, queen]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      aria-label={item.name}
      role="img"
    />
  );
}

/** A small board thumbnail, drawn from the same theme record as the match. */
export function BoardPreview({
  theme,
  size = 160,
  animate = false,
}: {
  theme: BoardTheme;
  size?: number;
  animate?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const started = performance.now();
    const painter = new CanvasPainter(ctx);
    const scale = size / SCENE_SIZE;

    const render = () => {
      const time = animate ? (performance.now() - started) / 1000 : 1.2;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.scale(scale, scale);
      drawBoard(painter, { theme, time, ambience: animate });
      ctx.restore();

      if (animate) frameRef.current = requestAnimationFrame(render);
    };

    render();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [theme, size, animate]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="rounded-xl"
      aria-label={theme.name}
      role="img"
    />
  );
}
