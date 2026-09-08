'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Providers {
  facebook: boolean;
  google: boolean;
  guest: boolean;
}

type Mode = 'choose' | 'signin' | 'register';

export default function LoginPage() {
  const {
    signInWithEmail, registerWithEmail, continueWithFacebook, continueWithGoogle,
    continueAsGuest, loading, error,
  } = useSession();

  const [providers, setProviders] = useState<Providers>({ facebook: false, google: false, guest: true });
  const [mode, setMode] = useState<Mode>('choose');
  const [form, setForm] = useState({ email: '', password: '', username: '' });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<Providers>('/auth/providers')
      .then(setProviders)
      .catch(() => undefined);
  }, []);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    try {
      await work();
    } catch {
      // The session context surfaces the message.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <BoardBackdrop />

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brass-400 to-brass-600 text-2xl font-black text-ink-950 shadow-[0_10px_40px_-10px_rgba(242,201,76,0.8)]">
            C
          </div>
          <h1 className="font-display text-4xl font-bold tracking-tight">Carrom Club</h1>
          <p className="mt-2 text-sm text-white/50">
            Real carrom rules. Real opponents. Play free.
          </p>
        </div>

        <div className="panel p-6">
          {error && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {mode === 'choose' && (
            <div className="space-y-3">
              {providers.facebook && (
                <button
                  type="button"
                  className="btn w-full bg-[#1877F2] text-white hover:brightness-110"
                  disabled={loading}
                  onClick={() => run('facebook', continueWithFacebook)}
                >
                  <FacebookMark />
                  {busy === 'facebook' ? 'Connecting…' : 'Continue with Facebook'}
                </button>
              )}

              {providers.google && (
                <button
                  type="button"
                  className="btn w-full bg-white text-ink-900 hover:brightness-95"
                  disabled={loading}
                  onClick={() => run('google', continueWithGoogle)}
                >
                  <GoogleMark />
                  {busy === 'google' ? 'Connecting…' : 'Continue with Google'}
                </button>
              )}

              {(providers.facebook || providers.google) && (
                <div className="flex items-center gap-3 py-1">
                  <span className="h-px flex-1 bg-white/10" />
                  <span className="text-[11px] uppercase tracking-widest text-white/30">or</span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>
              )}

              <button type="button" className="btn-ghost w-full" onClick={() => setMode('signin')}>
                Sign in with email
              </button>

              {providers.guest && (
                <button
                  type="button"
                  className="btn-primary w-full btn-lg"
                  disabled={loading}
                  onClick={() => run('guest', () => continueAsGuest())}
                >
                  {busy === 'guest' ? 'Setting up…' : 'Play now as guest'}
                </button>
              )}

              {!providers.facebook && !providers.google && (
                <p className="pt-1 text-center text-[11px] leading-relaxed text-white/35">
                  Facebook and Google sign-in appear here once the server has their
                  credentials configured.
                </p>
              )}
            </div>
          )}

          {mode !== 'choose' && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mode === 'signin') {
                  void run('email', () =>
                    signInWithEmail({ email: form.email, password: form.password }),
                  );
                } else {
                  void run('email', () => registerWithEmail(form));
                }
              }}
            >
              <div>
                <label className="label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  className="field"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>

              {mode === 'register' && (
                <div>
                  <label className="label" htmlFor="username">
                    Username
                  </label>
                  <input
                    id="username"
                    required
                    minLength={3}
                    maxLength={20}
                    pattern="[a-zA-Z0-9_]{3,20}"
                    className="field"
                    placeholder="carromking"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                  <p className="mt-1 text-[11px] text-white/35">
                    3–20 characters. Letters, numbers and underscore.
                  </p>
                </div>
              )}

              <div>
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  className="field"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                {mode === 'register' && (
                  <p className="mt-1 text-[11px] text-white/35">
                    At least 8 characters, with a letter and a number.
                  </p>
                )}
              </div>

              <button type="submit" className="btn-primary w-full" disabled={loading}>
                {busy === 'email' ? 'Just a moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>

              <div className="flex items-center justify-between pt-1 text-xs">
                <button
                  type="button"
                  className="text-white/45 hover:text-white/80"
                  onClick={() => setMode(mode === 'signin' ? 'register' : 'signin')}
                >
                  {mode === 'signin' ? 'Create an account' : 'I already have an account'}
                </button>
                <button
                  type="button"
                  className="text-white/45 hover:text-white/80"
                  onClick={() => setMode('choose')}
                >
                  Back
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-white/30">
          Coins in this game are virtual and have no cash value. There is no
          deposit, withdrawal, or wagering of real money.
        </p>
      </div>
    </div>
  );
}

/** A quiet animated backdrop, so the sign-in screen still feels like a game. */
function BoardBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass-400/[0.07] blur-3xl" />
      <div className="absolute left-[12%] top-[18%] h-24 w-24 animate-float rounded-full bg-gradient-to-br from-white/12 to-white/[0.02] blur-sm" />
      <div
        className="absolute right-[14%] top-[26%] h-16 w-16 animate-float rounded-full bg-gradient-to-br from-brass-400/25 to-transparent blur-sm"
        style={{ animationDelay: '0.8s' }}
      />
      <div
        className="absolute bottom-[16%] left-[22%] h-20 w-20 animate-float rounded-full bg-gradient-to-br from-felt-400/20 to-transparent blur-sm"
        style={{ animationDelay: '1.6s' }}
      />
    </div>
  );
}

function FacebookMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.96h-1.52c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.18-2 3.44-4.96 3.44-8.56z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.1 0 5.7-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.02-6.45-4.74H1.7v2.98A11.99 11.99 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.55 14.68a7.2 7.2 0 0 1 0-4.6V7.1H1.7a12 12 0 0 0 0 10.56l3.85-2.98z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.69 0 3.2.58 4.4 1.72l3.3-3.29C17.7 1.2 15.1 0 12 0 7.3 0 3.25 2.7 1.7 7.1l3.85 2.98C6.46 7.36 9 4.75 12 4.75z"
      />
    </svg>
  );
}
