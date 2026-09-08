import type { Paint, Painter, PathCommand, Stroke } from './painter';

/**
 * Painter backed by an HTML canvas 2D context. Used by the web client, where a
 * single canvas draws the whole board at 60fps.
 */
export class CanvasPainter implements Painter {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  save(): void {
    this.ctx.save();
  }

  restore(): void {
    this.ctx.restore();
  }

  translate(x: number, y: number): void {
    this.ctx.translate(x, y);
  }

  rotate(radians: number): void {
    this.ctx.rotate(radians);
  }

  alpha(value: number): void {
    this.ctx.globalAlpha = value;
  }

  private resolve(paint: Paint): string | CanvasGradient {
    if (typeof paint === 'string') return paint;

    const gradient =
      paint.kind === 'linear'
        ? this.ctx.createLinearGradient(paint.x1, paint.y1, paint.x2, paint.y2)
        : this.ctx.createRadialGradient(paint.x, paint.y, 0, paint.x, paint.y, Math.max(paint.r, 0.01));

    for (const stop of paint.stops) {
      gradient.addColorStop(Math.max(0, Math.min(1, stop.offset)), stop.color);
    }
    return gradient;
  }

  private applyStroke(stroke: Stroke): void {
    this.ctx.strokeStyle = stroke.color;
    this.ctx.lineWidth = stroke.width;
    this.ctx.lineCap = stroke.cap ?? 'butt';
    this.ctx.setLineDash(stroke.dash ?? []);
  }

  circle(x: number, y: number, r: number, fill?: Paint, stroke?: Stroke): void {
    if (r <= 0) return;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) {
      this.ctx.fillStyle = this.resolve(fill);
      this.ctx.fill();
    }
    if (stroke) {
      this.applyStroke(stroke);
      this.ctx.stroke();
    }
  }

  ring(x: number, y: number, outer: number, inner: number, fill: Paint): void {
    if (outer <= 0) return;
    this.ctx.beginPath();
    this.ctx.arc(x, y, outer, 0, Math.PI * 2);
    this.ctx.arc(x, y, Math.max(0, inner), 0, Math.PI * 2, true);
    this.ctx.fillStyle = this.resolve(fill);
    this.ctx.fill('evenodd');
  }

  wedge(x: number, y: number, r: number, from: number, to: number, fill: Paint): void {
    if (r <= 0) return;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.arc(x, y, r, from, to);
    this.ctx.closePath();
    this.ctx.fillStyle = this.resolve(fill);
    this.ctx.fill();
  }

  rect(x: number, y: number, w: number, h: number, fill?: Paint, radius = 0, stroke?: Stroke): void {
    this.ctx.beginPath();
    if (radius > 0 && typeof this.ctx.roundRect === 'function') {
      this.ctx.roundRect(x, y, w, h, radius);
    } else {
      this.ctx.rect(x, y, w, h);
    }
    if (fill) {
      this.ctx.fillStyle = this.resolve(fill);
      this.ctx.fill();
    }
    if (stroke) {
      this.applyStroke(stroke);
      this.ctx.stroke();
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Stroke): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.applyStroke(stroke);
    this.ctx.stroke();
  }

  path(commands: PathCommand[], fill?: Paint, stroke?: Stroke): void {
    this.ctx.beginPath();
    for (const cmd of commands) {
      switch (cmd.op) {
        case 'M':
          this.ctx.moveTo(cmd.x, cmd.y);
          break;
        case 'L':
          this.ctx.lineTo(cmd.x, cmd.y);
          break;
        case 'Q':
          this.ctx.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
          break;
        case 'A':
          this.ctx.arc(cmd.x, cmd.y, cmd.r, cmd.from, cmd.to);
          break;
        case 'Z':
          this.ctx.closePath();
          break;
      }
    }
    if (fill) {
      this.ctx.fillStyle = this.resolve(fill);
      this.ctx.fill();
    }
    if (stroke) {
      this.applyStroke(stroke);
      this.ctx.stroke();
    }
  }

  clipCircle(x: number, y: number, r: number): void {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.clip();
  }

  glow(x: number, y: number, r: number, color: string, strength = 1): void {
    this.ctx.save();
    this.ctx.shadowColor = color;
    this.ctx.shadowBlur = r * 1.2 * strength;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r * 0.92, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.35 * strength;
    this.ctx.fill();
    this.ctx.restore();
  }
}
