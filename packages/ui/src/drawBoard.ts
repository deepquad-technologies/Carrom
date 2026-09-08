import {
  BASE_CIRCLE_RADIUS, BASE_LINE_GAP, BOARD_SIZE, CENTER, CENTER_CIRCLE_RADIUS,
  POCKETS, POCKET_RADIUS,
} from '@carrom/config';
import type { BoardTheme } from '@carrom/content';
import { baseLine } from '@carrom/game-engine';
import {
  darken, lighten, mix, polar, seededRandom, withAlpha,
  type Painter, type PathCommand,
} from './painter';

/**
 * Draws one of the 20 boards.
 *
 * The board is treated as a real lit object rather than a flat diagram: a key
 * light sits above and to the left, the frame carries a bevel that catches it,
 * the bed has a lacquer sheen and an edge vignette, and the whole thing rests
 * on a soft contact shadow. Everything is derived from the theme record, so
 * adding a board stays a data change.
 *
 * Contrast between the bed and the men is protected throughout — the sheen and
 * vignette are deliberately gentle, because a board that looks expensive but
 * plays badly is a worse board.
 */
const TAU = Math.PI * 2;

/** Where the key light sits, as a fraction of the board. */
const LIGHT = { x: 0.32, y: 0.22 };

export interface BoardRenderOptions {
  theme: BoardTheme;
  /** Seconds since the scene started, for the ambient layer. */
  time: number;
  /** Which side is "yours"; the board rotates so you always shoot upward. */
  viewSide?: number;
  /** Draw the ambient layer. Off on low-power devices. */
  ambience?: boolean;
}

export const FRAME_WIDTH = 92;
export const OUTER_SIZE = BOARD_SIZE + FRAME_WIDTH * 2;

/** The full scene, frame included, in board units. */
export function boardExtent(): number {
  return OUTER_SIZE;
}

export function drawBoard(p: Painter, opts: BoardRenderOptions): void {
  const { theme, time } = opts;

  drawBackdrop(p, theme, time, opts.ambience ?? true);

  p.save();
  p.translate(FRAME_WIDTH, FRAME_WIDTH);

  drawContactShadow(p);
  drawFrame(p, theme);
  drawBed(p, theme, time);
  drawMarkings(p, theme);
  drawPockets(p, theme, time);
  drawBedGloss(p, theme);

  p.restore();
}

/* -------------------------------- backdrop -------------------------------- */

function drawBackdrop(p: Painter, theme: BoardTheme, time: number, ambience: boolean): void {
  p.rect(0, 0, OUTER_SIZE, OUTER_SIZE, {
    kind: 'radial',
    x: OUTER_SIZE * LIGHT.x,
    y: OUTER_SIZE * LIGHT.y,
    r: OUTER_SIZE * 1.1,
    stops: [
      { offset: 0, color: lighten(theme.backdropAlt, 0.1) },
      { offset: 0.45, color: theme.backdropAlt },
      { offset: 1, color: darken(theme.backdrop, 0.35) },
    ],
  });

  // A pool of the theme's accent under the board, so it sits in its own light.
  p.circle(OUTER_SIZE / 2, OUTER_SIZE / 2, OUTER_SIZE * 0.52, {
    kind: 'radial',
    x: OUTER_SIZE / 2,
    y: OUTER_SIZE / 2,
    r: OUTER_SIZE * 0.52,
    stops: [
      { offset: 0, color: withAlpha(theme.accent, 0.1) },
      { offset: 0.6, color: withAlpha(theme.accent, 0.04) },
      { offset: 1, color: withAlpha(theme.accent, 0) },
    ],
  });

  if (ambience) drawAmbience(p, theme, time);
}

/** Soft shadow the board casts onto the backdrop. */
function drawContactShadow(p: Painter): void {
  const spread = FRAME_WIDTH * 0.7;
  for (let i = 4; i >= 1; i--) {
    const grow = (spread / 4) * i;
    p.rect(
      -FRAME_WIDTH - grow,
      -FRAME_WIDTH - grow * 0.5 + grow * 1.4,
      BOARD_SIZE + (FRAME_WIDTH + grow) * 2,
      BOARD_SIZE + (FRAME_WIDTH + grow) * 2,
      withAlpha('#000000', 0.1 / i),
      36 + grow,
    );
  }
}

/* ---------------------------------- frame --------------------------------- */

function drawFrame(p: Painter, theme: BoardTheme): void {
  const outer = -FRAME_WIDTH;
  const size = BOARD_SIZE + FRAME_WIDTH * 2;

  // Body of the frame, lit from the top left.
  p.rect(outer, outer, size, size, {
    kind: 'linear',
    x1: outer,
    y1: outer,
    x2: outer + size,
    y2: outer + size,
    stops: [
      { offset: 0, color: lighten(theme.frame, 0.24) },
      { offset: 0.28, color: lighten(theme.frame, 0.06) },
      { offset: 0.62, color: theme.frame },
      { offset: 1, color: darken(theme.frameDark, 0.15) },
    ],
  }, 30);

  drawFrameGrain(p, theme, outer, size);

  // Top and left edges catch the light; bottom and right fall away.
  p.rect(outer + 2, outer + 2, size - 4, size - 4, undefined, 28, {
    color: withAlpha('#ffffff', 0.16),
    width: 3,
  });
  p.path(
    [
      { op: 'M', x: outer + 6, y: outer + size - 6 },
      { op: 'L', x: outer + size - 6, y: outer + size - 6 },
      { op: 'L', x: outer + size - 6, y: outer + 6 },
    ],
    undefined,
    { color: withAlpha('#000000', 0.3), width: 4 },
  );

  // Metallic inlay, double-lined so it reads as inset rather than painted on.
  const inlay = FRAME_WIDTH * 0.3;
  p.rect(outer + inlay, outer + inlay, size - inlay * 2, size - inlay * 2, undefined, 20, {
    color: withAlpha(theme.frameInlay, 0.75),
    width: 3,
  });
  p.rect(
    outer + inlay + 4,
    outer + inlay + 4,
    size - (inlay + 4) * 2,
    size - (inlay + 4) * 2,
    undefined,
    18,
    { color: withAlpha('#000000', 0.25), width: 1.5 },
  );

  drawCornerOrnaments(p, theme, outer, size);

  // The lip where the frame drops to the bed: a bright top edge and a shadow
  // cast inward, which is what makes the bed look recessed.
  p.rect(-12, -12, BOARD_SIZE + 24, BOARD_SIZE + 24, darken(theme.frameDark, 0.3), 12);
  p.rect(-12, -12, BOARD_SIZE + 24, BOARD_SIZE + 24, undefined, 12, {
    color: withAlpha('#ffffff', 0.1),
    width: 2,
  });
}

/** Fine grain across the frame, stable per theme. */
function drawFrameGrain(p: Painter, theme: BoardTheme, outer: number, size: number): void {
  const rng = seededRandom(`${theme.id}-frame`);
  p.save();
  for (let i = 0; i < 60; i++) {
    const y = outer + rng() * size;
    p.line(outer, y, outer + size, y + (rng() - 0.5) * 10, {
      color: withAlpha(rng() > 0.5 ? '#ffffff' : '#000000', 0.03 + rng() * 0.03),
      width: 1 + rng() * 2.5,
    });
  }
  p.restore();
}

/** A small motif in each corner of the frame. */
function drawCornerOrnaments(p: Painter, theme: BoardTheme, outer: number, size: number): void {
  const inset = FRAME_WIDTH * 0.5;
  const corners = [
    [outer + inset, outer + inset],
    [outer + size - inset, outer + inset],
    [outer + size - inset, outer + size - inset],
    [outer + inset, outer + size - inset],
  ] as const;

  for (const [cx, cy] of corners) {
    p.circle(cx, cy, 13, {
      kind: 'radial',
      x: cx - 4,
      y: cy - 4,
      r: 16,
      stops: [
        { offset: 0, color: lighten(theme.frameInlay, 0.3) },
        { offset: 1, color: darken(theme.frameInlay, 0.35) },
      ],
    });
    p.circle(cx, cy, 13, undefined, { color: withAlpha('#000000', 0.35), width: 1.5 });
    p.circle(cx, cy, 5.5, withAlpha(darken(theme.frameDark, 0.3), 0.9));
    p.circle(cx - 3, cy - 3, 3, withAlpha('#ffffff', 0.35));
  }
}

/* ----------------------------------- bed ---------------------------------- */

function drawBed(p: Painter, theme: BoardTheme, time: number): void {
  // Base tone, lit from the key light rather than the geometric centre.
  p.rect(0, 0, BOARD_SIZE, BOARD_SIZE, {
    kind: 'radial',
    x: BOARD_SIZE * LIGHT.x,
    y: BOARD_SIZE * LIGHT.y,
    r: BOARD_SIZE * 1.15,
    stops: [
      { offset: 0, color: lighten(theme.surface, 0.14) },
      { offset: 0.42, color: lighten(theme.surface, 0.03) },
      { offset: 0.78, color: theme.surface },
      { offset: 1, color: darken(theme.surfaceEdge, 0.12) },
    ],
  }, 6);

  p.save();
  p.clipCircle(CENTER, CENTER, BOARD_SIZE);
  drawSurfacePattern(p, theme, time);
  p.restore();

  // Edge vignette: the bed darkens where it meets the frame.
  p.rect(0, 0, BOARD_SIZE, BOARD_SIZE, {
    kind: 'radial',
    x: CENTER,
    y: CENTER,
    r: BOARD_SIZE * 0.78,
    stops: [
      { offset: 0, color: withAlpha('#000000', 0) },
      { offset: 0.66, color: withAlpha('#000000', 0) },
      { offset: 1, color: withAlpha('#000000', 0.22) },
    ],
  }, 6);

  // Inner shadow cast by the frame lip, strongest along the lit edges.
  p.rect(0, 0, BOARD_SIZE, BOARD_SIZE, undefined, 6, {
    color: withAlpha('#000000', 0.22),
    width: 10,
  });
  p.rect(3, 3, BOARD_SIZE - 6, BOARD_SIZE - 6, undefined, 5, {
    color: withAlpha('#000000', 0.1),
    width: 5,
  });
}

/**
 * The lacquer highlight, drawn last so it sits over the markings the way a
 * varnish coat actually would. Kept subtle: this is polish, not glare.
 */
function drawBedGloss(p: Painter, theme: BoardTheme): void {
  p.save();
  p.clipCircle(CENTER, CENTER, BOARD_SIZE);

  // Broad soft sheen around the key light.
  p.circle(BOARD_SIZE * LIGHT.x, BOARD_SIZE * LIGHT.y, BOARD_SIZE * 0.62, {
    kind: 'radial',
    x: BOARD_SIZE * LIGHT.x,
    y: BOARD_SIZE * LIGHT.y,
    r: BOARD_SIZE * 0.62,
    stops: [
      { offset: 0, color: withAlpha('#ffffff', 0.09) },
      { offset: 0.55, color: withAlpha('#ffffff', 0.03) },
      { offset: 1, color: withAlpha('#ffffff', 0) },
    ],
  });

  // A narrow diagonal streak, the giveaway that a surface is polished.
  p.save();
  p.translate(BOARD_SIZE * 0.28, BOARD_SIZE * 0.1);
  p.rotate(-0.62);
  p.rect(-40, -BOARD_SIZE * 0.2, 80, BOARD_SIZE * 1.3, {
    kind: 'linear',
    x1: -40,
    y1: 0,
    x2: 40,
    y2: 0,
    stops: [
      { offset: 0, color: withAlpha('#ffffff', 0) },
      { offset: 0.5, color: withAlpha('#ffffff', 0.055) },
      { offset: 1, color: withAlpha('#ffffff', 0) },
    ],
  });
  p.restore();

  void theme;
  p.restore();
}

function drawSurfacePattern(p: Painter, theme: BoardTheme, time: number): void {
  const rng = seededRandom(theme.id);

  switch (theme.pattern) {
    case 'grain':
      for (let i = 0; i < 70; i++) {
        const y = rng() * BOARD_SIZE;
        p.line(0, y, BOARD_SIZE, y + (rng() - 0.5) * 16, {
          color: withAlpha(rng() > 0.6 ? '#ffffff' : theme.line, 0.03 + rng() * 0.045),
          width: 0.8 + rng() * 2.2,
        });
      }
      break;

    case 'inlay':
      for (const inset of [56, 104]) {
        p.rect(inset, inset, BOARD_SIZE - inset * 2, BOARD_SIZE - inset * 2, undefined, 8, {
          color: withAlpha(theme.circle, 0.24),
          width: 2,
        });
        p.rect(inset + 3, inset + 3, BOARD_SIZE - (inset + 3) * 2, BOARD_SIZE - (inset + 3) * 2, undefined, 8, {
          color: withAlpha('#ffffff', 0.07),
          width: 1,
        });
      }
      break;

    case 'marble':
      for (let i = 0; i < 18; i++) {
        const x0 = rng() * BOARD_SIZE;
        p.path(
          [
            { op: 'M', x: x0, y: 0 },
            { op: 'Q', cx: x0 + (rng() - 0.5) * 320, cy: CENTER, x: x0 + (rng() - 0.5) * 220, y: BOARD_SIZE },
          ],
          undefined,
          { color: withAlpha(rng() > 0.5 ? theme.line : '#ffffff', 0.05 + rng() * 0.06), width: 1.5 + rng() * 7 },
        );
      }
      break;

    case 'lacquer':
      p.rect(0, 0, BOARD_SIZE, BOARD_SIZE, {
        kind: 'linear',
        x1: 0, y1: 0, x2: BOARD_SIZE, y2: BOARD_SIZE,
        stops: [
          { offset: 0, color: withAlpha('#ffffff', 0.12) },
          { offset: 0.5, color: withAlpha('#ffffff', 0) },
          { offset: 1, color: withAlpha('#000000', 0.1) },
        ],
      });
      break;

    case 'neon':
      for (let i = 1; i < 10; i++) {
        const at = (i / 10) * BOARD_SIZE;
        p.line(at, 0, at, BOARD_SIZE, { color: withAlpha(theme.accent, 0.08), width: 1.2 });
        p.line(0, at, BOARD_SIZE, at, { color: withAlpha(theme.accent, 0.08), width: 1.2 });
      }
      break;

    case 'starfield':
      for (let i = 0; i < 120; i++) {
        const x = rng() * BOARD_SIZE;
        const y = rng() * BOARD_SIZE;
        const twinkle = 0.25 + Math.abs(Math.sin(time * 1.4 + i)) * 0.6;
        p.circle(x, y, rng() * 2 + 0.4, withAlpha('#ffffff', 0.2 * twinkle));
      }
      break;

    case 'gold':
      for (let i = 0; i < 40; i++) {
        const a = rng() * TAU;
        const from = polar(CENTER, CENTER, 110 + rng() * 250, a);
        const to = polar(CENTER, CENTER, 130 + rng() * 270, a + 0.12);
        p.line(from.x, from.y, to.x, to.y, { color: withAlpha(theme.accent, 0.14), width: 1.6 });
      }
      break;

    case 'ice':
      for (let i = 0; i < 12; i++) {
        const cx = rng() * BOARD_SIZE;
        const cy = rng() * BOARD_SIZE;
        for (let arm = 0; arm < 6; arm++) {
          const end = polar(cx, cy, 24 + rng() * 28, (arm / 6) * TAU);
          p.line(cx, cy, end.x, end.y, { color: withAlpha('#ffffff', 0.16), width: 1.2 });
        }
      }
      break;

    case 'ember':
      for (let i = 0; i < 28; i++) {
        p.circle(rng() * BOARD_SIZE, rng() * BOARD_SIZE, 10 + rng() * 30, withAlpha(theme.accent, 0.045));
      }
      break;

    case 'sand':
      for (let i = 0; i < 36; i++) {
        const y = rng() * BOARD_SIZE;
        p.path(
          [
            { op: 'M', x: 0, y },
            { op: 'Q', cx: CENTER, cy: y + (rng() - 0.5) * 56, x: BOARD_SIZE, y: y + (rng() - 0.5) * 22 },
          ],
          undefined,
          { color: withAlpha(theme.line, 0.045), width: 1.5 + rng() * 3 },
        );
      }
      break;

    case 'leaf':
      for (let i = 0; i < 20; i++) {
        const cx = rng() * BOARD_SIZE;
        const cy = rng() * BOARD_SIZE;
        const size = 18 + rng() * 36;
        p.path(
          [
            { op: 'M', x: cx, y: cy },
            { op: 'Q', cx: cx + size, cy: cy - size * 0.6, x: cx + size * 1.4, y: cy },
            { op: 'Q', cx: cx + size, cy: cy + size * 0.6, x: cx, y: cy },
            { op: 'Z' },
          ],
          withAlpha(theme.circle, 0.06),
        );
      }
      break;

    case 'petal':
      for (let i = 0; i < 30; i++) {
        p.circle(rng() * BOARD_SIZE, rng() * BOARD_SIZE, 5 + rng() * 13, withAlpha('#ff9ec0', 0.08));
      }
      break;

    case 'circuit':
      for (let i = 0; i < 26; i++) {
        const x = rng() * BOARD_SIZE;
        const y = rng() * BOARD_SIZE;
        const len = 36 + rng() * 130;
        const horizontal = rng() > 0.5;
        p.line(x, y, horizontal ? x + len : x, horizontal ? y : y + len, {
          color: withAlpha(theme.accent, 0.13),
          width: 1.4,
        });
        p.circle(x, y, 2.6, withAlpha(theme.accent, 0.28));
      }
      break;

    case 'stone':
      for (let i = 0; i < 30; i++) {
        p.circle(rng() * BOARD_SIZE, rng() * BOARD_SIZE, 12 + rng() * 32, withAlpha(theme.line, 0.035));
      }
      break;

    case 'wave':
      for (let i = 0; i < 14; i++) {
        const y = (i / 14) * BOARD_SIZE;
        const commands: PathCommand[] = [{ op: 'M', x: 0, y }];
        for (let x = 0; x <= BOARD_SIZE; x += 60) {
          commands.push({ op: 'Q', cx: x + 30, cy: y + 16, x: x + 60, y });
        }
        p.path(commands, undefined, { color: withAlpha(theme.circle, 0.09), width: 1.8 });
      }
      break;

    case 'silk':
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * TAU;
        const from = polar(CENTER, CENTER, 84, a);
        const to = polar(CENTER, CENTER, BOARD_SIZE * 0.64, a);
        p.line(from.x, from.y, to.x, to.y, { color: withAlpha(theme.accent, 0.07), width: 7 });
      }
      break;
  }
}

/* -------------------------------- markings -------------------------------- */

function drawMarkings(p: Painter, theme: BoardTheme): void {
  drawCentreRosette(p, theme);
  drawPocketArrows(p, theme);
  drawBaseLines(p, theme);
}

function drawCentreRosette(p: Painter, theme: BoardTheme): void {
  const r = CENTER_CIRCLE_RADIUS;

  // Faint disc so the centre reads as a marked area, not just an outline.
  p.circle(CENTER, CENTER, r, withAlpha(theme.circle, 0.05));

  // Engraved rings: a dark line with a light one just beneath it.
  for (const [radius, alpha] of [[r, 0.75], [r * 0.62, 0.5]] as const) {
    p.circle(CENTER, CENTER, radius, undefined, {
      color: withAlpha(theme.circle, alpha),
      width: 2.2,
    });
    p.circle(CENTER, CENTER, radius + 1.6, undefined, {
      color: withAlpha('#ffffff', 0.12),
      width: 1,
    });
  }

  // Petal spokes between the rings.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const from = polar(CENTER, CENTER, r * 0.64, a);
    const to = polar(CENTER, CENTER, r * 0.97, a);
    p.line(from.x, from.y, to.x, to.y, {
      color: withAlpha(theme.circle, i % 2 === 0 ? 0.38 : 0.18),
      width: i % 2 === 0 ? 2 : 1.2,
    });
  }

  // Centre boss.
  p.circle(CENTER, CENTER, 26, {
    kind: 'radial',
    x: CENTER - 6,
    y: CENTER - 6,
    r: 30,
    stops: [
      { offset: 0, color: withAlpha(lighten(theme.circle, 0.3), 0.4) },
      { offset: 1, color: withAlpha(theme.circle, 0.16) },
    ],
  });
  p.circle(CENTER, CENTER, 26, undefined, { color: withAlpha(theme.circle, 0.5), width: 1.6 });
}

function drawPocketArrows(p: Painter, theme: BoardTheme): void {
  for (const pocket of POCKETS) {
    const toCentre = Math.atan2(CENTER - pocket.y, CENTER - pocket.x);
    const start = polar(pocket.x, pocket.y, POCKET_RADIUS + 30, toCentre);
    const end = polar(pocket.x, pocket.y, POCKET_RADIUS + 205, toCentre);

    // Engraved: shadow line, then the mark itself.
    p.line(start.x + 1, start.y + 1, end.x + 1, end.y + 1, {
      color: withAlpha('#ffffff', 0.1),
      width: 2.4,
    });
    p.line(start.x, start.y, end.x, end.y, {
      color: withAlpha(theme.line, 0.32),
      width: 2.4,
    });

    const headA = polar(end.x, end.y, 17, toCentre + 2.5);
    const headB = polar(end.x, end.y, 17, toCentre - 2.5);
    p.path(
      [
        { op: 'M', x: end.x, y: end.y },
        { op: 'L', x: headA.x, y: headA.y },
        { op: 'L', x: headB.x, y: headB.y },
        { op: 'Z' },
      ],
      withAlpha(theme.line, 0.32),
    );
  }
}

function drawBaseLines(p: Painter, theme: BoardTheme): void {
  for (let side = 0; side < 4; side++) {
    const { x1, y1, x2, y2 } = baseLine(side);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const gap = BASE_LINE_GAP / 2;

    for (const sign of [-1, 1]) {
      const ax = x1 + nx * gap * sign;
      const ay = y1 + ny * gap * sign;
      const bx = x2 + nx * gap * sign;
      const by = y2 + ny * gap * sign;

      // Highlight under the line makes it read as cut into the surface.
      p.line(ax, ay + 1.5, bx, by + 1.5, { color: withAlpha('#ffffff', 0.14), width: 2.4 });
      p.line(ax, ay, bx, by, { color: withAlpha(theme.line, 0.8), width: 2.4 });
    }

    for (const [cx, cy] of [[x1, y1], [x2, y2]] as const) {
      // Recessed red base circle: shadow ring, gradient fill, rim light.
      p.circle(cx, cy + 2, BASE_CIRCLE_RADIUS, withAlpha('#000000', 0.2));
      p.circle(cx, cy, BASE_CIRCLE_RADIUS, {
        kind: 'radial',
        x: cx - BASE_CIRCLE_RADIUS * 0.3,
        y: cy - BASE_CIRCLE_RADIUS * 0.35,
        r: BASE_CIRCLE_RADIUS * 1.6,
        stops: [
          { offset: 0, color: '#e05a5a' },
          { offset: 0.6, color: '#c62828' },
          { offset: 1, color: '#7f1414' },
        ],
      });
      p.circle(cx, cy, BASE_CIRCLE_RADIUS, undefined, {
        color: withAlpha('#000000', 0.35),
        width: 1.6,
      });
      p.circle(cx - BASE_CIRCLE_RADIUS * 0.28, cy - BASE_CIRCLE_RADIUS * 0.3, BASE_CIRCLE_RADIUS * 0.34, withAlpha('#ffffff', 0.28));
    }
  }
}

/* --------------------------------- pockets -------------------------------- */

function drawPockets(p: Painter, theme: BoardTheme, time: number): void {
  for (const pocket of POCKETS) {
    // The bed curves down into the hole.
    p.circle(pocket.x, pocket.y, POCKET_RADIUS + 20, {
      kind: 'radial',
      x: pocket.x,
      y: pocket.y,
      r: POCKET_RADIUS + 20,
      stops: [
        { offset: 0.55, color: withAlpha('#000000', 0.45) },
        { offset: 0.8, color: withAlpha('#000000', 0.16) },
        { offset: 1, color: withAlpha('#000000', 0) },
      ],
    });

    switch (theme.pocketStyle) {
      case 'ringed':
        p.circle(pocket.x, pocket.y, POCKET_RADIUS + 13, undefined, {
          color: withAlpha(theme.accent, 0.55),
          width: 3,
        });
        break;
      case 'gilded':
        p.circle(pocket.x, pocket.y, POCKET_RADIUS + 12, undefined, {
          color: withAlpha(theme.frameInlay, 0.95),
          width: 5,
        });
        p.circle(pocket.x - 4, pocket.y - 5, POCKET_RADIUS + 12, undefined, {
          color: withAlpha('#ffffff', 0.3),
          width: 2,
        });
        break;
      case 'glow': {
        const pulse = 0.55 + Math.sin(time * 2 + pocket.x) * 0.25;
        p.glow(pocket.x, pocket.y, POCKET_RADIUS + 10, theme.accent, pulse);
        p.circle(pocket.x, pocket.y, POCKET_RADIUS + 9, undefined, {
          color: withAlpha(theme.accent, 0.85),
          width: 3,
        });
        break;
      }
      case 'carved':
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU;
          const from = polar(pocket.x, pocket.y, POCKET_RADIUS + 8, a);
          const to = polar(pocket.x, pocket.y, POCKET_RADIUS + 19, a);
          p.line(from.x, from.y, to.x, to.y, {
            color: withAlpha(theme.pocketRim, 0.55),
            width: 2.5,
          });
        }
        break;
      case 'plain':
      default:
        p.circle(pocket.x, pocket.y, POCKET_RADIUS + 9, undefined, {
          color: withAlpha(theme.pocketRim, 0.85),
          width: 4,
        });
        break;
    }

    // The hole: dark, with the far wall catching a little light so it has depth.
    p.circle(pocket.x, pocket.y, POCKET_RADIUS + 3, {
      kind: 'radial',
      x: pocket.x + POCKET_RADIUS * 0.25,
      y: pocket.y + POCKET_RADIUS * 0.3,
      r: POCKET_RADIUS + 3,
      stops: [
        { offset: 0, color: withAlpha(lighten(theme.pocket, 0.16), 0.95) },
        { offset: 0.45, color: '#05050a' },
        { offset: 1, color: '#000000' },
      ],
    });

    // Bright arc on the near lip, the strongest depth cue of the lot.
    p.path(
      [{ op: 'A', x: pocket.x, y: pocket.y, r: POCKET_RADIUS + 4, from: Math.PI * 1.05, to: Math.PI * 1.95 }],
      undefined,
      { color: withAlpha('#ffffff', 0.22), width: 2.5, cap: 'round' },
    );
  }
}

/* -------------------------------- ambience -------------------------------- */

/** Slow background motion. Cheap to draw and never overlaps the bed. */
function drawAmbience(p: Painter, theme: BoardTheme, time: number): void {
  if (theme.ambience === 'none') return;
  const rng = seededRandom(`${theme.id}-ambience`);
  const count = 34;

  for (let i = 0; i < count; i++) {
    const seedX = rng();
    const seedY = rng();
    const speed = 0.15 + rng() * 0.4;

    switch (theme.ambience) {
      case 'dust':
      case 'shimmer': {
        const x = seedX * OUTER_SIZE;
        const y = (seedY * OUTER_SIZE + time * speed * 18) % OUTER_SIZE;
        p.circle(x, y, 1.5 + rng() * 2, withAlpha('#ffffff', 0.06 + Math.sin(time + i) * 0.03));
        break;
      }
      case 'stars': {
        const x = seedX * OUTER_SIZE;
        const y = seedY * OUTER_SIZE;
        const twinkle = 0.3 + Math.abs(Math.sin(time * 1.6 + i * 0.7)) * 0.7;
        p.circle(x, y, 1 + rng() * 2.4, withAlpha('#ffffff', 0.5 * twinkle));
        break;
      }
      case 'bubbles': {
        const x = seedX * OUTER_SIZE + Math.sin(time * 0.6 + i) * 12;
        const y = OUTER_SIZE - ((seedY * OUTER_SIZE + time * speed * 30) % OUTER_SIZE);
        p.circle(x, y, 3 + rng() * 7, undefined, { color: withAlpha('#ffffff', 0.14), width: 1.4 });
        break;
      }
      case 'petals': {
        const x = (seedX * OUTER_SIZE + Math.sin(time * 0.8 + i) * 40) % OUTER_SIZE;
        const y = (seedY * OUTER_SIZE + time * speed * 26) % OUTER_SIZE;
        p.circle(x, y, 3 + rng() * 4, withAlpha('#ffc0d4', 0.28));
        break;
      }
      case 'embers': {
        const x = seedX * OUTER_SIZE + Math.sin(time * 1.2 + i) * 16;
        const y = OUTER_SIZE - ((seedY * OUTER_SIZE + time * speed * 40) % OUTER_SIZE);
        p.circle(x, y, 1.5 + rng() * 3, withAlpha(mix('#ff5722', '#ffca28', rng()), 0.4));
        break;
      }
      case 'snow': {
        const x = (seedX * OUTER_SIZE + Math.sin(time * 0.5 + i) * 26) % OUTER_SIZE;
        const y = (seedY * OUTER_SIZE + time * speed * 22) % OUTER_SIZE;
        p.circle(x, y, 1.6 + rng() * 2.6, withAlpha('#ffffff', 0.35));
        break;
      }
      case 'fireflies': {
        const x = seedX * OUTER_SIZE + Math.sin(time * 0.7 + i * 2) * 40;
        const y = seedY * OUTER_SIZE + Math.cos(time * 0.5 + i) * 30;
        const glow = 0.2 + Math.abs(Math.sin(time * 2 + i)) * 0.8;
        p.circle(x, y, 2.4, withAlpha('#c6ff5c', 0.7 * glow));
        break;
      }
      case 'scanlines': {
        if (i > 18) break;
        const y = ((i / 18) * OUTER_SIZE + time * 26) % OUTER_SIZE;
        p.line(0, y, OUTER_SIZE, y, { color: withAlpha(theme.accent, 0.05), width: 2 });
        break;
      }
      case 'confetti': {
        const x = (seedX * OUTER_SIZE + Math.sin(time + i) * 30) % OUTER_SIZE;
        const y = (seedY * OUTER_SIZE + time * speed * 34) % OUTER_SIZE;
        const colors = ['#ffd166', '#ff5a9e', '#4dd0e1', '#a5d6a7'];
        p.rect(x, y, 5, 9, withAlpha(colors[i % colors.length], 0.5), 1);
        break;
      }
    }
  }
}

/** A single pocket flash, played when a man drops. */
export function drawPocketFlash(
  p: Painter,
  pocketIndex: number,
  progress: number,
  color: string,
): void {
  if (progress >= 1) return;
  const pocket = POCKETS[pocketIndex % POCKETS.length];
  const x = pocket.x + FRAME_WIDTH;
  const y = pocket.y + FRAME_WIDTH;
  const fade = 1 - progress;

  p.circle(x, y, POCKET_RADIUS * (1 + progress * 2.4), undefined, {
    color: withAlpha(color, fade * 0.7),
    width: 6 * fade + 1,
  });
  p.circle(x, y, POCKET_RADIUS * (1 + progress * 1.4), withAlpha(color, fade * 0.12));
}
