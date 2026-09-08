'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface Overview {
  users: { total: number; new_today: number; guests: number };
  matches: { total: number; today: number; live: number; abandoned: number; avg_seconds: number };
  economy: { coins_in_circulation: number; wallets: number };
  moderation: { open_reports: number; open_flags: number; active_bans: number };
  live: { rooms: number; playing: number; seated: number; sessions: number };
  queues: Array<{ mode: string; tier: string; waiting: number }>;
  health: { database: boolean; redis: boolean };
}

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      adminApi<Overview>('/admin/overview')
        .then(setData)
        .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));

    void load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, []);

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-white/40">Loading…</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Overview</h1>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            data.health.database ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
          }`}
        >
          Database {data.health.database ? 'up' : 'down'}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            data.health.redis ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          Redis {data.health.redis ? 'up' : 'fallback'}
        </span>
      </div>

      {(data.moderation.open_reports > 0 || data.moderation.open_flags > 0) && (
        <div className="flex flex-wrap gap-3">
          {data.moderation.open_reports > 0 && (
            <Link
              href="/reports"
              className="panel flex-1 border-amber-400/30 bg-amber-400/10 p-4 transition hover:border-amber-400/60"
            >
              <div className="text-2xl font-bold text-amber-300">{data.moderation.open_reports}</div>
              <div className="text-sm text-white/60">reports waiting for review</div>
            </Link>
          )}
          {data.moderation.open_flags > 0 && (
            <Link
              href="/flags"
              className="panel flex-1 border-red-400/25 bg-red-400/10 p-4 transition hover:border-red-400/50"
            >
              <div className="text-2xl font-bold text-red-300">{data.moderation.open_flags}</div>
              <div className="text-sm text-white/60">unreviewed anti-cheat flags</div>
            </Link>
          )}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Players" value={data.users.total} hint={`${data.users.new_today} new today`} />
        <Card label="Live now" value={data.live.sessions} hint={`${data.live.playing} matches in play`} />
        <Card label="Matches today" value={data.matches.today} hint={`${data.matches.total} all time`} />
        <Card
          label="Avg match"
          value={`${Math.round(data.matches.avg_seconds / 60)}m`}
          hint={`${data.matches.abandoned} abandoned`}
        />
        <Card
          label="Coins in circulation"
          value={Number(data.economy.coins_in_circulation).toLocaleString()}
          hint={`${data.economy.wallets} wallets`}
        />
        <Card label="Guests" value={data.users.guests} hint="unregistered accounts" />
        <Card label="Active bans" value={data.moderation.active_bans} hint="currently enforced" />
        <Card label="Open rooms" value={data.live.rooms} hint={`${data.live.seated} seated`} />
      </section>

      <section className="panel p-4">
        <h2 className="mb-3 text-base font-semibold">Matchmaking queues</h2>
        {data.queues.length === 0 ? (
          <p className="text-sm text-white/40">Nobody is queued right now.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.queues.map((queue) => (
              <span
                key={`${queue.mode}-${queue.tier}`}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm"
              >
                {queue.mode} / {queue.tier}: <strong>{queue.waiting}</strong>
              </span>
            ))}
          </div>
        )}
      </section>

      <p className="text-[11px] text-white/30">
        Coin figures are virtual in-game currency only.
      </p>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-white/35">{hint}</div>}
    </div>
  );
}
