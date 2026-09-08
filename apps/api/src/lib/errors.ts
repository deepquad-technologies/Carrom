import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { IS_PROD } from './env.js';
import { logger } from './logger.js';

/** An error safe to show a client, with an HTTP status attached. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, code = 'bad_request') => new AppError(400, m, code);
export const unauthorized = (m = 'Sign in to continue', code = 'unauthorized') => new AppError(401, m, code);
export const forbidden = (m = 'You do not have access to that', code = 'forbidden') => new AppError(403, m, code);
export const notFound = (m = 'Not found', code = 'not_found') => new AppError(404, m, code);
export const conflict = (m: string, code = 'conflict') => new AppError(409, m, code);
export const tooMany = (m = 'Slow down a moment', code = 'rate_limited') => new AppError(429, m, code);

/** Wrap an async route so rejections reach the error handler. */
export function route<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req as T, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Some fields need fixing',
      code: 'validation_failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, path: req.path }, 'request failed');
    }
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({
    error: IS_PROD ? 'Something went wrong on our side' : String(err),
    code: 'internal_error',
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: 'not_found' });
}
