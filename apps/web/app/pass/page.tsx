'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The Carrom Pass.
 *
 * Laid out as a track you scroll along, free rewards on top and premium below,
 * with the current tier scrolled into view on open — the first thing a player
 * wants to know is where they are, not where the track starts.
 */
interface Reward {
  tier: number;
  track: 'free' | 'premium';
  kind: 'coins' | 'gems' | 'crate' | 'item' | 'xp' | 'title';
  amount: number;
  itemId: string | null;
  crateKind: string | null;
  unlocked: boolean;
  claimed: boolean;
}

interface PassResponse {
  pass: {
    id: string;
    name: string;
    description: string;
    tiers: number;
    xpPerTier: number;
    accent: string;
    endsAt: string;
    productId: string | null;
  } | null;
  premium: boolean;
  xp: number;
  tier: number;
  xpIntoTier: number;
  rewards: Reward[];
  message?: string;
}

export default function PassPage() {
  const { refresh } = useSession();
  const [data, setData] = useState<PassResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const currentRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const response = await api<PassResponse>('/pass').catch(() => null);
    if (response) setData(response);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Land on the player's current tier rather than tier one.
  useEffect(() => {
    if (data?.pass) {
      currentRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }, [data?.pass, data?.tier]);

  const claim = async (tier: number, track: 'free' | 'premium') => {
    setBusy(true);
    setNote(null);
    try {
      await api('/pass/claim', { method: 'POST', body: { tier, track } });
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Could not claim that.');
    } finally {
      setBusy(false);
    }
  };

  const claimAll = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{ claimed: number; coins: number; gems: number }>('/pass/claim-all', {
        method: 'POST',
      });
      setNote(
        result.claimed === 0
          ? 'Nothing to claim yet.'
          : `Claimed ${result.claimed} rewards: ${formatCoins(result.coins)} coins${
              result.gems ? `, ${result.gems} gems` : ''
            }.`,
      );
      await Promise.all([load(), refresh()]);
    } catch {
      setNote('Could not claim right now.');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="py-16 text-center text-sm text-white/40">Loading…</p>;

  if (!data.pass) {
    return (
      <div className="panel p-10 text-center">
        <div className="mb-2 text-4xl">{'\u{1F3AB}'}</div>
        <h1 className="font-display text-xl font-bold">No pass is running</h1>
        <p className="mt-1 text-sm text-white/45">{data.message ?? 'Check back next season.'}</p>
      </div>
    );
  }

  const { pass } = data;
  const claimable = data.rewards.filter((r) => r.unlocked && !r.claimed).length;
  const progress = (data.xpIntoTier / pass.xpPerTier) * 100;

  return (
    <div className="space-y-4">
      <header className="panel p-5" style={{ borderColor: `${pass.accent}44` }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold">{pass.name}</h1>
            <p className="text-sm text-white/45">{pass.description}</p>
          </div>

          {!data.premium && pass.productId && (
            <Link href="/store" className="btn-primary text-sm">
              Get the pass
            </Link>
          )}
          {data.premium && (
            <span
              className="rounded-full px-3 py-1 text-xs font-bold"
              style={{ background: `${pass.accent}22`, color: pass.accent }}
            >
              Premium unlocked
            </span>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-lg font-black"
            style={{ background: `${pass.accent}22`, color: pass.accent }}
          >
            {data.tier}
          </span>

          <div className="min-w-0 flex-1">
            <div className="mb-1 flex justify-between text-[11px] text-white/45">
              <span>
                Tier {data.tier} of {pass.tiers}
              </span>
              <span className="tabular-nums">
                {data.xpIntoTier} / {pass.xpPerTier} XP
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{ width: `${progress}%`, background: pass.accent }}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn-ghost shrink-0 text-xs"
            disabled={busy || claimable === 0}
            onClick={() => void claimAll()}
          >
            Claim all{claimable > 0 ? ` (${claimable})` : ''}
          </button>
        </div>

        <p className="mt-2 text-[11px] text-white/35">
          Ends {new Date(pass.endsAt).toLocaleDateString()} · Rewards are coins, gems, crates and
          cosmetics. Nothing here changes how a match plays.
        </p>
      </header>

      {note && (
        <p className="animate-fade-up rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-white/70">
          {note}
        </p>
      )}

      <div className="panel overflow-x-auto p-4">
        <div className="flex min-w-max gap-2">
          {Array.from({ length: pass.tiers }, (_, index) => {
            const tier = index + 1;
            const free = data.rewards.find((r) => r.tier === tier && r.track === 'free');
            const premium = data.rewards.find((r) => r.tier === tier && r.track === 'premium');
            const reached = tier <= data.tier;

            return (
              <div
                key={tier}
                ref={tier === Math.max(1, data.tier) ? currentRef : undefined}
                className="w-[86px] shrink-0"
              >
                <div
                  className={`mb-1.5 rounded-lg py-1 text-center text-[11px] font-bold tabular-nums ${
                    reached ? 'text-ink-950' : 'bg-white/5 text-white/35'
                  }`}
                  style={reached ? { background: pass.accent } : undefined}
                >
                  {tier}
                </div>

                <RewardCell
                  reward={free}
                  locked={!reached}
                  busy={busy}
                  onClaim={() => void claim(tier, 'free')}
                />

                <div className="my-1.5 text-center text-[9px] uppercase tracking-wider text-white/25">
                  premium
                </div>

                <RewardCell
                  reward={premium}
                  locked={!reached || !data.premium}
                  lockReason={!data.premium ? 'pass' : 'tier'}
                  busy={busy}
                  accent={pass.accent}
                  onClaim={() => void claim(tier, 'premium')}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const ICONS: Record<string, string> = {
  coins: '\u{1FA99}',
  gems: '\u{1F48E}',
  crate: '\u{1F381}',
  item: '\u{1F3A8}',
  xp: '\u{2B50}',
  title: '\u{1F3F7}\u{FE0F}',
};

function RewardCell({
  reward,
  locked,
  lockReason = 'tier',
  busy,
  accent,
  onClaim,
}: {
  reward: Reward | undefined;
  locked: boolean;
  lockReason?: 'tier' | 'pass';
  busy: boolean;
  accent?: string;
  onClaim(): void;
}) {
  if (!reward) {
    return <div className="h-[68px] rounded-lg border border-dashed border-white/8" />;
  }

  const label =
    reward.kind === 'coins'
      ? formatCoins(reward.amount)
      : reward.kind === 'gems'
        ? `${reward.amount}`
        : reward.kind === 'crate'
          ? (reward.crateKind ?? 'crate')
          : reward.kind;

  const claimable = !locked && !reward.claimed;

  return (
    <button
      type="button"
      disabled={!claimable || busy}
      onClick={onClaim}
      title={locked && lockReason === 'pass' ? 'Needs the premium pass' : undefined}
      className={`h-[68px] w-full rounded-lg border p-1.5 text-center transition ${
        reward.claimed
          ? 'border-white/8 bg-white/[0.02] opacity-45'
          : claimable
            ? 'border-brass-400/60 bg-brass-400/10 hover:bg-brass-400/20'
            : 'border-white/8 bg-white/[0.03] opacity-60'
      }`}
      style={claimable && accent ? { borderColor: `${accent}99` } : undefined}
    >
      <div className="text-base leading-none">{ICONS[reward.kind] ?? '\u{1F381}'}</div>
      <div className="mt-1 truncate text-[10px] font-semibold capitalize">{label}</div>
      <div className="mt-0.5 text-[9px] text-white/40">
        {reward.claimed ? 'claimed' : claimable ? 'tap to claim' : locked && lockReason === 'pass' ? 'locked' : ''}
      </div>
    </button>
  );
}
