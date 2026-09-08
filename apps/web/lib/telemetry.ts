'use client';

import { API_URL, getAccessToken } from './api';

/**
 * Client performance telemetry.
 *
 * The point is to know whether the game is smooth on the devices people
 * actually own, so this measures frame time from requestAnimationFrame and
 * posts a one-line summary once a minute. It never posts per-frame data: that
 * would cost more than the thing it measures.
 *
 * It is deliberately fire-and-forget. A failed telemetry post must never
 * surface to a player or retry into a storm.
 */
const FLUSH_MS = 60_000;
/** A frame over this is visible as a stutter. */
const JANK_MS = 50;

interface Sample {
  frames: number[];
  drops: number;
  pings: number[];
  inMatch: boolean;
}

let sample: Sample = { frames: [], drops: 0, pings: [], inMatch: false };
let running = false;
let rafId: number | null = null;
let flushTimer: number | null = null;
let lastFrame = 0;

/** Rough device tier from what the browser is willing to tell us. */
function deviceClass(): 'low' | 'mid' | 'high' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const cores = navigator.hardwareConcurrency ?? 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  if (!cores && !memory) return 'unknown';
  if (cores >= 8 && memory >= 8) return 'high';
  if (cores >= 4 && memory >= 4) return 'mid';
  return 'low';
}

function memoryMb(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  if (!perf.memory) return null;
  return Math.round(perf.memory.usedJSHeapSize / 1_048_576);
}

function tick(now: number): void {
  if (lastFrame > 0) {
    const delta = now - lastFrame;
    // Ignore absurd gaps: a backgrounded tab is not a dropped frame.
    if (delta < 2_000) sample.frames.push(delta);
  }
  lastFrame = now;
  rafId = requestAnimationFrame(tick);
}

async function flush(): Promise<void> {
  const frames = sample.frames;
  const pings = sample.pings;
  const inMatch = sample.inMatch;
  const drops = sample.drops;
  sample = { frames: [], drops: 0, pings: [], inMatch };

  // Fewer than a couple of seconds of frames is noise, not a measurement.
  if (frames.length < 60) return;

  const fps = frames.map((ms) => 1_000 / Math.max(ms, 1));
  const fpsAvg = fps.reduce((a, b) => a + b, 0) / fps.length;
  const fpsMin = Math.min(...fps);
  const jank = frames.filter((ms) => ms > JANK_MS).length / frames.length;
  const ping = pings.length
    ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length)
    : null;

  const body = JSON.stringify({
    platform: 'web',
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
    deviceClass: deviceClass(),
    fpsAvg: Math.round(fpsAvg * 10) / 10,
    fpsMin: Math.round(fpsMin * 10) / 10,
    jankRatio: Math.round(jank * 1000) / 1000,
    pingMs: ping,
    drops,
    memoryMb: memoryMb(),
    inMatch,
  });

  try {
    await fetch(`${API_URL}/telemetry/perf`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(getAccessToken() ? { authorization: `Bearer ${getAccessToken()}` } : {}),
      },
      body,
      keepalive: true,
    });
  } catch {
    // Telemetry is never worth surfacing or retrying.
  }
}

export function startTelemetry(): () => void {
  if (running || typeof window === 'undefined') return () => undefined;
  running = true;
  lastFrame = 0;
  rafId = requestAnimationFrame(tick);
  flushTimer = window.setInterval(() => void flush(), FLUSH_MS);

  // Send what we have when the tab goes away, rather than losing the session.
  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onHidden);

  return () => {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (flushTimer !== null) window.clearInterval(flushTimer);
    document.removeEventListener('visibilitychange', onHidden);
  };
}

/** Called by the match socket so latency is measured where it matters. */
export function recordPing(ms: number): void {
  if (ms >= 0 && ms < 60_000) sample.pings.push(ms);
}

export function recordDrop(): void {
  sample.drops += 1;
}

export function setInMatch(value: boolean): void {
  sample.inMatch = value;
}

/** Report a crash or unhandled error. Trimmed, and never blocking. */
export function reportError(
  kind: 'crash' | 'error' | 'socket' | 'render',
  message: string,
  stack?: string,
  context: Record<string, unknown> = {},
): void {
  void fetch(`${API_URL}/telemetry/error`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(getAccessToken() ? { authorization: `Bearer ${getAccessToken()}` } : {}),
    },
    body: JSON.stringify({
      platform: 'web',
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
      kind,
      message: message.slice(0, 500),
      stack: stack?.slice(0, 4_000),
      context,
    }),
    keepalive: true,
  }).catch(() => undefined);
}
