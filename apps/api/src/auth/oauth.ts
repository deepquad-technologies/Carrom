import {
  FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_ENABLED,
  GOOGLE_CLIENT_ID, GOOGLE_ENABLED,
} from '../lib/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Social sign-in. The client sends a provider token; the server verifies it
 * with the provider before trusting a single field. OAuth secrets never leave
 * this process and are never sent to a client.
 */
export interface SocialProfile {
  provider: 'facebook' | 'google';
  providerUserId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

const FETCH_TIMEOUT_MS = 8_000;

async function getJson<T>(url: string, label: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      const detail = body?.error?.message ?? `${label} returned ${res.status}`;
      throw new AppError(401, detail, 'oauth_failed');
    }
    return body;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new AppError(504, `${label} did not respond in time`, 'oauth_timeout');
    }
    throw new AppError(502, `Could not reach ${label}`, 'oauth_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- facebook -------------------------------- */

interface FbDebug {
  data?: {
    is_valid?: boolean;
    app_id?: string;
    user_id?: string;
    scopes?: string[];
    expires_at?: number;
  };
}

interface FbProfile {
  id: string;
  name?: string;
  email?: string;
  picture?: { data?: { url?: string; is_silhouette?: boolean } };
}

/**
 * Verify a Facebook user access token belongs to this app, then read the
 * profile. `debug_token` is the step that stops a token minted for a different
 * app from being replayed here.
 */
export async function verifyFacebook(accessToken: string): Promise<SocialProfile> {
  if (!FACEBOOK_ENABLED) {
    throw new AppError(503, 'Facebook sign-in is not configured on this server', 'fb_disabled');
  }
  if (!accessToken) throw badRequest('A Facebook access token is required');

  const appToken = `${FACEBOOK_APP_ID}|${FACEBOOK_APP_SECRET}`;
  const debug = await getJson<FbDebug>(
    'https://graph.facebook.com/debug_token' +
      `?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(appToken)}`,
    'Facebook',
  );

  if (!debug.data?.is_valid) {
    throw new AppError(401, 'That Facebook session is no longer valid', 'fb_invalid');
  }
  if (debug.data.app_id !== FACEBOOK_APP_ID) {
    throw new AppError(401, 'That Facebook token belongs to another app', 'fb_wrong_app');
  }
  if (debug.data.expires_at && debug.data.expires_at * 1000 < Date.now()) {
    throw new AppError(401, 'That Facebook session has expired', 'fb_expired');
  }

  const profile = await getJson<FbProfile>(
    'https://graph.facebook.com/v21.0/me' +
      '?fields=id,name,email,picture.width(200).height(200)' +
      `&access_token=${encodeURIComponent(accessToken)}`,
    'Facebook',
  );

  // The email permission is optional and users can decline it.
  const grantedEmail = debug.data.scopes?.includes('email') ? profile.email ?? null : null;
  const avatar = profile.picture?.data?.is_silhouette ? null : profile.picture?.data?.url ?? null;

  return {
    provider: 'facebook',
    providerUserId: profile.id,
    displayName: profile.name?.trim() || 'Facebook player',
    email: grantedEmail,
    avatarUrl: avatar,
  };
}

/**
 * Facebook can tell us a user removed the app. Called from the deauthorize
 * webhook and whenever a Graph call reports the token was revoked.
 */
export function isRevokedError(err: unknown): boolean {
  return err instanceof AppError && (err.code === 'fb_invalid' || err.code === 'fb_expired');
}

/* --------------------------------- google --------------------------------- */

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  picture?: string;
  exp?: string;
}

/** Verify a Google ID token and confirm it was issued for this client id. */
export async function verifyGoogle(idToken: string): Promise<SocialProfile> {
  if (!GOOGLE_ENABLED) {
    throw new AppError(503, 'Google sign-in is not configured on this server', 'google_disabled');
  }
  if (!idToken) throw badRequest('A Google ID token is required');

  const info = await getJson<GoogleTokenInfo>(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    'Google',
  );

  if (!info.sub) throw new AppError(401, 'That Google token is not valid', 'google_invalid');
  if (info.aud !== GOOGLE_CLIENT_ID) {
    throw new AppError(401, 'That Google token belongs to another app', 'google_wrong_app');
  }
  if (info.exp && Number(info.exp) * 1000 < Date.now()) {
    throw new AppError(401, 'That Google session has expired', 'google_expired');
  }

  const verified = info.email_verified === true || info.email_verified === 'true';

  return {
    provider: 'google',
    providerUserId: info.sub,
    displayName: info.name?.trim() || 'Google player',
    email: verified ? info.email ?? null : null,
    avatarUrl: info.picture ?? null,
  };
}

export function providerStatus() {
  return {
    facebook: FACEBOOK_ENABLED,
    google: GOOGLE_ENABLED,
    facebookAppId: FACEBOOK_ENABLED ? FACEBOOK_APP_ID : null,
    googleClientId: GOOGLE_ENABLED ? GOOGLE_CLIENT_ID : null,
  };
}

export function logOauthFailure(provider: string, err: unknown): void {
  logger.warn({ provider, err: (err as Error).message }, 'social sign-in failed');
}
