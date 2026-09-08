import type { NextFunction, Request, Response } from 'express';
import { HTTP_RATE_LIMITS } from '@carrom/config';
import { forbidden, tooMany, unauthorized } from '../lib/errors.js';
import { incrWindow } from '../lib/redis.js';
import { activeBans } from './users.js';
import { verifyAccessToken, type AccessClaims } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** Require a signed-in user. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    next(unauthorized());
    return;
  }
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach the user when a token is present, but allow anonymous through. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  if (!token) {
    next();
    return;
  }
  try {
    req.auth = verifyAccessToken(token);
  } catch {
    // An expired token on a public route is not an error.
  }
  next();
}

export function requireRole(...roles: Array<'moderator' | 'admin'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.auth.role as 'moderator' | 'admin')) {
      next(forbidden('That area is for staff only'));
      return;
    }
    next();
  };
}

/** Block a route for accounts under a scoped ban (ranked play, chat). */
export function requireNotBanned(scope: 'account' | 'ranked' | 'chat') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      next(unauthorized());
      return;
    }
    try {
      const bans = await activeBans(req.auth.sub);
      const hit = bans.find((b) => b.scope === scope || b.scope === 'account');
      if (hit) {
        next(forbidden(`You are restricted from this. Reason: ${hit.reason}`, 'banned'));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Guests can play, but not everything is open to them. */
export function requireFullAccount(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    next(unauthorized());
    return;
  }
  if (req.auth.guest) {
    next(forbidden('Create an account to use this', 'guest_restricted'));
    return;
  }
  next();
}

/**
 * Fixed-window rate limiting keyed by user when signed in, IP otherwise, so one
 * abusive account cannot exhaust the limit for a whole shared network.
 */
export function rateLimit(bucket: string, perMinute: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const who = req.auth?.sub ?? req.ip ?? 'unknown';
    const key = `rl:${bucket}:${who}:${Math.floor(Date.now() / 60_000)}`;
    try {
      const count = await incrWindow(key, 70);
      res.setHeader('X-RateLimit-Limit', perMinute);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, perMinute - count));
      if (count > perMinute) {
        next(tooMany());
        return;
      }
      next();
    } catch {
      // Never fail a request because the limiter is unavailable.
      next();
    }
  };
}

export const authRateLimit = rateLimit('auth', HTTP_RATE_LIMITS.authPerMinute);
export const generalRateLimit = rateLimit('general', HTTP_RATE_LIMITS.generalPerMinute);
