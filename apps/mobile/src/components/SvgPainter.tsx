import React from 'react';
import {
  Circle, ClipPath, Defs, G, LinearGradient, Path, RadialGradient, Rect, Stop,
} from 'react-native-svg';
import type { Paint, Painter, PathCommand, Stroke } from '@carrom/ui';

/**
 * Painter backed by react-native-svg.
 *
 * The web canvas painter mutates a context; SVG has no such thing, so this
 * collects React elements and rebuilds the transform stack itself. The result
 * is that the 20 boards and 100 cosmetics render on mobile from exactly the
 * same drawing code the web uses.
 */
interface TransformFrame {
  transform: string;
  alpha: number;
  clipId: string | null;
}

export class SvgPainter implements Painter {
  private readonly elements: React.ReactNode[] = [];
  private readonly defs: React.ReactNode[] = [];
  private stack: TransformFrame[] = [];
  private current: TransformFrame = { transform: '', alpha: 1, clipId: null };
  private key = 0;
  private gradientId = 0;
  private clipCount = 0;

  private nextKey(): string {
    this.key += 1;
    return `e${this.key}`;
  }

  /** Everything drawn so far, ready to place inside an <Svg>. */
  render(): React.ReactNode {
    return (
      <>
        <Defs>{this.defs}</Defs>
        {this.elements}
      </>
    );
  }

  private push(element: React.ReactElement): void {
    const wrapped = this.current.clipId ? (
      <G key={this.nextKey()} clipPath={`url(#${this.current.clipId})`}>
        {element}
      </G>
    ) : (
      element
    );

    if (this.current.transform || this.current.alpha !== 1) {
      this.elements.push(
        <G
          key={this.nextKey()}
          transform={this.current.transform || undefined}
          opacity={this.current.alpha === 1 ? undefined : this.current.alpha}
        >
          {wrapped}
        </G>,
      );
      return;
    }
    this.elements.push(wrapped);
  }

  save(): void {
    this.stack.push({ ...this.current });
  }

  restore(): void {
    const previous = this.stack.pop();
    if (previous) this.current = previous;
  }

  translate(x: number, y: number): void {
    this.current.transform = `${this.current.transform} translate(${round(x)} ${round(y)})`.trim();
  }

  rotate(radians: number): void {
    const degrees = (radians * 180) / Math.PI;
    this.current.transform = `${this.current.transform} rotate(${round(degrees)})`.trim();
  }

  alpha(value: number): void {
    this.current.alpha = value;
  }

  /** Turn a Paint into either a colour string or a gradient reference. */
  private resolve(paint: Paint): string {
    if (typeof paint === 'string') return paint;

    this.gradientId += 1;
    const id = `grad${this.gradientId}`;
    const stops = paint.stops.map((stop, index) => (
      <Stop
        key={`${id}-${index}`}
        offset={String(Math.max(0, Math.min(1, stop.offset)))}
        stopColor={stripAlpha(stop.color)}
        stopOpacity={String(alphaOf(stop.color))}
      />
    ));

    if (paint.kind === 'linear') {
      this.defs.push(
        <LinearGradient
          key={id}
          id={id}
          x1={String(paint.x1)}
          y1={String(paint.y1)}
          x2={String(paint.x2)}
          y2={String(paint.y2)}
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </LinearGradient>,
      );
    } else {
      this.defs.push(
        <RadialGradient
          key={id}
          id={id}
          cx={String(paint.x)}
          cy={String(paint.y)}
          r={String(Math.max(paint.r, 0.01))}
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </RadialGradient>,
      );
    }

    return `url(#${id})`;
  }

  private strokeProps(stroke?: Stroke) {
    if (!stroke) return {};
    return {
      stroke: stripAlpha(stroke.color),
      strokeOpacity: alphaOf(stroke.color),
      strokeWidth: stroke.width,
      strokeLinecap: stroke.cap ?? 'butt',
      strokeDasharray: stroke.dash?.join(',') ?? undefined,
    } as const;
  }

  private fillProps(fill?: Paint) {
    if (!fill) return { fill: 'none' } as const;
    if (typeof fill === 'string') {
      return { fill: stripAlpha(fill), fillOpacity: alphaOf(fill) } as const;
    }
    return { fill: this.resolve(fill) } as const;
  }

  circle(x: number, y: number, r: number, fill?: Paint, stroke?: Stroke): void {
    if (r <= 0) return;
    this.push(
      <Circle
        key={this.nextKey()}
        cx={x}
        cy={y}
        r={r}
        {...this.fillProps(fill)}
        {...this.strokeProps(stroke)}
      />,
    );
  }

  ring(x: number, y: number, outer: number, inner: number, fill: Paint): void {
    if (outer <= 0) return;
    // Drawn as a stroked circle, which avoids even-odd fill support differences.
    const width = Math.max(0.01, outer - Math.max(0, inner));
    const radius = Math.max(0, inner) + width / 2;
    const color = typeof fill === 'string' ? fill : '#ffffff';
    this.push(
      <Circle
        key={this.nextKey()}
        cx={x}
        cy={y}
        r={radius}
        fill="none"
        stroke={typeof fill === 'string' ? stripAlpha(color) : this.resolve(fill)}
        strokeOpacity={typeof fill === 'string' ? alphaOf(color) : 1}
        strokeWidth={width}
      />,
    );
  }

  wedge(x: number, y: number, r: number, from: number, to: number, fill: Paint): void {
    if (r <= 0) return;
    this.push(
      <Path
        key={this.nextKey()}
        d={wedgePath(x, y, r, from, to)}
        {...this.fillProps(fill)}
      />,
    );
  }

  rect(x: number, y: number, w: number, h: number, fill?: Paint, radius = 0, stroke?: Stroke): void {
    this.push(
      <Rect
        key={this.nextKey()}
        x={x}
        y={y}
        width={w}
        height={h}
        rx={radius || undefined}
        ry={radius || undefined}
        {...this.fillProps(fill)}
        {...this.strokeProps(stroke)}
      />,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Stroke): void {
    this.push(
      <Path
        key={this.nextKey()}
        d={`M${round(x1)} ${round(y1)} L${round(x2)} ${round(y2)}`}
        fill="none"
        {...this.strokeProps(stroke)}
      />,
    );
  }

  path(commands: PathCommand[], fill?: Paint, stroke?: Stroke): void {
    const d = toPathData(commands);
    if (!d) return;
    this.push(
      <Path key={this.nextKey()} d={d} {...this.fillProps(fill)} {...this.strokeProps(stroke)} />,
    );
  }

  clipCircle(x: number, y: number, r: number): void {
    this.clipCount += 1;
    const id = `clip${this.clipCount}`;
    this.defs.push(
      <ClipPath key={id} id={id}>
        <Circle cx={x} cy={y} r={r} />
      </ClipPath>,
    );
    this.current.clipId = id;
  }

  /**
   * SVG filters are expensive on mobile, so a glow is drawn as a few
   * decreasingly opaque rings instead. Visually close, far cheaper.
   */
  glow(x: number, y: number, r: number, color: string, strength = 1): void {
    const base = stripAlpha(color);
    const opacity = alphaOf(color) * strength;
    for (let i = 3; i >= 1; i--) {
      this.push(
        <Circle
          key={this.nextKey()}
          cx={x}
          cy={y}
          r={r * (1 + i * 0.18)}
          fill={base}
          fillOpacity={(opacity * 0.16) / i}
        />,
      );
    }
  }
}

/* --------------------------------- helpers -------------------------------- */

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function toPathData(commands: PathCommand[]): string {
  const parts: string[] = [];
  for (const cmd of commands) {
    switch (cmd.op) {
      case 'M':
        parts.push(`M${round(cmd.x)} ${round(cmd.y)}`);
        break;
      case 'L':
        parts.push(`L${round(cmd.x)} ${round(cmd.y)}`);
        break;
      case 'Q':
        parts.push(`Q${round(cmd.cx)} ${round(cmd.cy)} ${round(cmd.x)} ${round(cmd.y)}`);
        break;
      case 'A': {
        const start = { x: cmd.x + Math.cos(cmd.from) * cmd.r, y: cmd.y + Math.sin(cmd.from) * cmd.r };
        const end = { x: cmd.x + Math.cos(cmd.to) * cmd.r, y: cmd.y + Math.sin(cmd.to) * cmd.r };
        const large = Math.abs(cmd.to - cmd.from) > Math.PI ? 1 : 0;
        const sweep = cmd.to > cmd.from ? 1 : 0;
        parts.push(
          `M${round(start.x)} ${round(start.y)} A${round(cmd.r)} ${round(cmd.r)} 0 ${large} ${sweep} ${round(end.x)} ${round(end.y)}`,
        );
        break;
      }
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join(' ');
}

function wedgePath(x: number, y: number, r: number, from: number, to: number): string {
  const start = { x: x + Math.cos(from) * r, y: y + Math.sin(from) * r };
  const end = { x: x + Math.cos(to) * r, y: y + Math.sin(to) * r };
  const large = Math.abs(to - from) > Math.PI ? 1 : 0;
  const sweep = to > from ? 1 : 0;
  return (
    `M${round(x)} ${round(y)} L${round(start.x)} ${round(start.y)} ` +
    `A${round(r)} ${round(r)} 0 ${large} ${sweep} ${round(end.x)} ${round(end.y)} Z`
  );
}

/** SVG keeps colour and opacity in separate attributes, so split rgba() out. */
function stripAlpha(color: string): string {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (!match) return color;
  const [r, g, b] = match[1].split(',').map((part) => part.trim());
  return `rgb(${r},${g},${b})`;
}

function alphaOf(color: string): number {
  const match = /^rgba\(([^)]+)\)$/i.exec(color.trim());
  if (!match) return 1;
  const parts = match[1].split(',');
  const alpha = Number(parts[3]);
  return Number.isFinite(alpha) ? alpha : 1;
}
