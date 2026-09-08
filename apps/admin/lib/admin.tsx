'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Admin API client and session.
 *
 * Staff sign in with the same credentials as players; the API refuses every
 * admin route unless the account carries the moderator or admin role, so this
 * app holds no privileged secret of its own.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const REFRESH_KEY = 'carrom.admin.refresh';

let accessToken: string | null = null;

export class AdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function adminApi<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const send = () =>
    fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  let res = await send();

  if (res.status === 401) {
    const refreshed = await refresh();
    if (refreshed) res = await send();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new AdminError(res.status, (data as { error?: string }).error ?? `Failed (${res.status})`);
  }
  return data as T;
}

async function refresh(): Promise<boolean> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(REFRESH_KEY) : null;
  if (!token) return false;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { tokens: { accessToken: string; refreshToken: string } };
    accessToken = data.tokens.accessToken;
    window.localStorage.setItem(REFRESH_KEY, data.tokens.refreshToken);
    return true;
  } catch {
    return false;
  }
}

interface Staff {
  id: string;
  username: string;
  role: 'player' | 'moderator' | 'admin';
}

interface AdminSession {
  staff: Staff | null;
  loading: boolean;
  error: string | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): void;
}

const Context = createContext<AdminSession | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    const me = await adminApi<{ user: Staff }>('/auth/me');
    if (me.user.role === 'player') {
      throw new AdminError(403, 'That account does not have staff access.');
    }
    setStaff(me.user);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (await refresh()) await loadMe();
      } catch {
        setStaff(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMe]);

  const value = useMemo<AdminSession>(
    () => ({
      staff,
      loading,
      error,
      signIn: async (email, password) => {
        setError(null);
        setLoading(true);
        try {
          const result = await adminApi<{
            user: Staff;
            tokens: { accessToken: string; refreshToken: string };
          }>('/auth/login', { method: 'POST', body: { email, password } });

          if (result.user.role === 'player') {
            throw new AdminError(403, 'That account does not have staff access.');
          }
          accessToken = result.tokens.accessToken;
          window.localStorage.setItem(REFRESH_KEY, result.tokens.refreshToken);
          setStaff(result.user);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Sign-in failed');
          throw err;
        } finally {
          setLoading(false);
        }
      },
      signOut: () => {
        accessToken = null;
        window.localStorage.removeItem(REFRESH_KEY);
        setStaff(null);
      },
    }),
    [staff, loading, error, loadMe],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAdmin(): AdminSession {
  const context = useContext(Context);
  if (!context) throw new Error('useAdmin must be used inside AdminProvider');
  return context;
}
