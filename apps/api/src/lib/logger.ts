import pino from 'pino';
import { IS_PROD, LOG_LEVEL } from './env.js';

/**
 * Structured logging. In production this emits newline-delimited JSON for the
 * log shipper; in development it stays readable.
 */
export const logger = pino({
  level: LOG_LEVEL,
  base: { service: 'carrom-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'accessToken',
      'refreshToken',
      'idToken',
      '*.password',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  transport: IS_PROD
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
});

export function child(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
