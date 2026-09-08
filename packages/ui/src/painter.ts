/**
 * A tiny drawing surface, implemented once for HTML canvas (web) and once for
 * SVG (React Native). Every board and cosmetic is drawn through this interface,
 * so the 20 boards and 100 cosmetics have exactly one implementation shared by
 * both platforms.
 */
export interface GradientStop {
  offset: number;
  color: string;
}

export type Paint =
  | string
  | { kind: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: GradientStop[] }
  | { kind: 'radial'; x: number; y: number; r: number; stops: GradientStop[] };

export interface Stroke {
  color: string;
  width: number;
  dash?: number[];
  cap?: 'butt' | 'round';
}

export type PathCommand =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number }
  | { op: 'A'; x: number; y: number; r: number; from: number; to: number }
  | { op: 'Z' };

export interface Painter {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(radians: number): void;
  /** Multiplies subsequent fills and strokes; 1 is fully opaque. */
  alpha(value: number): void;

  circle(x: number, y: number, r: number, fill?: Paint, stroke?: Stroke): void;
  /** An annulus: filled between two radii. */
  ring(x: number, y: number, outer: number, inner: number, fill: Paint): void;
  /** A pie slice, angles in radians measured from the positive x axis. */
  wedge(x: number, y: number, r: number, from: number, to: number, fill: Paint): void;
  rect(x: number, y: number, w: number, h: number, fill?: Paint, radius?: number, stroke?: Stroke): void;
  line(x1: number, y1: number, x2: number, y2: number, stroke: Stroke): void;
  path(commands: PathCommand[], fill?: Paint, stroke?: Stroke): void;

  /** Restrict subsequent drawing to a disc. Undone by `restore`. */
  clipCircle(x: number, y: number, r: number): void;

  /** A soft outer glow, used for epic and above. */
  glow(x: number, y: number, r: number, color: string, strength?: number): void;
}

/* --------------------------------- helpers -------------------------------- */

export function polar(cx: number, cy: number, r: number, radians: number): { x: number; y: number } {
  return { x: cx + Math.cos(radians) * r, y: cy + Math.sin(radians) * r };
}

/** Mix two hex colours. `t` of 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const c = (k: 'r' | 'g' | 'b') => Math.round(pa[k] + (pb[k] - pa[k]) * t);
  return rgbToHex(c('r'), c('g'), c('b'));
}

export function lighten(color: string, amount: number): string {
  return mix(color, '#ffffff', amount);
}

export function darken(color: string, amount: number): string {
  return mix(color, '#000000', amount);
}

export function withAlpha(color: string, alpha: number): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0, Math.min(1, alpha))})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * A small deterministic hash, so a skin's incidental details (marble veins,
 * circuit traces, star positions) are stable rather than flickering each frame.
 */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    return h / 4294967296;
  };
}
