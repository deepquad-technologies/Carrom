'use client';

/**
 * Thin API client.
 *
 * Access tokens are short-lived and kept in memory; the refresh token lives in
 * localStorage so a reload keeps the session. A 401 triggers exactly one
 * refresh attempt, and concurrent calls share that attempt rather than each
 * rotating the token.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const REFRESH_KEY = 'carrom.refresh';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export function setTokens(access: string | null, refresh?: string | null): void {
  accessToken = access;
  if (typeof window !== 'undefined') {
    if (refresh) window.localStorage.setItem(REFRESH_KEY, refresh);
    else if (refresh === null) window.localStorage.removeItem(REFRESH_KEY);
  }
  for (const listener of listeners) listener(Boolean(access));
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export function onAuthChange(listener: (signedIn: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the automatic refresh-and-retry, used by the refresh call itself. */
  raw?: boolean;
  signal?: AbortSignal;
}

async function refreshSession(): Promise<boolean> {
  const refresh = getRefreshToken();
  if (!refresh) return false;

  // One refresh at a time, shared by every waiting caller.
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) {
        setTokens(null, null);
        return false;
      }
      const data = (await res.json()) as { tokens: { accessToken: string; refreshToken: string } };
      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

  let res = await send();

  if (res.status === 401 && !options.raw) {
    const refreshed = await refreshSession();
    if (refreshed) res = await send();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { error?: string }).error ?? `Request failed (${res.status})`,
      (data as { code?: string }).code ?? 'error',
      (data as { details?: unknown }).details,
    );
  }

  return data as T;
}

/** Restore a session from the stored refresh token on first load. */
export async function restoreSession(): Promise<boolean> {
  if (accessToken) return true;
  return refreshSession();
}

export async function signOut(): Promise<void> {
  const refresh = getRefreshToken();
  try {
    await api('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, raw: true });
  } catch {
    // Signing out locally matters more than the server round trip.
  }
  setTokens(null, null);
}
