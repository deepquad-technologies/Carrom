import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { authRouter } from './auth/routes.js';
import { generalRateLimit, optionalAuth } from './auth/middleware.js';
import { adAdminRouter, adRouter } from './features/ads.js';
import { adminRouter, analyticsRouter } from './features/admin.js';
import { collectionRouter } from './features/collections.js';
import { configRouter } from './features/config.js';
import { crateRouter } from './features/crates.js';
import { dailyRouter } from './features/daily.js';
import { eventAdminRouter, eventRouter } from './features/events.js';
import { giftRouter } from './features/gifts.js';
import { inventoryRouter } from './features/inventory.js';
import { moderationRouter, reportRouter } from './features/moderation.js';
import { monetizationRouter } from './features/monetization.js';
import { notificationRouter } from './features/notifications.js';
import { passAdminRouter, passRouter } from './features/pass.js';
import { promoAdminRouter, promoRouter } from './features/promos.js';
import { preferencesRouter } from './features/preferences.js';
import { catalogRouter, profileRouter } from './features/profile.js';
import { searchRouter } from './features/search.js';
import { storeAdminRouter, storeRouter } from './features/store.js';
import { subscriptionAdminRouter, subscriptionRouter } from './features/subscriptions.js';
import { perfAdminRouter, telemetryRouter } from './features/telemetry.js';
import { seasonRouter } from './features/seasons.js';
import { leaderboardRouter, socialRouter } from './features/social.js';
import { tournamentRouter } from './features/tournaments.js';
import { healthy } from './db/pool.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { CORS_ORIGINS, NODE_ENV } from './lib/env.js';
import { redisReady } from './lib/redis.js';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer, so req.ip reflects the real client.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON only; a strict CSP belongs on the web app.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS,
      credentials: true,
      maxAge: 86_400,
    }),
  );

  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    const database = await healthy();
    res.status(database ? 200 : 503).json({
      ok: database,
      env: NODE_ENV,
      database,
      redis: redisReady(),
      uptime: Math.round(process.uptime()),
    });
  });

  app.use('/auth', authRouter);
  app.use('/catalog', catalogRouter);

  app.use(optionalAuth, generalRateLimit);

  app.use('/profile', profileRouter);
  app.use('/inventory', inventoryRouter);
  app.use('/crates', crateRouter);
  app.use('/collections', collectionRouter);
  app.use('/daily', dailyRouter);
  app.use('/preferences', preferencesRouter);
  app.use('/ads', adRouter);
  app.use('/events', eventRouter);
  app.use('/gifts', giftRouter);
  app.use('/store', storeRouter);
  app.use('/pass', passRouter);
  app.use('/subscriptions', subscriptionRouter);
  app.use('/promos', promoRouter);
  app.use('/notifications', notificationRouter);
  app.use('/telemetry', telemetryRouter);
  app.use('/search', searchRouter);
  app.use('/seasons', seasonRouter);
  app.use('/social', socialRouter);
  app.use('/leaderboard', leaderboardRouter);
  app.use('/tournaments', tournamentRouter);
  app.use('/reports', reportRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/admin', adminRouter);
  app.use('/admin/config', configRouter);
  app.use('/admin/moderation', moderationRouter);
  app.use('/admin/events', eventAdminRouter);
  app.use('/admin/store', storeAdminRouter);
  app.use('/admin/pass', passAdminRouter);
  app.use('/admin/subscriptions', subscriptionAdminRouter);
  app.use('/admin/promos', promoAdminRouter);
  app.use('/admin/ads', adAdminRouter);
  app.use('/admin/monetization', monetizationRouter);
  app.use('/admin/perf', perfAdminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
