'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatCoins, rankForTrophies } from '@carrom/config';
import { CRATE_TYPES, type CrateKind } from '@carrom/content';
import type { Profile } from '@carrom/types';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AdBanner } from '@/components/Ads';

interface HomePayload {
  profile: Profile;
  stats: {
    level: number;
    xpIntoLevel: number;
    xpForNextLevel: number;
    winRate: number;
    rank: { id: string; name: string; color: string };
    nextRank: { name: string; at: number } | null;
    globalPosition: number | null;
  };
  crates: { held: number; ready: number; slots: number };
  missions: Array<{
    id: string;
    name: string;
    description: string;
    target: number;
    progress: number;
    complete: boolean;
    claimed: boolean;
    coins: number;
    xp: number;
  }>;
  unreadNotifications: number;
  pendingFriendRequests: number;
  isGuest: boolean;
}

export default function HomePage() {
  const { profile, setBalance } = useSession();
  const [home, setHome] = useState<HomePayload | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = () => api<HomePayload>('/profile/home').then(setHome).catch(() => undefined);

  useEffect(() => {
    void load();
  }, []);

  const claim = async (missionId: string) => {
    setClaiming(missionId);
    try {
      const result = await api<{ ok: boolean; balance?: number }>(
        `/profile/missions/${missionId}/claim`,
        { method: 'POST' },
      );
      if (result.balance !== undefined) setBalance(result.balance);
      await load();
    } finally {
      setClaiming(null);
    }
  };

  const stats = home?.stats;
  const xpPercent = stats ? Math.min(100, (stats.xpIntoLevel / stats.xpForNextLevel) * 100) : 0;
  const rank = profile ? rankForTrophies(profile.trophies) : null;

  return (
    <div className="space-y-5 animate-fade-up">
      <AdBanner />

      {/* Player card */}
      <section className="panel overflow-hidden">
        <div className="relative p-5">
          <div
            className="absolute inset-x-0 top-0 h-24 opacity-25"
            style={{
              background: rank
                ? `radial-gradient(600px 120px at 30% 0%, ${rank.color}, transparent 70%)`
                : undefined,
            }}
          />
          <div className="relative flex flex-wrap items-center gap-4">
            <div>
              <h1 className="font-display text-2xl font-bold">
                {profile?.displayName ?? 'Player'}
              </h1>
              <p className="text-sm text-white/45">
                Level {profile?.level} · {rank?.name}
                {stats?.globalPosition ? ` · #${stats.globalPosition} worldwide` : ''}
              </p>
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="chip">
                {'\u{1F3C6}'} {profile?.trophies ?? 0}
              </span>
              <span className="chip">
                {'\u{1F4C8}'} {stats?.winRate ?? 0}% wins
              </span>
              <span className="chip">
                {'\u{1F525}'} {profile?.currentStreak ?? 0} streak
              </span>
            </div>
          </div>

          <div className="relative mt-4">
            <div className="mb-1.5 flex justify-between text-[11px] text-white/40">
              <span>
                {stats?.xpIntoLevel ?? 0} / {stats?.xpForNextLevel ?? 0} XP
              </span>
              <span>Level {(profile?.level ?? 1) + 1}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brass-600 to-brass-400 transition-[width] duration-700"
                style={{ width: `${xpPercent}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Primary call to action */}
      <Link
        href="/play"
        className="group relative block overflow-hidden rounded-2xl border border-brass-400/25 bg-gradient-to-br from-brass-400/15 via-ink-900 to-ink-900 p-6 shadow-card transition hover:border-brass-400/50"
      >
        <div className="absolute -right-8 -top-8 h-40 w-40 rounded-full bg-brass-400/10 blur-2xl transition group-hover:bg-brass-400/20" />
        <div className="relative flex items-center gap-4">
          <div>
            <h2 className="font-display text-3xl font-bold">Play</h2>
            <p className="mt-1 text-sm text-white/55">
              Quick match, ranked, team play or a private room.
            </p>
          </div>
          <span className="ml-auto grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-brass-400 to-brass-600 text-2xl text-ink-950 shadow-[0_8px_24px_-6px_rgba(242,201,76,0.8)] transition group-hover:scale-105">
            {'▶'}
          </span>
        </div>
      </Link>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Crates */}
        <section className="panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold">Crates</h3>
            <Link href="/crates" className="text-xs text-brass-400 hover:underline">
              Open
            </Link>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: home?.crates.slots ?? 4 }).map((_, index) => {
              const filled = index < (home?.crates.held ?? 0);
              const ready = index < (home?.crates.ready ?? 0);
              return (
                <div
                  key={index}
                  className={`grid aspect-square place-items-center rounded-xl border text-2xl transition ${
                    filled
                      ? 'border-brass-400/35 bg-brass-400/10'
                      : 'border-dashed border-white/10 bg-white/[0.02] text-white/15'
                  } ${ready ? 'animate-pulse-ring' : ''}`}
                >
                  {filled ? '\u{1F381}' : '•'}
                </div>
              );
            })}
          </div>

          <p className="mt-3 text-xs text-white/40">
            {home?.crates.ready
              ? `${home.crates.ready} ready to open`
              : home?.crates.held
                ? 'Start an unlock to open one'
                : 'Win a match to earn a crate'}
          </p>
        </section>

        {/* Missions */}
        <section className="panel p-5">
          <h3 className="mb-3 font-display text-lg font-semibold">Today</h3>

          <div className="space-y-2.5">
            {(home?.missions ?? []).slice(0, 4).map((mission) => {
              const percent = Math.min(100, (mission.progress / mission.target) * 100);
              return (
                <div key={mission.id} className="panel-tight p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{mission.name}</div>
                      <div className="truncate text-[11px] text-white/40">{mission.description}</div>
                    </div>
                    {mission.claimed ? (
                      <span className="chip text-felt-400">Claimed</span>
                    ) : mission.complete ? (
                      <button
                        type="button"
                        className="btn-primary px-3 py-1.5 text-xs"
                        disabled={claiming === mission.id}
                        onClick={() => void claim(mission.id)}
                      >
                        {claiming === mission.id ? '…' : `+${formatCoins(mission.coins)}`}
                      </button>
                    ) : (
                      <span className="text-xs tabular-nums text-white/40">
                        {mission.progress}/{mission.target}
                      </span>
                    )}
                  </div>
                  {!mission.claimed && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-felt-500 transition-[width]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {home && home.missions.length === 0 && (
              <p className="text-sm text-white/40">New missions arrive shortly.</p>
            )}
          </div>
        </section>
      </div>

      {/* Shortcuts */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Shortcut href="/locker" icon={'\u{1F392}'} label="Locker" hint="Strikers & boards" />
        <Shortcut href="/leaderboard" icon={'\u{1F3C6}'} label="Ranks" hint="Global & friends" />
        <Shortcut
          href="/profile"
          icon={'\u{1F464}'}
          label="Profile"
          hint={
            home?.pendingFriendRequests
              ? `${home.pendingFriendRequests} friend request${home.pendingFriendRequests > 1 ? 's' : ''}`
              : 'Stats & friends'
          }
          badge={home?.pendingFriendRequests}
        />
        <Shortcut href="/crates" icon={'\u{1F381}'} label="Crates" hint="Rewards" badge={home?.crates.ready} />
      </section>

      <CrateOdds />

      <p className="pb-2 text-center text-[11px] text-white/25">
        Coins are virtual and have no cash value.
      </p>
    </div>
  );
}

function Shortcut({
  href,
  icon,
  label,
  hint,
  badge,
}: {
  href: string;
  icon: string;
  label: string;
  hint: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="panel relative p-4 transition hover:border-white/20 hover:bg-ink-850/80"
    >
      {badge ? (
        <span className="absolute right-3 top-3 grid h-5 min-w-5 place-items-center rounded-full bg-brass-400 px-1 text-[10px] font-bold text-ink-950">
          {badge}
        </span>
      ) : null}
      <div className="mb-2 text-2xl">{icon}</div>
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-[11px] text-white/40">{hint}</div>
    </Link>
  );
}

/** Drop rates published up front rather than buried. */
function CrateOdds() {
  const [open, setOpen] = useState(false);

  return (
    <section className="panel p-5">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen(!open)}
      >
        <div>
          <h3 className="font-display text-lg font-semibold">Crate odds</h3>
          <p className="text-xs text-white/40">Every drop rate, published.</p>
        </div>
        <span className={`text-white/40 transition ${open ? 'rotate-180' : ''}`}>{'▾'}</span>
      </button>

      {open && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(Object.keys(CRATE_TYPES) as CrateKind[]).map((kind) => {
            const crate = CRATE_TYPES[kind];
            const total = Object.values(crate.rarityWeights).reduce((s, w) => s + (w ?? 0), 0);
            return (
              <div key={kind} className="panel-tight p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ background: crate.accent }}
                    aria-hidden
                  />
                  <span className="text-sm font-semibold">{crate.name}</span>
                </div>
                <ul className="space-y-1 text-[11px] text-white/55">
                  {Object.entries(crate.rarityWeights).map(([rarity, weight]) => (
                    <li key={rarity} className="flex justify-between capitalize">
                      <span>{rarity}</span>
                      <span className="tabular-nums">
                        {(((weight ?? 0) / total) * 100).toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[10px] text-white/35">
                  {crate.itemDrops} items · {crate.guaranteed} guaranteed
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
