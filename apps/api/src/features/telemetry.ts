import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { route } from '../lib/errors.js';
import { generalRateLimit, optionalAuth, requireAuth, requireRole } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';

/**
 * Client performance telemetry.
 *
 * The client measures frame rate and ping locally and posts a summary at most
 * once a minute. That keeps this endpoint cheap and, more importantly, keeps
 * the data honest: a per-frame firehose would tell us about the network more
 * than about the game.
 *
 * Nothing here identifies a device. The user id is stored so a support ticket
 * can be matched to a session, and device_class is a coarse three-way bucket —
 * there is no fingerprint, no model string, no IP.
 */
export const telemetryRouter = Router();
export const perfAdminRouter = Router();

const PLATFORMS = ['web', 'ios', 'android', 'unknown'] as const;

const sampleSchema = z.object({
  platform: z.enum(PLATFORMS).default('unknown'),
  appVersion: z.string().max(32).default('dev'),
  deviceClass: z.enum(['low', 'mid', 'high', 'unknown']).default('unknown'),
  fpsAvg: z.number().min(0).max(240),
  fpsMin: z.number().min(0).max(240),
  jankRatio: z.number().min(0).max(1).default(0),
  pingMs: z.number().int().min(0).max(60_000).nullable().optional(),
  drops: z.number().int().min(0).max(10_000).default(0),
  memoryMb: z.number().int().min(0).max(65_536).nullable().optional(),
  inMatch: z.boolean().default(false),
});

telemetryRouter.post(
  '/perf',
  optionalAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = sampleSchema.parse(req.body);

    await query(
      `INSERT INTO perf_samples
         (user_id, platform, app_version, device_class, fps_avg, fps_min,
          jank_ratio, ping_ms, drops, memory_mb, in_match)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        req.auth?.sub ?? null,
        body.platform,
        body.appVersion,
        body.deviceClass,
        body.fpsAvg,
        body.fpsMin,
        body.jankRatio,
        body.pingMs ?? null,
        body.drops,
        body.memoryMb ?? null,
        body.inMatch,
      ],
    );

    res.status(202).json({ ok: true });
  }),
);

telemetryRouter.post(
  '/error',
  optionalAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({
        platform: z.enum(PLATFORMS).default('unknown'),
        appVersion: z.string().max(32).default('dev'),
        kind: z.enum(['crash', 'error', 'socket', 'render']).default('error'),
        message: z.string().min(1).max(500),
        stack: z.string().max(4_000).optional(),
        context: z.record(z.unknown()).default({}),
      })
      .parse(req.body);

    await query(
      `INSERT INTO client_errors (user_id, platform, app_version, kind, message, stack, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        req.auth?.sub ?? null,
        body.platform,
        body.appVersion,
        body.kind,
        body.message,
        body.stack ?? null,
        JSON.stringify(body.context),
      ],
    );

    // Crashes are worth a server-side log line as well; they are rare enough.
    if (body.kind === 'crash') {
      logger.warn({ platform: body.platform, message: body.message }, 'client crash reported');
    }

    res.status(202).json({ ok: true });
  }),
);

/* ------------------------------ admin views ------------------------------- */

interface Bucket {
  bucket: string;
  samples: string;
  fps_avg: number;
  fps_p10: number;
  jank: number;
  ping_p50: number | null;
  ping_p95: number | null;
}

perfAdminRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const params = z
      .object({
        hours: z.coerce.number().int().min(1).max(720).default(24),
        platform: z.enum(PLATFORMS).optional(),
      })
      .parse(req.query);

    // Bucket width follows the range, so the chart always has ~24-48 points.
    const bucketMinutes = params.hours <= 6 ? 15 : params.hours <= 48 ? 60 : 360;

    const series = await query<Bucket>(
      `SELECT to_char(date_bin(($2 || ' minutes')::interval, sampled_at, TIMESTAMPTZ 'epoch'),
                      'YYYY-MM-DD"T"HH24:MI:SSZ') AS bucket,
              COUNT(*)::text                                   AS samples,
              AVG(fps_avg)::real                               AS fps_avg,
              percentile_cont(0.10) WITHIN GROUP (ORDER BY fps_avg)::real AS fps_p10,
              AVG(jank_ratio)::real                            AS jank,
              percentile_cont(0.50) WITHIN GROUP (ORDER BY ping_ms)::real AS ping_p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ping_ms)::real AS ping_p95
         FROM perf_samples
        WHERE sampled_at > now() - ($1 || ' hours')::interval
          AND ($3::text IS NULL OR platform = $3)
        GROUP BY 1
        ORDER BY 1`,
      [String(params.hours), String(bucketMinutes), params.platform ?? null],
    );

    const byPlatform = await query<{
      platform: string;
      device_class: string;
      samples: string;
      fps_avg: number;
      jank: number;
    }>(
      `SELECT platform, device_class, COUNT(*)::text AS samples,
              AVG(fps_avg)::real AS fps_avg, AVG(jank_ratio)::real AS jank
         FROM perf_samples
        WHERE sampled_at > now() - ($1 || ' hours')::interval
        GROUP BY platform, device_class
        ORDER BY COUNT(*) DESC`,
      [String(params.hours)],
    );

    const errors = await query<{
      kind: string;
      platform: string;
      message: string;
      count: string;
      last_seen: string;
    }>(
      `SELECT kind, platform, message, COUNT(*)::text AS count,
              to_char(MAX(created_at), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS last_seen
         FROM client_errors
        WHERE created_at > now() - ($1 || ' hours')::interval
        GROUP BY kind, platform, message
        ORDER BY COUNT(*) DESC
        LIMIT 25`,
      [String(params.hours)],
    );

    const totals = await one<{
      samples: string;
      sessions: string;
      crashes: string;
      fps_avg: number | null;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM perf_samples
           WHERE sampled_at > now() - ($1 || ' hours')::interval)             AS samples,
         (SELECT COUNT(DISTINCT user_id)::text FROM perf_samples
           WHERE sampled_at > now() - ($1 || ' hours')::interval)             AS sessions,
         (SELECT COUNT(*)::text FROM client_errors
           WHERE kind = 'crash' AND created_at > now() - ($1 || ' hours')::interval) AS crashes,
         (SELECT AVG(fps_avg)::real FROM perf_samples
           WHERE sampled_at > now() - ($1 || ' hours')::interval)             AS fps_avg`,
      [String(params.hours)],
    );

    const sessions = Number(totals?.sessions ?? 0);
    const crashes = Number(totals?.crashes ?? 0);

    res.json({
      hours: params.hours,
      bucketMinutes,
      totals: {
        samples: Number(totals?.samples ?? 0),
        sessions,
        crashes,
        fpsAvg: totals?.fps_avg ?? null,
        // Crash rate per session; the number people actually ask for.
        crashRate: sessions > 0 ? crashes / sessions : 0,
      },
      series: series.map((row) => ({
        bucket: row.bucket,
        samples: Number(row.samples),
        fpsAvg: row.fps_avg,
        fpsP10: row.fps_p10,
        jank: row.jank,
        pingP50: row.ping_p50,
        pingP95: row.ping_p95,
      })),
      byPlatform: byPlatform.map((row) => ({
        platform: row.platform,
        deviceClass: row.device_class,
        samples: Number(row.samples),
        fpsAvg: row.fps_avg,
        jank: row.jank,
      })),
      errors: errors.map((row) => ({
        kind: row.kind,
        platform: row.platform,
        message: row.message,
        count: Number(row.count),
        lastSeen: row.last_seen,
      })),
    });
  }),
);

/* ------------------------------- retention -------------------------------- */

/** Tables safe to prune, and how far back we insist on keeping. */
const PRUNABLE: Record<string, { column: string; minDays: number }> = {
  perf_samples: { column: 'sampled_at', minDays: 7 },
  client_errors: { column: 'created_at', minDays: 30 },
  analytics_events: { column: 'created_at', minDays: 30 },
  match_events: { column: 'created_at', minDays: 90 },
};

perfAdminRouter.post(
  '/prune',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        table: z.enum(Object.keys(PRUNABLE) as [string, ...string[]]),
        olderThanDays: z.number().int().min(1).max(3_650),
      })
      .parse(req.body);

    const rule = PRUNABLE[body.table]!;
    if (body.olderThanDays < rule.minDays) {
      res.status(400).json({
        error: {
          code: 'RETENTION_FLOOR',
          message: `${body.table} must keep at least ${rule.minDays} days.`,
        },
      });
      return;
    }

    // The table name is from a fixed allow-list above, never from the request.
    const deleted = await query<{ id: string }>(
      `DELETE FROM ${body.table}
        WHERE ${rule.column} < now() - ($1 || ' days')::interval
        RETURNING 1 AS id`,
      [String(body.olderThanDays)],
    );

    await query(
      `INSERT INTO retention_runs (table_name, older_than, deleted, run_by)
       VALUES ($1, now() - ($2 || ' days')::interval, $3, $4)`,
      [body.table, String(body.olderThanDays), deleted.length, req.auth!.sub],
    );

    logger.info(
      { table: body.table, deleted: deleted.length, admin: req.auth!.sub },
      'retention prune',
    );

    res.json({ table: body.table, deleted: deleted.length });
  }),
);

perfAdminRouter.get(
  '/prune',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const runs = await query<{
      table_name: string;
      deleted: string;
      run_at: string;
      older_than: string;
    }>(
      `SELECT table_name, deleted::text, run_at, older_than
         FROM retention_runs ORDER BY run_at DESC LIMIT 25`,
    );
    res.json({
      rules: Object.entries(PRUNABLE).map(([table, rule]) => ({ table, minDays: rule.minDays })),
      runs: runs.map((row) => ({
        table: row.table_name,
        deleted: Number(row.deleted),
        runAt: row.run_at,
        olderThan: row.older_than,
      })),
    });
  }),
);
