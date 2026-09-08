'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';
import { BarChart, LineChart, type Point } from '@/components/Chart';

/**
 * Fleet performance.
 *
 * Frame rate, jank, latency and crash rate, taken from the clients themselves.
 * The 10th percentile matters more than the average here: an average of 58 fps
 * hides a tenth of players at 22.
 */
interface PerfResponse {
  hours: number;
  bucketMinutes: number;
  totals: {
    samples: number;
    sessions: number;
    crashes: number;
    fpsAvg: number | null;
    crashRate: number;
  };
  series: Array<{
    bucket: string;
    samples: number;
    fpsAvg: number;
    fpsP10: number;
    jank: number;
    pingP50: number | null;
    pingP95: number | null;
  }>;
  byPlatform: Array<{
    platform: string;
    deviceClass: string;
    samples: number;
    fpsAvg: number;
    jank: number;
  }>;
  errors: Array<{
    kind: string;
    platform: string;
    message: string;
    count: number;
    lastSeen: string;
  }>;
}

interface PruneResponse {
  rules: Array<{ table: string; minDays: number }>;
  runs: Array<{ table: string; deleted: number; runAt: string; olderThan: string }>;
}

const RANGES: Array<[number, string]> = [
  [6, '6h'],
  [24, '24h'],
  [168, '7d'],
  [720, '30d'],
];

export default function PerformancePage() {
  const [hours, setHours] = useState(24);
  const [platform, setPlatform] = useState<string>('all');
  const [data, setData] = useState<PerfResponse | null>(null);
  const [prune, setPrune] = useState<PruneResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ hours: String(hours) });
      if (platform !== 'all') params.set('platform', platform);
      setData(await adminApi<PerfResponse>(`/admin/perf?${params}`));
      setPrune(await adminApi<PruneResponse>('/admin/perf/prune'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [hours, platform]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPrune = async (table: string, minDays: number) => {
    const days = window.prompt(
      `Delete rows from ${table} older than how many days? Minimum ${minDays}.`,
      String(Math.max(minDays, 90)),
    );
    if (!days) return;
    try {
      const result = await adminApi<{ deleted: number }>('/admin/perf/prune', {
        method: 'POST',
        body: { table, olderThanDays: Number(days) },
      });
      window.alert(`Deleted ${result.deleted} rows from ${table}.`);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Prune failed');
    }
  };

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-white/40">Loading…</p>;

  const label = (iso: string) => {
    const date = new Date(iso);
    return data.hours <= 48
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const fpsSeries = [
    {
      name: 'Average FPS',
      color: '#4dd6a0',
      points: data.series.map((row): Point => ({ label: label(row.bucket), value: row.fpsAvg })),
    },
    {
      name: '10th percentile',
      color: '#f2c94c',
      points: data.series.map((row): Point => ({ label: label(row.bucket), value: row.fpsP10 })),
    },
  ];

  const pingSeries = [
    {
      name: 'Ping p50',
      color: '#4aa8f0',
      points: data.series.map((row): Point => ({ label: label(row.bucket), value: row.pingP50 })),
    },
    {
      name: 'Ping p95',
      color: '#f2618c',
      points: data.series.map((row): Point => ({ label: label(row.bucket), value: row.pingP95 })),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Performance</h1>

        <div className="ml-auto flex gap-1">
          {RANGES.map(([value, text]) => (
            <button
              key={value}
              type="button"
              onClick={() => setHours(value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                hours === value ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              {text}
            </button>
          ))}
        </div>

        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs"
        >
          <option value="all">All platforms</option>
          <option value="web">Web</option>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
        </select>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Samples" value={data.totals.samples.toLocaleString()} />
        <Stat label="Sessions" value={data.totals.sessions.toLocaleString()} />
        <Stat
          label="Average FPS"
          value={data.totals.fpsAvg ? data.totals.fpsAvg.toFixed(1) : '—'}
          tone={data.totals.fpsAvg && data.totals.fpsAvg < 40 ? 'bad' : 'good'}
        />
        <Stat
          label="Crash rate"
          value={`${(data.totals.crashRate * 100).toFixed(2)}%`}
          tone={data.totals.crashRate > 0.01 ? 'bad' : 'good'}
        />
      </div>

      <section className="panel p-5">
        <h2 className="mb-3 font-semibold">Frame rate</h2>
        <LineChart series={fpsSeries} yLabel="frames per second" />
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 font-semibold">Latency</h2>
        <LineChart series={pingSeries} yLabel="milliseconds" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">By device</h2>
          <BarChart
            points={data.byPlatform.map((row) => ({
              label: `${row.platform} · ${row.deviceClass}`,
              value: row.fpsAvg,
            }))}
            format={(n) => `${n.toFixed(0)} fps`}
          />
        </section>

        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Top client errors</h2>
          {data.errors.length === 0 ? (
            <p className="py-6 text-center text-xs text-white/35">No errors reported. Good.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.errors.slice(0, 10).map((row, index) => (
                <li
                  key={index}
                  className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs"
                >
                  <span
                    className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                      row.kind === 'crash'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {row.kind}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-white/80">{row.message}</span>
                    <span className="text-white/35">{row.platform}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-white/60">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel p-5">
        <h2 className="mb-1 font-semibold">Retention</h2>
        <p className="mb-3 text-xs text-white/45">
          These tables only grow. Pruning is manual and logged, so nothing disappears without
          someone choosing it.
        </p>

        <div className="flex flex-wrap gap-2">
          {prune?.rules.map((rule) => (
            <button
              key={rule.table}
              type="button"
              onClick={() => void runPrune(rule.table, rule.minDays)}
              className="rounded-lg border border-white/12 bg-white/5 px-3 py-2 text-xs transition hover:bg-white/10"
            >
              Prune <b>{rule.table}</b>
              <span className="ml-1 text-white/35">(keeps {rule.minDays}d)</span>
            </button>
          ))}
        </div>

        {prune && prune.runs.length > 0 && (
          <table className="mt-4 w-full text-xs">
            <thead className="text-left text-white/35">
              <tr>
                <th className="py-1 font-medium">Table</th>
                <th className="py-1 font-medium">Deleted</th>
                <th className="py-1 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {prune.runs.map((run, index) => (
                <tr key={index} className="border-t border-white/6">
                  <td className="py-1.5">{run.table}</td>
                  <td className="py-1.5 tabular-nums">{run.deleted.toLocaleString()}</td>
                  <td className="py-1.5 text-white/45">{new Date(run.runAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold tabular-nums ${
          tone === 'bad' ? 'text-red-300' : tone === 'good' ? 'text-emerald-300' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
