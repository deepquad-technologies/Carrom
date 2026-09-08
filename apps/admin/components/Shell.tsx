'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAdmin } from '@/lib/admin';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/reports', label: 'Reports' },
  { href: '/flags', label: 'Anti-cheat' },
  { href: '/users', label: 'Players' },
  { href: '/matches', label: 'Matches' },
  { href: '/items', label: 'Items' },
  { href: '/events', label: 'Events' },
  { href: '/monetization', label: 'Revenue' },
  { href: '/advertisers', label: 'Ads' },
  { href: '/performance', label: 'Performance' },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const { staff, loading, error, signIn, signOut } = useAdmin();
  const pathname = usePathname();
  const [form, setForm] = useState({ email: '', password: '' });

  if (loading && !staff) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-white/40">Loading…</div>
    );
  }

  if (!staff) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <form
          className="panel w-full max-w-sm p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(form.email, form.password).catch(() => undefined);
          }}
        >
          <h1 className="text-xl font-bold">Carrom Club admin</h1>
          <p className="mt-1 text-sm text-white/45">Staff accounts only.</p>

          {error && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </p>
          )}

          <input
            className="field mt-4"
            type="email"
            required
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            className="field mt-2"
            type="password"
            required
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <button type="submit" className="btn-primary mt-4 w-full">
            Sign in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-white/8 bg-ink-900 p-4 md:block">
        <div className="mb-6">
          <div className="text-sm font-bold">Carrom Club</div>
          <div className="text-[11px] uppercase tracking-wider text-brass-400">{staff.role}</div>
        </div>

        <nav className="space-y-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-lg px-3 py-2 text-sm transition ${
                pathname === item.href
                  ? 'bg-white/10 font-semibold text-white'
                  : 'text-white/55 hover:bg-white/5'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button type="button" className="btn-ghost mt-8 w-full text-xs" onClick={signOut}>
          Sign out ({staff.username})
        </button>
      </aside>

      <div className="flex-1">
        <nav className="flex gap-1 overflow-x-auto border-b border-white/8 bg-ink-900 p-2 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs ${
                pathname === item.href ? 'bg-white/10 text-white' : 'text-white/50'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <main className="p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
