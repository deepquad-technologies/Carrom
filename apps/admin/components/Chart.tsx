'use client';

import { useId, useMemo, useState } from 'react';

/**
 * Small SVG charts.
 *
 * Hand-drawn rather than pulled from a charting library: these render a few
 * dozen points, and a dependency that ships a layout engine and its own theme
 * would cost more than it earns. Everything scales with a viewBox, so the same
 * component works in a sidebar or full width.
 */
export interface Point {
  label: string;
  value: number | null;
}

export interface Series {
  name: string;
  color: string;
  points: Point[];
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

export function LineChart({
  series,
  height = 180,
  format = (n: number) => String(Math.round(n)),
  yLabel,
}: {
  series: Series[];
  height?: number;
  format?(value: number): string;
  yLabel?: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  const width = 720;
  const pad = { top: 12, right: 12, bottom: 26, left: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const count = Math.max(...series.map((s) => s.points.length), 0);
  const max = useMemo(() => {
    const highest = Math.max(
      0,
      ...series.flatMap((s) => s.points.map((p) => p.value ?? 0)),
    );
    return niceMax(highest);
  }, [series]);

  if (count === 0) {
    return (
      <div
        className="grid place-items-center rounded-xl border border-white/8 bg-white/[0.02] text-xs text-white/35"
        style={{ height }}
      >
        No data for this range yet.
      </div>
    );
  }

  const x = (index: number) => pad.left + (count === 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value: number) => pad.top + plotH - (value / max) * plotH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const labels = series[0]?.points ?? [];
  const tickEvery = Math.max(1, Math.ceil(count / 8));

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${series.map((s) => s.name).join(', ')} over time`}
        onMouseLeave={() => setHover(null)}
      >
        {gridLines.map((fraction) => (
          <g key={fraction}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(max * fraction)}
              y2={y(max * fraction)}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
            />
            <text
              x={pad.left - 8}
              y={y(max * fraction) + 3.5}
              textAnchor="end"
              className="fill-white/35"
              style={{ fontSize: 10 }}
            >
              {format(max * fraction)}
            </text>
          </g>
        ))}

        {series.map((line) => {
          // Break the path wherever a point is missing, rather than drawing a
          // straight line through a gap that never happened.
          const segments: string[] = [];
          let current: string[] = [];
          line.points.forEach((point, index) => {
            if (point.value === null || Number.isNaN(point.value)) {
              if (current.length > 1) segments.push(current.join(' '));
              current = [];
              return;
            }
            current.push(`${current.length === 0 ? 'M' : 'L'} ${x(index)} ${y(point.value)}`);
          });
          if (current.length > 1) segments.push(current.join(' '));

          return (
            <g key={line.name}>
              {segments.map((d, i) => (
                <path
                  key={i}
                  d={d}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {hover !== null && line.points[hover]?.value != null && (
                <circle cx={x(hover)} cy={y(line.points[hover]!.value!)} r={3.5} fill={line.color} />
              )}
            </g>
          );
        })}

        {labels.map((point, index) =>
          index % tickEvery === 0 ? (
            <text
              key={`${id}-${index}`}
              x={x(index)}
              y={height - 8}
              textAnchor="middle"
              className="fill-white/30"
              style={{ fontSize: 9 }}
            >
              {point.label}
            </text>
          ) : null,
        )}

        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad.top}
            y2={pad.top + plotH}
            stroke="rgba(255,255,255,0.25)"
            strokeDasharray="3 3"
          />
        )}

        {/* One invisible band per point, so hovering works anywhere in a column. */}
        {labels.map((_, index) => (
          <rect
            key={`hit-${index}`}
            x={x(index) - plotW / Math.max(count, 1) / 2}
            y={pad.top}
            width={plotW / Math.max(count, 1)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>

      <figcaption className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-white/45">
        {series.map((line) => (
          <span key={line.name} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: line.color }} />
            {line.name}
            {hover !== null && line.points[hover]?.value != null && (
              <b className="tabular-nums text-white/80">{format(line.points[hover]!.value!)}</b>
            )}
          </span>
        ))}
        {yLabel && <span className="ml-auto text-white/25">{yLabel}</span>}
        {hover !== null && labels[hover] && (
          <span className="text-white/60">{labels[hover]!.label}</span>
        )}
      </figcaption>
    </figure>
  );
}

export function BarChart({
  points,
  color = '#f2c94c',
  height = 160,
  format = (n: number) => String(Math.round(n)),
}: {
  points: Point[];
  color?: string;
  height?: number;
  format?(value: number): string;
}) {
  const max = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));

  if (points.length === 0) {
    return (
      <div
        className="grid place-items-center rounded-xl border border-white/8 bg-white/[0.02] text-xs text-white/35"
        style={{ height }}
      >
        No data.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {points.map((point) => (
        <div key={point.label} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate text-[11px] text-white/50">{point.label}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-white/[0.05]">
            <div
              className="h-full rounded transition-[width] duration-500"
              style={{ width: `${((point.value ?? 0) / max) * 100}%`, background: color }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-white/70">
            {format(point.value ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}
