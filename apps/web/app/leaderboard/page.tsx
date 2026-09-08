'use client';

import { useEffect, useState } from 'react';
import { RANKS, rankForTrophies } from '@carrom/config';
import { api } from '@/lib/api';
import { Avatar } from '@/components/AppShell';

interface Row {
  position: number;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  level: number;
  country: string | null;
  value: number;
}

type Scope = 'global' | 'country' | 'friends';
type Metric = 'trophies' | 'wins' | 'streak' | 'xp' | 'tournament_points';
type Window = 'weekly' | 'monthly' | 'all_time';

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'trophies', label: 'Trophies' },
  { id: 'wins', label: 'Wins' },
  { id: 'streak', label: 'Best streak' },
  { id: 'xp', label: 'XP' },
  { id: 'tournament_points', label: 'Tournament' },
];

export default function LeaderboardPage() {
  const [scope, setScope] = useState<Scope>('global');
  const [metric, setMetric] = useState<Metric>('trophies');
  const [window_, setWindow] = useState<Window>('all_time');
  const [rows, setRows] = useState<Row[]>([]);
  const [myPosition, setMyPosition] = useState<number | null>(null);
  const [needsCountry, setNeedsCountry] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api<{ rows: Row[]; myPosition?: number | null; needsCountry?: boolean }>(
      `/leaderboard?scope=${scope}&metric=${metric}&window=${window_}`,
    )
      .then((data) => {
        setRows(data.rows);
        setMyPosition(data.myPosition ?? null);
        setNeedsCountry(Boolean(data.needsCountry));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [scope, metric, window_]);

  return (
    <div className="animate-fade-up space-y-4">
      <header>
        <h1 className="font-display text-3xl font-bold">Leaderboard</h1>
        {myPosition && (
          <p className="text-sm text-white/45">You are ranked #{myPosition} worldwide</p>
        )}
      </header>

      <div className="panel space-y-3 p-4">
        <div className="flex gap-2">
          {(['global', 'country', 'friends'] as Scope[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setScope(option)}
              className={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold capitalize transition ${
                scope === option ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {METRICS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`chip ${metric === option.id ? 'border-brass-400/60 text-brass-400' : ''}`}
              onClick={() => setMetric(option.id)}
            >
              {option.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" />
          {(['weekly', 'monthly', 'all_time'] as Window[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`chip ${window_ === option ? 'border-white/40 text-white' : ''}`}
              onClick={() => setWindow(option)}
            >
              {option.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {needsCountry && (
        <p className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          Set your country on your profile to appear on the country board.
        </p>
      )}

      <div className="panel divide-y divide-white/6 overflow-hidden">
        {loading && <p className="p-6 text-center text-sm text-white/40">Loading…</p>}

        {!loading && rows.length === 0 && (
          <p className="p-6 text-center text-sm text-white/40">Nobody here yet.</p>
        )}

        {rows.map((row) => {
          const rank = metric === 'trophies' ? rankForTrophies(Number(row.value)) : null;
          const medal = row.position <= 3 ? ['\u{1F947}', '\u{1F948}', '\u{1F949}'][row.position - 1] : null;

          return (
            <div key={row.user_id} className="flex items-center gap-3 px-4 py-3">
              <span className="w-8 shrink-0 text-center text-sm font-bold tabular-nums text-white/45">
                {medal ?? row.position}
              </span>
              <Avatar url={row.avatar_url} name={row.display_name} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{row.display_name}</div>
                <div className="text-[11px] text-white/40">
                  Lv {row.level}
                  {rank ? ` · ${rank.name}` : ''}
                  {row.country ? ` · ${row.country}` : ''}
                </div>
              </div>
              <span
                className="text-base font-bold tabular-nums"
                style={{ color: rank?.color ?? '#f2c94c' }}
              >
                {Number(row.value).toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      <section className="panel p-4">
        <h2 className="mb-3 font-display text-base font-semibold">Rank ladder</h2>
        <div className="flex flex-wrap gap-2">
          {RANKS.map((rank) => (
            <span
              key={rank.id}
              className="chip"
              style={{ color: rank.color, borderColor: `${rank.color}44` }}
            >
              {rank.name} · {rank.minTrophies}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
