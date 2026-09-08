'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { usePreferences } from '@/lib/preferences';

/**
 * Adverts.
 *
 * Every ad here is drawn from a few fields the server sends: a headline, a
 * line of body text, a call to action and two colours. Nothing loads a
 * third-party script, so an ad cannot track anyone, cannot slow the game down,
 * and cannot look out of place.
 *
 * The server decides whether an ad is allowed at all — ad-free accounts, daily
 * caps and minimum gaps are enforced there, not here. These components ask, and
 * render nothing when the answer is no.
 */
interface Ad {
  impressionId: number;
  placement: string;
  headline: string;
  body: string;
  cta: string;
  clickUrl: string | null;
  accent: string;
  background: string;
  emblem: string;
}

interface AdResponse {
  ad: Ad | null;
  reason?: string;
  reward?: { coins: number; gems: number } | null;
}

async function requestAd(placement: string): Promise<AdResponse> {
  return api<AdResponse>(`/ads/next?placement=${placement}&platform=web`).catch(() => ({
    ad: null,
    reason: 'error',
  }));
}

function recordClick(impressionId: number): void {
  void api('/ads/click', { method: 'POST', body: { impressionId } }).catch(() => undefined);
}

/* --------------------------------- banner --------------------------------- */

/** A quiet strip. Safe to place on any page; renders nothing when not allowed. */
export function AdBanner({ className = '' }: { className?: string }) {
  const [ad, setAd] = useState<Ad | null>(null);

  useEffect(() => {
    let cancelled = false;
    void requestAd('banner').then((response) => {
      if (!cancelled) setAd(response.ad);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ad) return null;

  return (
    <aside
      className={`flex items-center gap-3 rounded-xl border p-3 ${className}`}
      style={{ borderColor: `${ad.accent}44`, background: ad.background }}
      aria-label="Advertisement"
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base"
        style={{ background: `${ad.accent}22`, color: ad.accent }}
      >
        {'✦'}
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{ad.headline}</div>
        <div className="truncate text-[11px] text-white/50">{ad.body}</div>
      </div>

      <AdCta ad={ad} small />
      <span className="shrink-0 text-[9px] uppercase tracking-wider text-white/25">Ad</span>
    </aside>
  );
}

/* ------------------------------ interstitial ------------------------------ */

/**
 * A full-screen card between matches.
 *
 * Dismissible after three seconds. The countdown is real and visible, because
 * an ad you cannot see the end of is the one people uninstall over.
 */
export function AdInterstitial({ onDone }: { onDone(): void }) {
  const [ad, setAd] = useState<Ad | null>(null);
  const [remaining, setRemaining] = useState(3);
  const { prefs } = usePreferences();

  useEffect(() => {
    let cancelled = false;
    void requestAd('interstitial').then((response) => {
      if (cancelled) return;
      // Nothing to show is not an error; carry on immediately.
      if (!response.ad) onDone();
      else setAd(response.ad);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ad) return;
    const timer = window.setInterval(() => {
      setRemaining((value) => (value <= 1 ? 0 : value - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [ad]);

  if (!ad) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur-sm">
      <div
        className={`w-full max-w-sm overflow-hidden rounded-2xl border ${
          prefs.reducedMotion ? '' : 'animate-pop-in'
        }`}
        style={{ borderColor: `${ad.accent}55`, background: ad.background }}
        role="dialog"
        aria-label="Advertisement"
      >
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="text-[10px] uppercase tracking-wider text-white/30">Advertisement</span>
          <button
            type="button"
            disabled={remaining > 0}
            onClick={onDone}
            className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/70 transition hover:bg-white/10 disabled:opacity-40"
          >
            {remaining > 0 ? `${remaining}` : 'Close'}
          </button>
        </div>

        <div className="p-6 text-center">
          <div
            className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl text-2xl"
            style={{ background: `${ad.accent}22`, color: ad.accent }}
          >
            {'✦'}
          </div>
          <h2 className="font-display text-xl font-bold">{ad.headline}</h2>
          <p className="mt-1.5 text-sm text-white/55">{ad.body}</p>
          <div className="mt-5">
            <AdCta ad={ad} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- rewarded -------------------------------- */

/**
 * Watch a short clip for coins.
 *
 * Entirely opt-in: it is a button the player presses, never something that
 * interrupts. The reward is granted by the server against the impression it
 * issued, so closing early pays nothing and replaying pays once.
 */
export function RewardedAdButton({
  label = 'Watch for coins',
  onRewarded,
  className = '',
}: {
  label?: string;
  onRewarded?(coins: number): void;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'done' | 'unavailable'>('idle');
  const [ad, setAd] = useState<Ad | null>(null);
  const [reward, setReward] = useState<{ coins: number; gems: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<number | null>(null);

  // The clip runs for this long. It is also the floor the server enforces.
  const DURATION = 8;

  const start = useCallback(async () => {
    setState('loading');
    const response = await requestAd('rewarded');
    if (!response.ad) {
      setState('unavailable');
      return;
    }
    setAd(response.ad);
    setReward(response.reward ?? null);
    setProgress(0);
    setState('playing');
  }, []);

  useEffect(() => {
    if (state !== 'playing') return;

    timerRef.current = window.setInterval(() => {
      setProgress((value) => Math.min(DURATION, value + 0.1));
    }, 100);

    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'playing' || progress < DURATION || !ad) return;

    void api<{ granted?: { coins: number }; alreadyRewarded?: boolean }>('/ads/complete', {
      method: 'POST',
      body: { impressionId: ad.impressionId },
    })
      .then((result) => {
        setState('done');
        if (result.granted) onRewarded?.(result.granted.coins);
      })
      .catch(() => setState('done'));
  }, [state, progress, ad, onRewarded]);

  if (state === 'unavailable') {
    return (
      <p className={`text-xs text-white/35 ${className}`}>
        No videos available right now. Try again later.
      </p>
    );
  }

  if (state === 'playing' && ad) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-4">
        <div
          className="w-full max-w-sm overflow-hidden rounded-2xl border"
          style={{ borderColor: `${ad.accent}55`, background: ad.background }}
        >
          <div className="p-8 text-center">
            <div
              className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full text-3xl"
              style={{ background: `${ad.accent}22`, color: ad.accent }}
            >
              {'▶'}
            </div>
            <h2 className="font-display text-xl font-bold">{ad.headline}</h2>
            <p className="mt-1.5 text-sm text-white/55">{ad.body}</p>
          </div>

          <div className="h-1.5 bg-white/8">
            <div
              className="h-full transition-[width] duration-100 ease-linear"
              style={{ width: `${(progress / DURATION) * 100}%`, background: ad.accent }}
            />
          </div>

          <div className="flex items-center justify-between px-4 py-2.5 text-[11px] text-white/40">
            <span>Advertisement</span>
            <span className="tabular-nums">{Math.ceil(DURATION - progress)}s</span>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <p className={`text-xs font-semibold text-felt-400 ${className}`}>
        {reward ? `+${reward.coins} coins added.` : 'Thanks for watching.'}
      </p>
    );
  }

  return (
    <button
      type="button"
      className={`btn-ghost text-sm ${className}`}
      disabled={state === 'loading'}
      onClick={() => void start()}
    >
      {state === 'loading' ? 'Loading…' : `\u{1F3AC} ${label}`}
    </button>
  );
}

/* --------------------------------- shared --------------------------------- */

function AdCta({ ad, small = false }: { ad: Ad; small?: boolean }) {
  const classes = small
    ? 'shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold'
    : 'inline-block rounded-xl px-5 py-2.5 text-sm font-semibold';
  const style = { background: ad.accent, color: '#07080d' };

  // House ads point at our own pages, so they navigate rather than leaving.
  const internal = !ad.clickUrl || ad.clickUrl.startsWith('/');

  if (internal) {
    return (
      <Link
        href={ad.clickUrl ?? '/store'}
        className={classes}
        style={style}
        onClick={() => recordClick(ad.impressionId)}
      >
        {ad.cta}
      </Link>
    );
  }

  return (
    <a
      href={ad.clickUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={classes}
      style={style}
      onClick={() => recordClick(ad.impressionId)}
    >
      {ad.cta}
    </a>
  );
}
