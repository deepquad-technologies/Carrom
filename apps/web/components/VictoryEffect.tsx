'use client';

import { useEffect, useRef } from 'react';
import type { VictoryEffect as EffectKind } from '@carrom/content';

/**
 * The flourish over the victory screen.
 *
 * A small particle system on one canvas — cheap enough to run over a modal
 * without dropping frames, and it stops itself once the effect has played out
 * so it never burns battery on a screen the player is just reading.
 *
 * Honours `prefers-reduced-motion`: the effect is skipped entirely rather than
 * slowed down, because a burst of flying particles is exactly what that
 * setting exists to prevent.
 */
interface VictoryEffectProps {
  effect: EffectKind;
  primary: string;
  secondary: string;
  durationMs: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  spin: number;
  shape: 'dot' | 'strip' | 'spark';
}

export default function VictoryEffect({
  effect,
  primary,
  secondary,
  durationMs,
}: VictoryEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;

    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const particles: Particle[] = [];
    const rings: Array<{ x: number; y: number; r: number; life: number }> = [];
    const bolts: Array<{ points: Array<[number, number]>; life: number }> = [];
    const started = performance.now();
    let lastBurst = 0;

    const rand = (min: number, max: number) => min + Math.random() * (max - min);
    const pick = () => (Math.random() < 0.5 ? primary : secondary);

    function burst(cx: number, cy: number, count: number, speed: number, shape: Particle['shape']) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const v = rand(speed * 0.35, speed);
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * v,
          vy: Math.sin(angle) * v,
          life: 0,
          maxLife: rand(700, 1500),
          size: rand(2.5, 6),
          color: pick(),
          spin: rand(-0.2, 0.2),
          shape,
        });
      }
    }

    function makeBolt(): Array<[number, number]> {
      const points: Array<[number, number]> = [];
      let x = rand(width * 0.2, width * 0.8);
      let y = -20;
      while (y < height * 0.75) {
        points.push([x, y]);
        x += rand(-60, 60);
        y += rand(40, 90);
      }
      return points;
    }

    /** Seed whatever the effect starts with. */
    switch (effect) {
      case 'golden_burst':
        burst(width / 2, height * 0.45, 140, 9, 'spark');
        break;
      case 'shockwave':
        rings.push({ x: width / 2, y: height * 0.45, r: 0, life: 0 });
        break;
      case 'crown':
      case 'champion_entrance':
        burst(width / 2, height * 0.42, 90, 7, 'spark');
        rings.push({ x: width / 2, y: height * 0.42, r: 0, life: 0 });
        break;
      default:
        break;
    }

    const step = (now: number) => {
      const elapsed = now - started;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      /* ----------------------------- emitters ----------------------------- */

      if (elapsed < durationMs * 0.75) {
        switch (effect) {
          case 'confetti':
            for (let i = 0; i < 3; i++) {
              particles.push({
                x: rand(0, width),
                y: -12,
                vx: rand(-0.6, 0.6),
                vy: rand(1.6, 3.6),
                life: 0,
                maxLife: rand(2200, 3600),
                size: rand(4, 9),
                color: pick(),
                spin: rand(-0.25, 0.25),
                shape: 'strip',
              });
            }
            break;

          case 'fireworks':
            if (now - lastBurst > 380) {
              lastBurst = now;
              burst(rand(width * 0.2, width * 0.8), rand(height * 0.2, height * 0.55), 60, 7, 'spark');
            }
            break;

          case 'lightning':
            if (now - lastBurst > 260) {
              lastBurst = now;
              bolts.push({ points: makeBolt(), life: 0 });
            }
            break;

          case 'aurora':
            for (let i = 0; i < 2; i++) {
              particles.push({
                x: rand(0, width),
                y: rand(height * 0.2, height * 0.7),
                vx: rand(-0.4, 0.4),
                vy: rand(-0.6, -0.15),
                life: 0,
                maxLife: rand(2000, 3400),
                size: rand(18, 46),
                color: pick(),
                spin: 0,
                shape: 'dot',
              });
            }
            break;

          case 'champion_entrance':
            if (now - lastBurst > 500) {
              lastBurst = now;
              burst(rand(width * 0.25, width * 0.75), rand(height * 0.25, height * 0.5), 40, 6, 'spark');
            }
            break;

          default:
            break;
        }
      }

      /* ------------------------------ rings ------------------------------- */

      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.life += 16;
        ring.r += 9;
        const fade = Math.max(0, 1 - ring.life / 1200);
        if (fade <= 0) {
          rings.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.strokeStyle = primary;
        ctx.globalAlpha = fade * 0.55;
        ctx.lineWidth = 5 * fade + 1;
        ctx.stroke();
      }

      /* ------------------------------ bolts ------------------------------- */

      for (let i = bolts.length - 1; i >= 0; i--) {
        const bolt = bolts[i];
        bolt.life += 16;
        const fade = Math.max(0, 1 - bolt.life / 320);
        if (fade <= 0) {
          bolts.splice(i, 1);
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(bolt.points[0][0], bolt.points[0][1]);
        for (const [x, y] of bolt.points.slice(1)) ctx.lineTo(x, y);
        ctx.strokeStyle = primary;
        ctx.globalAlpha = fade;
        ctx.lineWidth = 3;
        ctx.shadowColor = secondary;
        ctx.shadowBlur = 18;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      /* ---------------------------- particles ----------------------------- */

      const gravity = effect === 'aurora' ? 0 : 0.045;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += 16;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }

        p.vy += gravity;
        p.x += p.vx;
        p.y += p.vy;

        const fade = 1 - p.life / p.maxLife;
        ctx.globalAlpha = effect === 'aurora' ? fade * 0.22 : fade;
        ctx.fillStyle = p.color;

        if (p.shape === 'strip') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.life * p.spin * 0.02);
          ctx.fillRect(-p.size / 2, -p.size, p.size, p.size * 2);
          ctx.restore();
        } else if (p.shape === 'spark') {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * fade, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;

      const done =
        elapsed > durationMs && particles.length === 0 && rings.length === 0 && bolts.length === 0;
      if (!done) {
        frameRef.current = requestAnimationFrame(step);
      }
    };

    frameRef.current = requestAnimationFrame(step);

    return () => {
      window.removeEventListener('resize', resize);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [effect, primary, secondary, durationMs]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
