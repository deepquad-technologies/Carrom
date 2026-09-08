import 'dotenv/config';

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export const NODE_ENV = str('NODE_ENV', 'development');
export const IS_PROD = NODE_ENV === 'production';
export const PORT = num('PORT', 4000);
export const LOG_LEVEL = str('LOG_LEVEL', IS_PROD ? 'info' : 'debug');

export const CORS_ORIGINS = str('CORS_ORIGINS', 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Postgres. */
export const DATABASE_URL = str('DATABASE_URL', 'postgres://carrom:carrom@localhost:5432/carrom');
export const DB_POOL_MAX = num('DB_POOL_MAX', 20);

/** Redis, used for presence, matchmaking queues and rate limiting. */
export const REDIS_URL = str('REDIS_URL', 'redis://localhost:6379');
/** Running without Redis is supported in development via in-process fallbacks. */
export const REDIS_ENABLED = bool('REDIS_ENABLED', true);

/** JWT signing. Access and refresh use separate secrets. */
export const JWT_ACCESS_SECRET = str('JWT_ACCESS_SECRET', 'dev-access-secret-change-me');
export const JWT_REFRESH_SECRET = str('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me');

/** OAuth. Secrets stay on the server; clients only ever send provider tokens. */
export const FACEBOOK_APP_ID = str('FACEBOOK_APP_ID');
export const FACEBOOK_APP_SECRET = str('FACEBOOK_APP_SECRET');
export const FACEBOOK_ENABLED = Boolean(FACEBOOK_APP_ID && FACEBOOK_APP_SECRET);

export const GOOGLE_CLIENT_ID = str('GOOGLE_CLIENT_ID');
export const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID);

export const ALLOW_GUEST = bool('ALLOW_GUEST', true);
export const REQUIRE_EMAIL_VERIFICATION = bool('REQUIRE_EMAIL_VERIFICATION', false);

/** Public base URL, used to build verification and reset links. */
export const PUBLIC_WEB_URL = str('PUBLIC_WEB_URL', 'http://localhost:3000');

/** Object storage for avatars. Uploads are disabled when unset. */
export const STORAGE_BUCKET_URL = str('STORAGE_BUCKET_URL');

export const ADMIN_BOOTSTRAP_EMAIL = str('ADMIN_BOOTSTRAP_EMAIL');

/**
 * Payments.
 *
 * Every secret here stays on the server. Clients send a receipt or a session
 * id; they never send a price, and they are never told a purchase succeeded
 * until one of these providers has confirmed it.
 */
export const STRIPE_SECRET_KEY = str('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = str('STRIPE_WEBHOOK_SECRET');
export const STRIPE_ENABLED = Boolean(STRIPE_SECRET_KEY);

/** App Store shared secret, for verifying iOS receipts. */
export const APPLE_SHARED_SECRET = str('APPLE_SHARED_SECRET');
export const APPLE_ENABLED = Boolean(APPLE_SHARED_SECRET);

/** Google Play service account, for verifying Android purchases. */
export const GOOGLE_PLAY_PACKAGE = str('GOOGLE_PLAY_PACKAGE');
export const GOOGLE_PLAY_ACCESS_TOKEN = str('GOOGLE_PLAY_ACCESS_TOKEN');
export const GOOGLE_PLAY_ENABLED = Boolean(GOOGLE_PLAY_PACKAGE && GOOGLE_PLAY_ACCESS_TOKEN);

/**
 * Sandbox payments, for development and automated tests.
 *
 * Refused outright in production: without it, a build with no payment provider
 * configured simply cannot complete a purchase, which is the safe failure.
 */
export const SANDBOX_PAYMENTS = bool('SANDBOX_PAYMENTS', !IS_PROD) && !IS_PROD;

/** Store currency. Prices are held in the smallest unit of this currency. */
export const STORE_CURRENCY = str('STORE_CURRENCY', 'INR');

/** House advertising. Turning this off hides every ad placement. */
export const ADS_ENABLED = bool('ADS_ENABLED', true);

const INSECURE_DEFAULTS = [
  ['JWT_ACCESS_SECRET', JWT_ACCESS_SECRET, 'dev-access-secret-change-me'],
  ['JWT_REFRESH_SECRET', JWT_REFRESH_SECRET, 'dev-refresh-secret-change-me'],
] as const;

export function assertProductionConfig(): void {
  if (!IS_PROD) return;
  const problems: string[] = [];
  for (const [name, value, insecure] of INSECURE_DEFAULTS) {
    if (value === insecure) problems.push(`${name} is still the development default`);
  }
  if (ALLOW_GUEST && !bool('ALLOW_GUEST_IN_PROD', false)) {
    problems.push('ALLOW_GUEST is on; set ALLOW_GUEST_IN_PROD=true to confirm that is intended');
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
  }
}
