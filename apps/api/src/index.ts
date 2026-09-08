import { createServer } from 'node:http';
import { CATALOG_COUNTS } from '@carrom/content';
import { GAME_MODE_LIST, MATCH_TIERS } from '@carrom/config';
import { createApp } from './app.js';
import { primeConfig } from './features/config.js';
import { ensureSeason, settleExpiredSeasons } from './features/seasons.js';
import { pruneIdempotencyKeys } from './lib/idempotency.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { closePool, healthy } from './db/pool.js';
import { createGateway } from './game/gateway.js';
import { detectCollusion } from './game/antiCheat.js';
import { pruneExpiredTokens } from './auth/tokens.js';
import { assertProductionConfig, FACEBOOK_ENABLED, GOOGLE_ENABLED, ALLOW_GUEST, PORT } from './lib/env.js';
import { logger } from './lib/logger.js';
import { closeRedis, redisReady } from './lib/redis.js';

async function main(): Promise<void> {
  assertProductionConfig();

  if (!(await healthy())) {
    throw new Error('Cannot reach Postgres. Check DATABASE_URL, or run: npm run docker:up');
  }

  // Migrations and content seeding run on boot so a fresh environment works
  // with no extra steps; both are idempotent.
  await migrate();
  await seed();

  // Runtime configuration and the current season are needed before the first
  // request; both are idempotent and safe to run on every node.
  await primeConfig();
  const season = await ensureSeason();
  logger.info({ season: season.number, name: season.name }, 'season active');

  const app = createApp();
  const http = createServer(app);
  const io = createGateway(http);

  const housekeeping = setInterval(
    () => {
      void pruneExpiredTokens().catch((err) => logger.error({ err }, 'token prune failed'));
      void detectCollusion().catch((err) => logger.error({ err }, 'collusion scan failed'));
      void settleExpiredSeasons().catch((err) => logger.error({ err }, 'season settle failed'));
      void pruneIdempotencyKeys().catch((err) => logger.error({ err }, 'idempotency prune failed'));
    },
    60 * 60_000,
  );
  housekeeping.unref();

  http.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        redis: redisReady(),
        facebook: FACEBOOK_ENABLED,
        google: GOOGLE_ENABLED,
        guest: ALLOW_GUEST,
        modes: GAME_MODE_LIST.length,
        tiers: MATCH_TIERS.length,
        content: CATALOG_COUNTS,
      },
      'carrom api ready',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    clearInterval(housekeeping);
    io.close();
    http.close();
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'failed to start');
  process.exit(1);
});
