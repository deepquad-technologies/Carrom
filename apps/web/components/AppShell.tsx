'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { formatCoins, rankForTrophies } from '@carrom/config';
import { useSession } from '@/lib/session';
import { usePreferences } from '@/lib/preferences';
import Tutorial from '@/components/Tutorial';
import HeaderTools from '@/components/HeaderTools';

const NAV = [
  { href: '/', label: 'Home', icon: '\u{1F3E0}' },
  { href: '/play', label: 'Play', icon: '\u{1F3AF}' },
  { href: '/watch', label: 'Watch', icon: '\u{1F441}' },
  { href: '/lobby', label: 'Lobby', icon: '\u{1F465}' },
  { href: '/tournaments', label: 'Cups', icon: '\u{1F3C6}' },
  { href: '/locker', label: 'Locker', icon: '\u{1F392}' },
  { href: '/collection', label: 'Sets', icon: '\u{1F4DA}' },
  { href: '/store', label: 'Store', icon: '\u{1F6D2}' },
  { href: '/pass', label: 'Pass', icon: '\u{1F3AB}' },
  { href: '/crates', label: 'Crates', icon: '\u{1F381}' },
  { href: '/leaderboard', label: 'Ranks', icon: '\u{1F3C6}' },
  { href: '/profile', label: 'Profile', icon: '\u{1F464}' },
];

/** The phone tab bar shows the five most-used destinations, not all of them. */
const MOBILE_NAV = NAV.filter((item) =>
  ['/', '/play', '/lobby', '/locker', '/profile'].includes(item.href),
);

const PUBLIC_ROUTES = ['/login'];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { profile, user, loading, signedIn } = useSession();
  const { prefs, loaded: prefsLoaded, markTutorialDone } = usePreferences();
  const pathname = usePathname();
  const router = useRouter();

  const isPublic = PUBLIC_ROUTES.includes(pathname);

  useEffect(() => {
    if (loading) return;
    if (!signedIn && !isPublic) router.replace('/login');
    if (signedIn && isPublic) router.replace('/');
  }, [loading, signedIn, isPublic, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-14 w-14 animate-coin-flip rounded-full bg-gradient-to-br from-brass-400 to-brass-600 shadow-[0_0_30px_-4px_rgba(242,201,76,0.8)]" />
          <p className="text-sm text-white/45">Setting up the board…</p>
        </div>
      </div>
    );
  }

  if (isPublic || !signedIn) {
    return <main className="min-h-screen">{children}</main>;
  }

  const rank = profile ? rankForTrophies(profile.trophies) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-ink-950/85 backdrop-blur-lg">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-brass-400 to-brass-600 text-base font-black text-ink-950">
              C
            </span>
            <span className="hidden font-display text-lg font-semibold tracking-tight sm:block">
              Carrom Club
            </span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    active ? 'bg-white/10 text-white' : 'text-white/55 hover:bg-white/5 hover:text-white/85'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2.5">
            <div
              className="flex items-center gap-2 rounded-full border border-brass-400/25 bg-brass-400/10 px-3 py-1.5"
              title="Virtual coins. No cash value."
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-brass-400 to-brass-600 text-[10px] font-black text-ink-950">
                c
              </span>
              <span className="text-sm font-bold tabular-nums text-brass-400">
                {formatCoins(profile?.coins ?? 0)}
              </span>
            </div>

            <HeaderTools />

            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/5 text-base transition hover:bg-white/10"
            >
              {'⚙️'}
            </Link>

            <Link
              href="/profile"
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-1 pr-3 transition hover:bg-white/10"
            >
              <Avatar url={profile?.avatarUrl ?? null} name={profile?.displayName ?? '?'} size={28} />
              <div className="hidden text-left leading-tight sm:block">
                <div className="max-w-[110px] truncate text-xs font-semibold">
                  {profile?.displayName}
                </div>
                <div className="text-[10px] text-white/40">
                  Lv {profile?.level}
                  {rank ? ` · ${rank.name}` : ''}
                </div>
              </div>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-5 md:pb-8">{children}</main>

      {user?.isGuest && <GuestBanner />}

      {prefsLoaded && !prefs.tutorialDone && <Tutorial onDone={markTutorialDone} />}

      {/* Mobile tab bar. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/8 bg-ink-950/95 backdrop-blur-lg md:hidden">
        <div className="mx-auto flex max-w-md items-stretch justify-between px-2">
          {MOBILE_NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition ${
                  active ? 'text-brass-400' : 'text-white/45'
                }`}
              >
                <span className="text-lg leading-none">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function Avatar({
  url,
  name,
  size = 36,
}: {
  url: string | null;
  name: string;
  size?: number;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  if (url) {
    // Provider avatars come from a handful of CDNs; a plain img keeps it simple.
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt={name}
        width={size}
        height={size}
        className="rounded-full object-cover ring-1 ring-white/15"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className="grid place-items-center rounded-full bg-gradient-to-br from-ink-600 to-ink-800 font-semibold text-white/80 ring-1 ring-white/10"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </span>
  );
}

function GuestBanner() {
  return (
    <div className="fixed bottom-16 left-1/2 z-20 w-[92%] max-w-md -translate-x-1/2 md:bottom-4">
      <Link
        href="/profile"
        className="flex items-center gap-3 rounded-xl border border-brass-400/25 bg-ink-900/95 px-4 py-3 shadow-card backdrop-blur transition hover:border-brass-400/45"
      >
        <span className="text-lg">{'\u{1F513}'}</span>
        <div className="flex-1 text-xs">
          <div className="font-semibold text-white/90">You are playing as a guest</div>
          <div className="text-white/45">Add an email to keep your coins and cosmetics.</div>
        </div>
        <span className="text-xs font-semibold text-brass-400">Save</span>
      </Link>
    </div>
  );
}
