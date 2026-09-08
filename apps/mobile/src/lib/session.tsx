import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as AuthSession from 'expo-auth-session';
import * as Facebook from 'expo-auth-session/providers/facebook';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import type { Profile, User } from '@carrom/types';
import {
  ApiError, FACEBOOK_APP_ID, GOOGLE_CLIENT_IDS, api, restoreSession, setTokens, signOutLocal,
} from './api';

WebBrowser.maybeCompleteAuthSession();

interface AuthResponse {
  user: User;
  profile: Profile;
  tokens: { accessToken: string; refreshToken: string };
}

interface Stats {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  winRate: number;
  rank: { id: string; name: string; color: string };
  globalPosition: number | null;
}

interface SessionValue {
  user: User | null;
  profile: Profile | null;
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  signedIn: boolean;
  facebookAvailable: boolean;
  googleAvailable: boolean;

  signInWithEmail(input: { email: string; password: string }): Promise<void>;
  registerWithEmail(input: { email: string; password: string; username: string }): Promise<void>;
  continueAsGuest(displayName?: string): Promise<void>;
  continueWithFacebook(): Promise<void>;
  continueWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  setBalance(coins: number): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const facebookAvailable = FACEBOOK_APP_ID.length > 0;
  const googleAvailable = Object.values(GOOGLE_CLIENT_IDS).some(Boolean);

  // Both providers hand back a token through a hook-driven response object.
  const [, fbResponse, fbPrompt] = Facebook.useAuthRequest({
    clientId: FACEBOOK_APP_ID || 'unconfigured',
    scopes: ['public_profile', 'email'],
    redirectUri: AuthSession.makeRedirectUri({ scheme: 'carromclub' }),
  });

  /**
   * `useAuthRequest` validates its client id the moment it mounts and throws if
   * the one for the current platform is missing — on web that took the entire
   * app down before it rendered. Hooks cannot be called conditionally, so an
   * unconfigured build gets a placeholder instead. It is never used: the prompt
   * is gated behind `googleAvailable`, which stays false without real ids.
   */
  const UNCONFIGURED = 'unconfigured.apps.googleusercontent.com';
  const [, googleResponse, googlePrompt] = Google.useAuthRequest({
    clientId: GOOGLE_CLIENT_IDS.expo || UNCONFIGURED,
    webClientId: GOOGLE_CLIENT_IDS.web || UNCONFIGURED,
    iosClientId: GOOGLE_CLIENT_IDS.ios || UNCONFIGURED,
    androidClientId: GOOGLE_CLIENT_IDS.android || UNCONFIGURED,
  });

  const loadMe = useCallback(async () => {
    const [me, mine] = await Promise.all([
      api<{ user: User }>('/auth/me'),
      api<{ profile: Profile; stats: Stats }>('/profile/me'),
    ]);
    setUser(me.user);
    setProfile(mine.profile);
    setStats(mine.stats);
  }, []);

  const adopt = useCallback(async (response: AuthResponse) => {
    await setTokens(response.tokens.accessToken, response.tokens.refreshToken);
    setUser(response.user);
    setProfile(response.profile);
    setError(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (await restoreSession()) await loadMe();
      } catch {
        // Signed out is a normal outcome here.
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMe]);

  // Exchange a provider token for our own session once the prompt resolves.
  useEffect(() => {
    if (fbResponse?.type !== 'success') return;
    const token = fbResponse.authentication?.accessToken;
    if (!token) return;
    void guard(async () => {
      await adopt(await api<AuthResponse>('/auth/facebook', { method: 'POST', body: { accessToken: token } }));
      await loadMe();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbResponse]);

  useEffect(() => {
    if (googleResponse?.type !== 'success') return;
    const idToken = googleResponse.params?.id_token ?? googleResponse.authentication?.idToken;
    if (!idToken) return;
    void guard(async () => {
      await adopt(await api<AuthResponse>('/auth/google', { method: 'POST', body: { idToken } }));
      await loadMe();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleResponse]);

  async function guard(work: () => Promise<void>): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  const value = useMemo<SessionValue>(
    () => ({
      user,
      profile,
      stats,
      loading,
      error,
      signedIn: Boolean(user),
      facebookAvailable,
      googleAvailable,

      signInWithEmail: (input) =>
        guard(async () => {
          await adopt(await api<AuthResponse>('/auth/login', { method: 'POST', body: input }));
          await loadMe();
        }),

      registerWithEmail: (input) =>
        guard(async () => {
          await adopt(await api<AuthResponse>('/auth/register', { method: 'POST', body: input }));
          await loadMe();
        }),

      continueAsGuest: (displayName) =>
        guard(async () => {
          await adopt(await api<AuthResponse>('/auth/guest', { method: 'POST', body: { displayName } }));
          await loadMe();
        }),

      continueWithFacebook: async () => {
        if (!facebookAvailable) {
          setError('Facebook sign-in is not configured for this build');
          return;
        }
        await fbPrompt();
      },

      continueWithGoogle: async () => {
        if (!googleAvailable) {
          setError('Google sign-in is not configured for this build');
          return;
        }
        await googlePrompt();
      },

      signOut: async () => {
        await signOutLocal();
        setUser(null);
        setProfile(null);
        setStats(null);
      },

      refresh: loadMe,
      setBalance: (coins) => setProfile((prev) => (prev ? { ...prev, coins } : prev)),
    }),
    [user, profile, stats, loading, error, facebookAvailable, googleAvailable, adopt, loadMe, fbPrompt, googlePrompt],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
