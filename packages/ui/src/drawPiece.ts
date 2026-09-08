import type { CosmeticItem, SkinAnim, SkinPattern } from '@carrom/content';
import {
  darken, lighten, mix, polar, seededRandom, withAlpha,
  type Paint, type Painter, type PathCommand,
} from './painter';

/**
 * Draws one carrom man or striker in its equipped skin.
 *
 * `time` is seconds since the scene started, which is all the animations need;
 * nothing here reads or writes game state, so a cosmetic can never change how
 * a piece behaves.
 */
export interface PieceStyle {
  item: CosmeticItem;
  /**
   * Which side of the board this man belongs to.
   *
   * A carrom set is a *pair*: nine light men and nine dark ones in the same
   * design. A coin set therefore supplies the design — pattern, accent, rim,
   * animation — while the side decides whether the face is light or dark. That
   * keeps all fifty sets usable by both players and, more importantly, keeps
   * white and black readable at a glance no matter what anyone equips.
   */
  side?: 'light' | 'dark';
  /** The queen keeps a red tint drawn from the set, so it always reads as the queen. */
  queen?: boolean;
  /** Highlight ring, used for the piece under the aim line. */
  highlight?: string;
}

/**
 * A carrom set is white men, black men and one red queen. Those three readings
 * are load-bearing — a player has to tell them apart instantly, from across a
 * phone screen, on any of the twenty boards. So the equipped set contributes a
 * hint of colour and all of the pattern, but the face itself commits to ivory,
 * ebony or red.
 */
const IVORY = '#f7f2e6';
const EBONY = '#17130f';
const QUEEN_RED = '#c62828';

function faceColor(item: CosmeticItem, side: 'light' | 'dark', queen: boolean): string {
  if (queen) return mix(item.base, QUEEN_RED, 0.85);
  return side === 'dark' ? mix(item.base, EBONY, 0.8) : mix(item.base, IVORY, 0.75);
}

const TAU = Math.PI * 2;

function animPhase(anim: SkinAnim, time: number, speed: number): number {
  return time * speed * (anim === 'spin' ? 1.2 : 1);
}

/** Body gradient: a lit sphere rather than a flat disc. */
function facePaint(item: CosmeticItem, r: number, queen: boolean, side: 'light' | 'dark'): Paint {
  const base = faceColor(item, side, queen);
  return {
    kind: 'radial',
    x: -r * 0.3,
    y: -r * 0.35,
    r: r * 1.5,
    stops: [
      { offset: 0, color: lighten(base, 0.32) },
      { offset: 0.55, color: base },
      { offset: 1, color: darken(base, 0.28) },
    ],
  };
}

export function drawPiece(
  p: Painter,
  x: number,
  y: number,
  r: number,
  style: PieceStyle,
  time = 0,
): void {
  const { item, queen = false, side = 'light' } = style;

  // A dark face needs a brighter pattern and edge, or the design disappears.
  const accent = queen
    ? mix(item.accent, '#ff6b6b', 0.4)
    : side === 'dark'
      ? lighten(item.accent, 0.35)
      : item.accent;
  const rim = side === 'dark' ? mix(item.rim, EBONY, 0.5) : mix(item.rim, '#b9a888', 0.35);
  const phase = animPhase(item.anim, time, item.speed);

  p.save();

  if (item.glow) {
    const pulse = item.anim === 'pulse' ? 0.7 + Math.sin(phase * 3) * 0.3 : 1;
    p.glow(x, y, r, item.glow, pulse);
  }

  // Contact shadow: a soft pool under the piece, offset away from the light.
  for (let i = 3; i >= 1; i--) {
    p.circle(x + r * 0.06 * i, y + r * 0.16 * i, r * (0.86 + i * 0.06), withAlpha('#000000', 0.1));
  }

  p.save();
  p.translate(x, y);

  // The disc edge, a touch wider than the face, so the piece has thickness.
  p.circle(0, r * 0.07, r, darken(faceColor(item, side, queen), 0.45));

  // Face.
  p.circle(0, 0, r, facePaint(item, r, queen, side));

  // Pattern, clipped to the face so nothing bleeds past the edge.
  p.save();
  p.clipCircle(0, 0, r * 0.97);
  drawPattern(p, item.pattern, r, accent, item, phase, queen, faceColor(item, side, queen));
  p.restore();

  // Turned edge, an inner bevel, and the specular the eye reads as "polished".
  p.circle(0, 0, r, undefined, { color: withAlpha(rim, 0.95), width: Math.max(1, r * 0.1) });
  p.circle(0, 0, r * 0.9, undefined, {
    color: withAlpha('#ffffff', side === 'dark' ? 0.16 : 0.3),
    width: Math.max(0.6, r * 0.06),
  });

  // Rim light along the far edge; what stops a dark man reading as a hole.
  p.path(
    [{ op: 'A', x: 0, y: 0, r: r * 0.95, from: Math.PI * 0.15, to: Math.PI * 0.85 }],
    undefined,
    { color: withAlpha('#ffffff', side === 'dark' ? 0.22 : 0.14), width: r * 0.09, cap: 'round' },
  );

  // Two-part specular: a tight hot spot inside a softer bloom.
  p.circle(-r * 0.34, -r * 0.36, r * 0.3, withAlpha('#ffffff', 0.22));
  p.circle(-r * 0.36, -r * 0.4, r * 0.14, withAlpha('#ffffff', 0.5));

  if (queen) {
    // A small crown mark so the queen is unmistakable on every set.
    drawCrown(p, r * 0.42, withAlpha('#ffffff', 0.75));
  }

  p.restore();

  if (style.highlight) {
    p.circle(x, y, r * 1.22, undefined, { color: style.highlight, width: Math.max(1.5, r * 0.12) });
  }

  p.restore();
}

function drawPattern(
  p: Painter,
  pattern: SkinPattern,
  r: number,
  accent: string,
  item: CosmeticItem,
  phase: number,
  queen: boolean,
  face: string,
): void {
  const shimmer = item.anim === 'shimmer' ? 0.6 + Math.sin(phase * 2.2) * 0.4 : 1;
  const flicker = item.anim === 'flicker' ? 0.55 + Math.abs(Math.sin(phase * 5.5)) * 0.45 : 1;
  const aurora = item.anim === 'aurora';
  const spin = item.anim === 'spin' || item.anim === 'orbit' ? phase : 0;
  const rng = seededRandom(item.id);

  const tint = aurora
    ? mix(accent, item.rim, (Math.sin(phase * 1.3) + 1) / 2)
    : accent;
  const ink = withAlpha(tint, Math.min(1, shimmer * flicker));

  switch (pattern) {
    case 'solid':
      break;

    case 'rim':
      p.ring(0, 0, r * 0.82, r * 0.66, ink);
      break;

    case 'rings':
      p.ring(0, 0, r * 0.86, r * 0.74, ink);
      p.ring(0, 0, r * 0.58, r * 0.48, withAlpha(tint, 0.75 * shimmer));
      p.ring(0, 0, r * 0.3, r * 0.22, withAlpha(tint, 0.55 * shimmer));
      break;

    case 'bullseye':
      p.circle(0, 0, r * 0.62, withAlpha(tint, 0.9));
      p.circle(0, 0, r * 0.38, withAlpha(face, 0.95));
      p.circle(0, 0, r * 0.18, ink);
      break;

    case 'checker': {
      p.save();
      p.rotate(spin * 0.4);
      const cell = r / 2.2;
      for (let i = -3; i < 3; i++) {
        for (let j = -3; j < 3; j++) {
          if ((i + j) % 2 !== 0) continue;
          p.rect(i * cell, j * cell, cell, cell, ink);
        }
      }
      p.restore();
      break;
    }

    case 'split':
      p.save();
      p.rotate(spin * 0.5);
      p.rect(-r, -r * 0.16, r * 2, r * 0.32, ink);
      p.restore();
      break;

    case 'swirl': {
      p.save();
      p.rotate(spin);
      for (let arm = 0; arm < 3; arm++) {
        const commands: PathCommand[] = [{ op: 'M', x: 0, y: 0 }];
        const base = (arm / 3) * TAU;
        for (let t = 0; t <= 1.001; t += 0.08) {
          const a = base + t * 2.4;
          const rr = t * r * 0.92;
          commands.push({ op: 'L', ...polar(0, 0, rr, a) });
        }
        p.path(commands, undefined, {
          color: withAlpha(tint, 0.85 * shimmer),
          width: r * 0.16,
          cap: 'round',
        });
      }
      p.restore();
      break;
    }

    case 'star': {
      p.save();
      p.rotate(spin * 0.6);
      const points: PathCommand[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU - Math.PI / 2;
        const rr = i % 2 === 0 ? r * 0.78 : r * 0.32;
        points.push({ op: i === 0 ? 'M' : 'L', ...polar(0, 0, rr, a) });
      }
      points.push({ op: 'Z' });
      p.path(points, ink);
      p.restore();
      break;
    }

    case 'wedges': {
      p.save();
      p.rotate(spin * 0.7);
      for (let i = 0; i < 8; i += 2) {
        p.wedge(0, 0, r * 0.95, (i / 8) * TAU, ((i + 1) / 8) * TAU, withAlpha(tint, 0.85));
      }
      p.restore();
      break;
    }

    case 'marble': {
      for (let vein = 0; vein < 5; vein++) {
        const commands: PathCommand[] = [];
        let vx = (rng() - 0.5) * r * 1.8;
        let vy = -r;
        commands.push({ op: 'M', x: vx, y: vy });
        for (let step = 0; step < 6; step++) {
          vx += (rng() - 0.5) * r * 0.7;
          vy += (r * 2) / 6;
          commands.push({ op: 'L', x: vx, y: vy });
        }
        p.path(commands, undefined, {
          color: withAlpha(tint, 0.35 + rng() * 0.3),
          width: r * (0.05 + rng() * 0.07),
          cap: 'round',
        });
      }
      break;
    }

    case 'circuit': {
      p.save();
      p.rotate(spin * 0.3);
      const trace = { color: withAlpha(tint, 0.9 * flicker), width: r * 0.08, cap: 'round' as const };
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        const start = polar(0, 0, r * 0.2, a);
        const mid = polar(0, 0, r * 0.55, a);
        const end = polar(0, 0, r * 0.85, a + 0.5);
        p.path([{ op: 'M', ...start }, { op: 'L', ...mid }, { op: 'L', ...end }], undefined, trace);
        p.circle(end.x, end.y, r * 0.1, withAlpha(tint, flicker));
      }
      p.ring(0, 0, r * 0.24, r * 0.16, ink);
      p.restore();
      break;
    }

    case 'gem': {
      p.save();
      p.rotate(spin * 0.5);
      const facets = 6;
      for (let i = 0; i < facets; i++) {
        const a0 = (i / facets) * TAU;
        const a1 = ((i + 1) / facets) * TAU;
        const shade = i % 2 === 0 ? 0.85 : 0.55;
        p.path(
          [
            { op: 'M', x: 0, y: 0 },
            { op: 'L', ...polar(0, 0, r * 0.9, a0) },
            { op: 'L', ...polar(0, 0, r * 0.9, a1) },
            { op: 'Z' },
          ],
          withAlpha(tint, shade * shimmer),
        );
      }
      p.circle(0, 0, r * 0.24, withAlpha('#ffffff', 0.6 * shimmer));
      p.restore();
      break;
    }

    case 'flame': {
      const lick = flicker;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + phase * 0.8;
        const height = r * (0.55 + Math.abs(Math.sin(phase * 4 + i)) * 0.35);
        const tip = polar(0, 0, height, a);
        const left = polar(0, 0, r * 0.22, a - 0.42);
        const right = polar(0, 0, r * 0.22, a + 0.42);
        p.path(
          [
            { op: 'M', x: left.x, y: left.y },
            { op: 'Q', cx: tip.x * 0.6, cy: tip.y * 0.6, x: tip.x, y: tip.y },
            { op: 'Q', cx: tip.x * 0.6, cy: tip.y * 0.6, x: right.x, y: right.y },
            { op: 'Z' },
          ],
          withAlpha(tint, 0.75 * lick),
        );
      }
      p.circle(0, 0, r * 0.28, withAlpha(lighten(tint, 0.4), 0.9 * lick));
      break;
    }

    case 'orbit': {
      p.circle(0, 0, r * 0.3, withAlpha(tint, 0.9));
      for (let i = 0; i < 3; i++) {
        const a = phase * (1 + i * 0.35) + (i / 3) * TAU;
        const orbitR = r * (0.5 + i * 0.16);
        const dot = polar(0, 0, orbitR, a);
        p.circle(0, 0, orbitR, undefined, { color: withAlpha(tint, 0.28), width: r * 0.035 });
        p.circle(dot.x, dot.y, r * 0.13, withAlpha(lighten(tint, 0.25), 0.95));
      }
      break;
    }

    case 'scale': {
      const rows = 4;
      for (let row = 0; row < rows; row++) {
        const yy = -r + ((row + 0.5) * (r * 2)) / rows;
        const offset = row % 2 === 0 ? 0 : r * 0.28;
        for (let col = -2; col <= 2; col++) {
          const xx = col * r * 0.56 + offset;
          p.wedge(xx, yy, r * 0.3, Math.PI, TAU, withAlpha(tint, 0.4 + (row / rows) * 0.4));
        }
      }
      break;
    }

    case 'prism': {
      const bands = 6;
      for (let i = 0; i < bands; i++) {
        const t = i / bands;
        const hueShift = mix(tint, item.rim, (Math.sin(phase * 1.6 + i) + 1) / 2);
        p.wedge(0, 0, r * 0.95, t * TAU + spin * 0.3, ((i + 1) / bands) * TAU + spin * 0.3, withAlpha(hueShift, 0.55));
      }
      p.circle(0, 0, r * 0.3, withAlpha('#ffffff', 0.35));
      break;
    }

    case 'crown': {
      p.save();
      p.translate(0, r * 0.08);
      drawCrown(p, r * 0.62, ink);
      p.restore();
      p.ring(0, 0, r * 0.9, r * 0.8, withAlpha(tint, 0.7 * shimmer));
      break;
    }

    case 'blade': {
      p.save();
      p.rotate(spin * 0.4 + Math.PI / 4);
      p.path(
        [
          { op: 'M', x: -r * 0.7, y: r * 0.18 },
          { op: 'L', x: r * 0.62, y: -r * 0.3 },
          { op: 'L', x: r * 0.74, y: -r * 0.1 },
          { op: 'L', x: -r * 0.6, y: r * 0.38 },
          { op: 'Z' },
        ],
        ink,
      );
      p.circle(-r * 0.62, r * 0.3, r * 0.14, withAlpha(item.rim, 0.9));
      p.restore();
      break;
    }
  }

  if (queen) {
    p.ring(0, 0, r * 0.99, r * 0.88, withAlpha('#ff5252', 0.65));
  }
}

function drawCrown(p: Painter, size: number, color: string): void {
  const w = size;
  const h = size * 0.72;
  p.path(
    [
      { op: 'M', x: -w, y: h * 0.5 },
      { op: 'L', x: -w * 0.82, y: -h * 0.45 },
      { op: 'L', x: -w * 0.36, y: h * 0.02 },
      { op: 'L', x: 0, y: -h * 0.72 },
      { op: 'L', x: w * 0.36, y: h * 0.02 },
      { op: 'L', x: w * 0.82, y: -h * 0.45 },
      { op: 'L', x: w, y: h * 0.5 },
      { op: 'Z' },
    ],
    color,
  );
}

/* ---------------------------------- trails --------------------------------- */

export interface TrailPoint {
  x: number;
  y: number;
  /** 0 at the head, 1 at the oldest point. */
  age: number;
}

/**
 * Particle trail behind a moving striker. Purely decorative: it is drawn from
 * positions the physics already produced.
 */
export function drawTrail(
  p: Painter,
  points: TrailPoint[],
  r: number,
  item: CosmeticItem,
  time = 0,
): void {
  if (item.trail === 'none' || points.length < 2) return;

  const rng = seededRandom(item.id);
  const color = item.trail === 'rainbow'
    ? mix(item.accent, item.rim, (Math.sin(time * 3) + 1) / 2)
    : item.accent;

  for (const point of points) {
    const fade = 1 - point.age;
    if (fade <= 0.02) continue;

    switch (item.trail) {
      case 'dust':
      case 'smoke':
        p.circle(point.x, point.y, r * 0.6 * fade, withAlpha('#c8c8c8', 0.18 * fade));
        break;
      case 'fire':
        p.circle(point.x, point.y, r * 0.55 * fade, withAlpha(mix('#ff3d00', '#ffd54f', fade), 0.4 * fade));
        break;
      case 'ice':
        p.circle(point.x, point.y, r * 0.4 * fade, withAlpha('#8ae8ff', 0.35 * fade));
        break;
      case 'electric': {
        const jitter = (rng() - 0.5) * r * 0.6 * fade;
        p.circle(point.x + jitter, point.y + jitter, r * 0.22 * fade, withAlpha(color, 0.6 * fade));
        break;
      }
      case 'stardust':
      case 'sparkle':
        p.circle(point.x + (rng() - 0.5) * r, point.y + (rng() - 0.5) * r, r * 0.16 * fade, withAlpha(color, 0.75 * fade));
        break;
      case 'petals':
        p.circle(point.x, point.y, r * 0.3 * fade, withAlpha('#ff9ec0', 0.4 * fade));
        break;
      case 'rainbow':
        p.circle(point.x, point.y, r * 0.5 * fade, withAlpha(color, 0.35 * fade));
        break;
      case 'void':
        p.circle(point.x, point.y, r * 0.7 * fade, withAlpha('#2a0a4a', 0.4 * fade));
        p.circle(point.x, point.y, r * 0.25 * fade, withAlpha(color, 0.5 * fade));
        break;
    }
  }
}
