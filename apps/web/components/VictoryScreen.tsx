'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DIVISIONS, formatCoins, titleForLevel } from '@carrom/config';
import { victoryById } from '@carrom/content';
import type { MatchResult, PlayerReward } from '@carrom/types';
import { getAccessToken } from '@/lib/api';
import { Avatar } from '@/components/AppShell';
import VictoryEffect from '@/components/VictoryEffect';

/**
 * End-of-match screen.
 *
 * Every number here is the server's; nothing is recomputed. The rewards count
 * up one after another rather than appearing at once, because the point of this
 * screen is to let a win land — but the whole sequence is skippable, and it
 * settles immediately for anyone who has asked for reduced motion.
 */
interface VictoryScreenProps {
  result: MatchResult & { note?: string };
  /** Equipped victory animation of the local player. */
  victoryId?: string | null;
  displayName: string;
  avatarUrl: string | null;
  onClose(): void;
}

function useOwnReward(result: MatchResult): PlayerReward | null {
  return useMemo(() => {
    const rewards = Object.values(result.rewards);
    if (rewards.length <= 1) return rewards[0] ?? null;

    const token = getAccessToken();
    if (!token) return rewards[0] ?? null;
    try {
      const claims = JSON.parse(atob(token.split('.')[1] ?? '')) as { sub?: string };
      return rewards.find((r) => r.userId === claims.sub) ?? rewards[0] ?? null;
    } catch {
      return rewards[0] ?? null;
    }
  }, [result]);
}

/** Counts from zero to `value`, or lands immediately when motion is reduced. */
function useCountUp(value: number, active: boolean, ms = 900): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (value === 0) {
      setShown(0);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }

    const started = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - started) / ms);
      // Ease out, so it decelerates into the final number.
      setShown(Math.round(value * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, active, ms]);

  return shown;
}

export default function VictoryScreen({
  result,
  victoryId,
  displayName,
  avatarUrl,
  onClose,
}: VictoryScreenProps) {
  const mine = useOwnReward(result);
  const won = mine?.won ?? false;
  const draw = result.winner === null;

  const animation = victoryById(victoryId);
  const [stage, setStage] = useState(0);

  // Reveal the reward rows one at a time.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setStage(9);
      return;
    }
    if (stage >= 9) return;
    const id = window.setTimeout(() => setStage((s) => s + 1), stage === 0 ? 500 : 320);
    return () => window.clearTimeout(id);
  }, [stage]);

  const coins = useCountUp(mine?.coins ?? 0, stage >= 1);
  const xp = useCountUp(mine?.xp ?? 0, stage >= 2);

  const rating = mine?.rating ?? null;
  const division = rating ? DIVISIONS.find((d) => d.id === rating.division) : null;
  const title = mine ? titleForLevel(mine.levelAfter) : null;

  const headline = draw ? 'Drawn board' : won ? 'Victory' : 'Good game';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-hidden bg-black/80 p-4 backdrop-blur-sm">
      {won && !draw && (
        <VictoryEffect
          effect={animation.effect}
          primary={animation.primary}
          secondary={animation.secondary}
          durationMs={animation.durationMs}
        />
      )}

      <div className="panel relative w-full max-w-md animate-pop-in overflow-hidden">
        <div
          className="px-6 pb-5 pt-8 text-center"
          style={{
            background: draw
              ? 'linear-gradient(to bottom, rgba(35,40,56,0.6), transparent)'
              : won
                ? `linear-gradient(to bottom, ${animation.primary}33, transparent)`
                : 'linear-gradient(to bottom, rgba(35,40,56,0.5), transparent)',
          }}
        >
          <div className="mx-auto mb-3 w-fit">
            <div
              className={won ? 'rounded-full ring-4' : 'rounded-full ring-2 ring-white/10'}
              style={won ? { boxShadow: `0 0 40px -6px ${animation.primary}` } : undefined}
            >
              <Avatar url={avatarUrl} name={displayName} size={72} />
            </div>
          </div>

          <p
            className="text-xs font-bold uppercase tracking-[0.3em]"
            style={{ color: won ? animation.primary : 'rgba(255,255,255,0.35)' }}
          >
            {headline}
          </p>
          <h2 className="mt-1 font-display text-3xl font-bold">{displayName}</h2>

          <p className="mt-1 text-sm text-white/50">
            {result.note ??
              (draw
                ? 'Every stake returned.'
                : won
                  ? `${result.points} point${result.points === 1 ? '' : 's'}`
                  : 'Better luck on the next board.')}
          </p>

          {title && (
            <span
              className="mt-3 inline-block rounded-full border px-3 py-1 text-[11px] font-semibold"
              style={{ color: title.color, borderColor: `${title.color}55` }}
            >
              Level {mine?.levelAfter} · {title.name}
            </span>
          )}
        </div>

        {mine && (
          <div className="space-y-2 px-6">
            <Row
              show={stage >= 1}
              icon={'\u{1FA99}'}
              label="Coins"
              value={mine.coins > 0 ? `+${formatCoins(coins)}` : draw ? 'Returned' : '—'}
              highlight={mine.coins > 0}
            />
            <Row show={stage >= 2} icon={'\u{2728}'} label="XP" value={`+${xp}`} />

            {rating && (
              <Row
                show={stage >= 3}
                icon={'\u{1F3C5}'}
                label={rating.promoted ? 'Promoted' : rating.demoted ? 'Demoted' : 'Rating'}
                value={`${rating.delta > 0 ? '+' : ''}${rating.delta} → ${rating.after}`}
                highlight={rating.delta > 0}
                sub={division ? division.name : undefined}
                subColor={division?.color}
              />
            )}

            {mine.levelAfter > mine.levelBefore && (
              <Row
                show={stage >= 4}
                icon={'\u{2B06}'}
                label="Level up"
                value={`${mine.levelBefore} → ${mine.levelAfter}`}
                highlight
              />
            )}

            {mine.crateKind && (
              <Row show={stage >= 5} icon={'\u{1F381}'} label="Crate won" value={mine.crateKind} highlight />
            )}

            {mine.streak >= 2 && (
              <Row show={stage >= 6} icon={'\u{1F525}'} label="Win streak" value={String(mine.streak)} />
            )}

            {mine.note && stage >= 7 && (
              <p className="animate-fade-up rounded-lg border border-brass-400/25 bg-brass-400/10 px-3 py-2 text-xs text-brass-400">
                {mine.note}
              </p>
            )}

            {mine.achievements.length > 0 && stage >= 8 && (
              <div className="animate-pop-in rounded-lg border border-epic/30 bg-epic/10 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wider text-epic">Achievement unlocked</p>
                {mine.achievements.map((name) => (
                  <p key={name} className="text-sm font-semibold">
                    {name}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 p-6">
          {mine?.crateId && (
            <Link href="/crates" className="btn-primary flex-1" onClick={onClose}>
              Open crate
            </Link>
          )}
          <button
            type="button"
            className={mine?.crateId ? 'btn-ghost flex-1' : 'btn-primary flex-1'}
            onClick={stage < 9 ? () => setStage(9) : onClose}
          >
            {stage < 9 ? 'Skip' : mine?.crateId ? 'Later' : 'Play again'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  show,
  icon,
  label,
  value,
  highlight = false,
  sub,
  subColor,
}: {
  show: boolean;
  icon: string;
  label: string;
  value: string;
  highlight?: boolean;
  sub?: string;
  subColor?: string;
}) {
  if (!show) return null;
  return (
    <div className="flex animate-fade-up items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-2.5">
      <span className="text-lg">{icon}</span>
      <span className="flex-1 text-sm text-white/60">{label}</span>
      <div className="text-right">
        <div
          className={`text-sm font-bold tabular-nums ${highlight ? 'text-brass-400' : 'text-white/85'}`}
        >
          {value}
        </div>
        {sub && (
          <div className="text-[10px]" style={{ color: subColor ?? 'rgba(255,255,255,0.35)' }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}
