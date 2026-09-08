'use client';

import { useEffect, useState } from 'react';
import { GAME_MODES, formatCoins, rankForTrophies } from '@carrom/config';
import { ACHIEVEMENTS } from '@carrom/content';
import { ApiError, api } from '@/lib/api';
import { Avatar } from '@/components/AppShell';
import { useSession } from '@/lib/session';

interface Achievement {
  id: string;
  name: string;
  description: string;
  target: number;
  progress: number;
  unlockedAt: string | null;
  coins: number;
  xp: number;
  tier: string;
}

interface MatchRow {
  id: string;
  mode_id: string;
  tier_id: string;
  won: boolean | null;
  pocketed: number;
  coins_delta: number | null;
  trophies_delta: number | null;
  created_at: string;
  opponents: string[];
}

interface HistorySummary {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  coins: number;
  pocketed: number;
}

interface HistoryFilters {
  outcome: 'all' | 'win' | 'loss';
  modeId: string;
  days: 'all' | '7' | '30' | '90';
}

interface Friend {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  level: number;
  trophies: number;
  online: boolean;
}

type Tab = 'stats' | 'achievements' | 'history' | 'friends' | 'account';

export default function ProfilePage() {
  const { profile, user, stats, signOut, refresh, setBalance, upgradeGuest, error } = useSession();
  const [tab, setTab] = useState<Tab>('stats');
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [history, setHistory] = useState<MatchRow[]>([]);
  const [historySummary, setHistorySummary] = useState<HistorySummary | null>(null);
  const [filters, setFilters] = useState<HistoryFilters>({ outcome: 'all', modeId: 'all', days: 'all' });
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<{ incoming: Friend[]; outgoing: Friend[] }>({
    incoming: [],
    outgoing: [],
  });
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Friend[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState({ email: '', password: '' });

  useEffect(() => {
    api<{ achievements: Achievement[] }>('/profile/achievements')
      .then((d) => setAchievements(d.achievements))
      .catch(() => undefined);
    void loadFriends();
  }, []);

  // History reloads whenever a filter changes; the server does the filtering so
  // the numbers in the summary always describe exactly what is listed.
  useEffect(() => {
    const params = new URLSearchParams({ limit: '50' });
    if (filters.outcome !== 'all') params.set('outcome', filters.outcome);
    if (filters.modeId !== 'all') params.set('modeId', filters.modeId);
    if (filters.days !== 'all') params.set('days', filters.days);

    let cancelled = false;
    api<{ matches: MatchRow[]; summary: HistorySummary }>(`/profile/history?${params}`)
      .then((d) => {
        if (cancelled) return;
        setHistory(d.matches);
        setHistorySummary(d.summary);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [filters]);

  const loadFriends = async () => {
    await Promise.all([
      api<{ friends: Friend[] }>('/social/friends').then((d) => setFriends(d.friends)).catch(() => undefined),
      api<{ incoming: Friend[]; outgoing: Friend[] }>('/social/requests')
        .then(setRequests)
        .catch(() => undefined),
    ]);
  };

  const claimBonus = async () => {
    try {
      const result = await api<{ ok: boolean; balance: number; message: string }>('/profile/bonus', {
        method: 'POST',
      });
      setBalance(result.balance);
      setNotice(result.message);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not claim that');
    }
  };

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const rank = profile ? rankForTrophies(profile.trophies) : null;
  const unlocked = achievements.filter((a) => a.unlockedAt).length;

  return (
    <div className="animate-fade-up space-y-4">
      <section className="panel p-5">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar url={profile?.avatarUrl ?? null} name={profile?.displayName ?? '?'} size={64} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-bold">{profile?.displayName}</h1>
            <p className="text-sm text-white/45">
              @{profile?.username} · Level {profile?.level}
              {rank ? ` · ${rank.name}` : ''}
            </p>
          </div>

          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-ghost text-xs" onClick={() => void claimBonus()}>
              Free top-up
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Coins" value={formatCoins(profile?.coins ?? 0)} accent />
          <Stat label="Trophies" value={String(profile?.trophies ?? 0)} />
          <Stat label="Win rate" value={`${stats?.winRate ?? 0}%`} />
          <Stat label="Best streak" value={String(profile?.bestStreak ?? 0)} />
        </div>
      </section>

      <nav className="panel flex gap-1 overflow-x-auto p-1.5">
        {(
          [
            ['stats', 'Stats'],
            ['achievements', `Achievements ${unlocked}/${ACHIEVEMENTS.length}`],
            ['history', 'History'],
            ['friends', 'Friends'],
            ['account', 'Account'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
              tab === id ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'stats' && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Games played" value={String(profile?.gamesPlayed ?? 0)} big />
          <Stat label="Wins" value={String(profile?.wins ?? 0)} big />
          <Stat label="Losses" value={String(profile?.losses ?? 0)} big />
          <Stat label="Current streak" value={String(profile?.currentStreak ?? 0)} big />
          <Stat label="Level" value={String(profile?.level ?? 1)} big />
          <Stat
            label="Global rank"
            value={stats?.globalPosition ? `#${stats.globalPosition}` : '—'}
            big
          />
        </section>
      )}

      {tab === 'achievements' && (
        <section className="grid gap-2 sm:grid-cols-2">
          {achievements.map((achievement) => {
            const percent = Math.min(100, (achievement.progress / achievement.target) * 100);
            const done = Boolean(achievement.unlockedAt);
            return (
              <div
                key={achievement.id}
                className={`panel p-4 ${done ? 'border-brass-400/30' : ''}`}
              >
                <div className="flex items-start gap-2">
                  <span className="text-xl">{done ? '\u{1F3C5}' : '\u{1F512}'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{achievement.name}</div>
                    <div className="text-[11px] text-white/45">{achievement.description}</div>
                  </div>
                  <span className="text-[11px] tabular-nums text-white/40">
                    {Math.min(achievement.progress, achievement.target)}/{achievement.target}
                  </span>
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/8">
                  <div
                    className={`h-full rounded-full transition-[width] ${
                      done ? 'bg-brass-400' : 'bg-felt-500'
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            );
          })}
        </section>
      )}

      {tab === 'history' && (
        <>
          <section className="panel p-4">
            <div className="flex flex-wrap gap-2">
              <FilterGroup
                label="Result"
                value={filters.outcome}
                options={[
                  ['all', 'All'],
                  ['win', 'Wins'],
                  ['loss', 'Losses'],
                ]}
                onChange={(value) =>
                  setFilters((prev) => ({ ...prev, outcome: value as HistoryFilters['outcome'] }))
                }
              />
              <FilterGroup
                label="Mode"
                value={filters.modeId}
                options={[
                  ['all', 'All'],
                  ...Object.values(GAME_MODES).map(
                    (mode) => [mode.id, mode.name] as [string, string],
                  ),
                ]}
                onChange={(value) => setFilters((prev) => ({ ...prev, modeId: value }))}
              />
              <FilterGroup
                label="When"
                value={filters.days}
                options={[
                  ['all', 'All time'],
                  ['7', '7 days'],
                  ['30', '30 days'],
                  ['90', '90 days'],
                ]}
                onChange={(value) =>
                  setFilters((prev) => ({ ...prev, days: value as HistoryFilters['days'] }))
                }
              />
            </div>

            {historySummary && historySummary.total > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-white/8 pt-3 sm:grid-cols-4">
                <Summary label="Matches" value={String(historySummary.total)} />
                <Summary
                  label="Win rate"
                  value={`${Math.round(historySummary.winRate * 100)}%`}
                />
                <Summary
                  label="Coins"
                  value={`${historySummary.coins >= 0 ? '+' : '-'}${formatCoins(Math.abs(historySummary.coins))}`}
                />
                <Summary label="Pocketed" value={String(historySummary.pocketed)} />
              </dl>
            )}
          </section>

          <section className="panel divide-y divide-white/6 overflow-hidden">
            {history.length === 0 && (
              <p className="p-6 text-center text-sm text-white/40">
                No matches match those filters.
              </p>
            )}
          {history.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  row.won === true
                    ? 'bg-felt-500/20 text-felt-400'
                    : row.won === false
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-white/8 text-white/45'
                }`}
              >
                {row.won === true ? 'W' : row.won === false ? 'L' : '–'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  vs {row.opponents.join(', ') || 'practice'}
                </div>
                <div className="text-[11px] capitalize text-white/40">
                  {row.mode_id} · {row.tier_id} ·{' '}
                  {new Date(row.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="text-right text-xs tabular-nums">
                <div className={Number(row.coins_delta) > 0 ? 'text-brass-400' : 'text-white/45'}>
                  {Number(row.coins_delta) > 0 ? '+' : ''}
                  {formatCoins(Math.abs(Number(row.coins_delta ?? 0)))}
                </div>
                {row.trophies_delta ? (
                  <div className="text-white/35">
                    {Number(row.trophies_delta) > 0 ? '+' : ''}
                    {row.trophies_delta} {'\u{1F3C6}'}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          </section>
        </>
      )}

      {tab === 'friends' && (
        <section className="space-y-3">
          <div className="panel p-4">
            <div className="flex gap-2">
              <input
                className="field"
                placeholder="Search by username"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost shrink-0"
                disabled={search.length < 2}
                onClick={() =>
                  void api<{ players: Friend[] }>(`/social/search?q=${encodeURIComponent(search)}`)
                    .then((d) => setFound(d.players))
                    .catch(() => setFound([]))
                }
              >
                Search
              </button>
            </div>

            {found.length > 0 && (
              <div className="mt-3 space-y-2">
                {found.map((player) => (
                  <FriendRow
                    key={player.user_id}
                    friend={player}
                    action="Add"
                    onAction={async () => {
                      await api('/social/requests', {
                        method: 'POST',
                        body: { userId: player.user_id },
                      }).catch(() => undefined);
                      setNotice('Request sent');
                      setFound([]);
                      await loadFriends();
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {requests.incoming.length > 0 && (
            <div className="panel p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
                Requests
              </h3>
              <div className="space-y-2">
                {requests.incoming.map((person) => (
                  <FriendRow
                    key={person.user_id}
                    friend={person}
                    action="Accept"
                    onAction={async () => {
                      await api(`/social/requests/${(person as unknown as { id: string }).id}/accept`, {
                        method: 'POST',
                      }).catch(() => undefined);
                      await loadFriends();
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="panel divide-y divide-white/6 overflow-hidden">
            {friends.length === 0 && (
              <p className="p-6 text-center text-sm text-white/40">
                No friends yet. Search above, or add someone you just played.
              </p>
            )}
            {friends.map((friend) => (
              <div key={friend.user_id} className="flex items-center gap-3 px-4 py-3">
                <Avatar url={friend.avatar_url} name={friend.display_name} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{friend.display_name}</div>
                  <div className="text-[11px] text-white/40">
                    Lv {friend.level} · {friend.trophies} {'\u{1F3C6}'}
                  </div>
                </div>
                <span
                  className={`h-2.5 w-2.5 rounded-full ${friend.online ? 'bg-felt-400' : 'bg-white/20'}`}
                  title={friend.online ? 'Online' : 'Offline'}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'account' && (
        <section className="space-y-3">
          {user?.isGuest ? (
            <div className="panel p-5">
              <h3 className="font-display text-lg font-semibold">Save your progress</h3>
              <p className="mt-1 text-sm text-white/50">
                You are playing as a guest. Add an email and password to keep your coins,
                cosmetics and rank on any device.
              </p>

              {error && (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}

              <form
                className="mt-4 space-y-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await upgradeGuest(upgrade).catch(() => undefined);
                  await refresh().catch(() => undefined);
                }}
              >
                <input
                  className="field"
                  type="email"
                  required
                  placeholder="Email"
                  value={upgrade.email}
                  onChange={(e) => setUpgrade({ ...upgrade, email: e.target.value })}
                />
                <input
                  className="field"
                  type="password"
                  required
                  minLength={8}
                  placeholder="Password (8+ characters)"
                  value={upgrade.password}
                  onChange={(e) => setUpgrade({ ...upgrade, password: e.target.value })}
                />
                <button type="submit" className="btn-primary w-full">
                  Save my account
                </button>
              </form>
            </div>
          ) : (
            <div className="panel p-5">
              <h3 className="font-display text-lg font-semibold">Account</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <Row label="Username" value={`@${profile?.username}`} />
                <Row label="Email" value={user?.email ?? 'Not set'} />
                <Row label="Verified" value={user?.emailVerified ? 'Yes' : 'No'} />
                <Row
                  label="Member since"
                  value={
                    profile ? new Date(profile.createdAt).toLocaleDateString() : '—'
                  }
                />
              </dl>
            </div>
          )}

          <div className="panel p-5">
            <h3 className="font-display text-base font-semibold">About coins</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/50">
              Coins are a virtual in-game currency used to enter tables and open crates
              early. They cannot be purchased, sold, transferred, or exchanged for money
              or anything of value. This game is played for entertainment and skill only.
            </p>
          </div>
        </section>
      )}

      {notice && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 animate-pop-in rounded-xl border border-white/12 bg-ink-900/95 px-4 py-2.5 text-sm shadow-card backdrop-blur md:bottom-6">
          {notice}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
  big = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  big?: boolean;
}) {
  return (
    <div className={big ? 'panel p-4' : 'stat'}>
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={`font-bold tabular-nums ${big ? 'text-2xl' : 'text-lg'} ${
          accent ? 'text-brass-400' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-white/6 pb-2">
      <dt className="text-white/45">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function FriendRow({
  friend,
  action,
  onAction,
}: {
  friend: Friend;
  action: string;
  onAction(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
      <Avatar url={friend.avatar_url} name={friend.display_name} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{friend.display_name}</div>
        <div className="text-[11px] text-white/40">Lv {friend.level}</div>
      </div>
      <button
        type="button"
        className="btn-ghost px-3 py-1.5 text-xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onAction();
          setBusy(false);
        }}
      >
        {busy ? '…' : action}
      </button>
    </div>
  );
}

/** A row of mutually exclusive filter chips. */
function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange(value: string): void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[10px] font-bold uppercase tracking-wider text-white/35">
        {label}
      </legend>
      <div className="flex flex-wrap gap-1">
        {options.map(([id, name]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
              value === id
                ? 'border-brass-400/60 bg-brass-400/15 text-brass-400'
                : 'border-white/10 bg-white/[0.03] text-white/55 hover:bg-white/8'
            }`}
          >
            {name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt className="text-[10px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="text-sm font-bold tabular-nums">{value}</dd>
    </div>
  );
}
