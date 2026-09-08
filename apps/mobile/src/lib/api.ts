import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

/**
 * API client for the mobile app. Mirrors the web client: the access token lives
 * in memory, the refresh token in device storage, and a 401 triggers a single
 * shared refresh.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

/**
 * Where the API lives.
 *
 * A hardcoded LAN address goes stale the moment the machine changes network —
 * a hotspot drops, the laptop moves desk — and the app then fails to reach a
 * server that is running perfectly well. So the host is derived instead:
 *
 *   1. An explicit `extra.apiUrl` always wins, which is how a real deployment
 *      points at its own domain.
 *   2. In a browser (the web preview) the API is on whatever host served the
 *      page, so `localhost` stays `localhost`.
 *   3. On a device, Expo tells us the address of the dev server it connected
 *      to — which is this machine — so the API is on that host.
 *   4. Failing all of that, localhost.
 */
function resolveApiUrl(): string {
  if (extra.apiUrl) return extra.apiUrl;

  const port = extra.apiPort || '4000';

  if (typeof window !== 'undefined' && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:${port}`;
  }

  // e.g. "192.168.1.14:8081" — the machine running `expo start`.
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const host = hostUri.split(':')[0];
  if (host) return `http://${host}:${port}`;

  return `http://localhost:${port}`;
}

export const API_URL = resolveApiUrl();
export const FACEBOOK_APP_ID = extra.facebookAppId || '';
export const GOOGLE_CLIENT_IDS = {
  expo: extra.googleExpoClientId || '',
  ios: extra.googleIosClientId || '',
  android: extra.googleAndroidClientId || '',
  web: extra.googleWebClientId || '',
};

const REFRESH_KEY = 'carrom.refresh';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export async function setTokens(access: string | null, refresh?: string | null): Promise<void> {
  accessToken = access;
  if (refresh) await AsyncStorage.setItem(REFRESH_KEY, refresh);
  else if (refresh === null) await AsyncStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  raw?: boolean;
}

async function refreshSession(): Promise<boolean> {
  const refresh = await AsyncStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;

  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) {
        await setTokens(null, null);
        return false;
      }
      const data = (await res.json()) as { tokens: { accessToken: string; refreshToken: string } };
      await setTokens(data.tokens.accessToken, data.tokens.refreshToken);
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
    );
  }
  return data as T;
}

export async function restoreSession(): Promise<boolean> {
  if (accessToken) return true;
  return refreshSession();
}

export async function signOutLocal(): Promise<void> {
  const refresh = await AsyncStorage.getItem(REFRESH_KEY);
  try {
    await api('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, raw: true });
  } catch {
    // Clearing locally is what matters.
  }
  await setTokens(null, null);
}
