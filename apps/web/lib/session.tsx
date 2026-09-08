'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Profile, User } from '@carrom/types';
import { ApiError, api, restoreSession, setTokens, signOut as apiSignOut } from './api';
import { facebookLogout, signInWithFacebook, signInWithGoogle } from './social';

interface AuthResponse {
  user: User;
  profile: Profile;
  tokens: { accessToken: string; refreshToken: string; expiresIn: number };
}

interface Stats {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  winRate: number;
  rank: { id: string; name: string; color: string };
  nextRank: { name: string; at: number } | null;
  globalPosition: number | null;
}

interface SessionValue {
  user: User | null;
  profile: Profile | null;
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  signedIn: boolean;

  registerWithEmail(input: { email: string; password: string; username: string }): Promise<void>;
  signInWithEmail(input: { email: string; password: string }): Promise<void>;
  continueWithFacebook(): Promise<void>;
  continueWithGoogle(): Promise<void>;
  continueAsGuest(displayName?: string): Promise<void>;
  upgradeGuest(input: { email: string; password: string; username?: string }): Promise<void>;
  signOut(): Promise<void>;

  refresh(): Promise<void>;
  /** Applied optimistically when the socket reports a balance change. */
  setBalance(coins: number): void;
  patchProfile(patch: Partial<Profile>): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadMe = useCallback(async () => {
    const data = await api<{ profile: Profile; stats: Stats }>('/profile/me');
    const me = await api<{ user: User }>('/auth/me');
    if (!mounted.current) return;
    setProfile(data.profile);
    setStats(data.stats);
    setUser(me.user);
  }, []);

  const adopt = useCallback((response: AuthResponse) => {
    setTokens(response.tokens.accessToken, response.tokens.refreshToken);
    setUser(response.user);
    setProfile(response.profile);
    setError(null);
  }, []);

  // Restore an existing session on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await restoreSession();
        if (restored && !cancelled) await loadMe();
      } catch {
        // A stale refresh token just means signed out.
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  const guard = useCallback(async (work: () => Promise<void>) => {
    setError(null);
    setLoading(true);
    try {
      await work();
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
      if (mounted.current) setError(message);
      throw err;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      profile,
      stats,
      loading,
      error,
      signedIn: Boolean(user),

      registerWithEmail: (input) =>
        guard(async () => {
          adopt(await api<AuthResponse>('/auth/register', { method: 'POST', body: input }));
          await loadMe();
        }),

      signInWithEmail: (input) =>
        guard(async () => {
          adopt(await api<AuthResponse>('/auth/login', { method: 'POST', body: input }));
          await loadMe();
        }),

      continueWithFacebook: () =>
        guard(async () => {
          const { token } = await signInWithFacebook();
          adopt(await api<AuthResponse>('/auth/facebook', { method: 'POST', body: { accessToken: token } }));
          await loadMe();
        }),

      continueWithGoogle: () =>
        guard(async () => {
          const { token } = await signInWithGoogle();
          adopt(await api<AuthResponse>('/auth/google', { method: 'POST', body: { idToken: token } }));
          await loadMe();
        }),

      continueAsGuest: (displayName) =>
        guard(async () => {
          adopt(await api<AuthResponse>('/auth/guest', { method: 'POST', body: { displayName } }));
          await loadMe();
        }),

      upgradeGuest: (input) =>
        guard(async () => {
          adopt(await api<AuthResponse>('/auth/upgrade', { method: 'POST', body: input }));
          await loadMe();
        }),

      signOut: async () => {
        await apiSignOut();
        await facebookLogout().catch(() => undefined);
        setUser(null);
        setProfile(null);
        setStats(null);
      },

      refresh: () => loadMe(),

      setBalance: (coins) => setProfile((prev) => (prev ? { ...prev, coins } : prev)),

      patchProfile: (patch) => setProfile((prev) => (prev ? { ...prev, ...patch } : prev)),
    }),
    [user, profile, stats, loading, error, guard, adopt, loadMe],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
