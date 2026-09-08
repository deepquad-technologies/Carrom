'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { RARITY, formatDuration, type CosmeticItem, type Rarity } from '@carrom/content';
import { ApiError, api } from '@/lib/api';
import { ItemPreview } from '@/components/SkinPreview';
import { useSession } from '@/lib/session';
import { RewardedAdButton } from '@/components/Ads';

interface OwnedCrate {
  id: string;
  kind: string;
  name: string;
  tierEntry: number;
  remaining: number;
  ready: boolean;
  unlocking: boolean;
  speedUpCost: number;
  unlockMs: number;
  color: string;
  accent: string;
  glow: string;
}

interface CrateType {
  id: string;
  name: string;
  description: string;
  unlockMs: number;
  itemDrops: number;
  guaranteed: Rarity;
  xp: number;
  color: string;
  accent: string;
  dropRates: Array<{ rarity: Rarity; percent: number }>;
}

interface CratesPayload {
  crates: OwnedCrate[];
  slots: number;
  types: CrateType[];
}

interface OpenResult {
  kind: string;
  coins: number;
  xp: number;
  balance: number;
  levelUp: number | null;
  drops: Array<{ item: CosmeticItem; duplicate: boolean; coins: number; fragments: number }>;
}

export default function CratesPage() {
  const { setBalance, refresh } = useSession();
  const [data, setData] = useState<CratesPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [, forceTick] = useState(0);

  const load = useCallback(
    () => api<CratesPayload>('/crates').then(setData).catch(() => undefined),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Redraw once a second so unlock timers count down.
  useEffect(() => {
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const act = async (crateId: string, action: 'unlock' | 'speed-up' | 'open') => {
    setBusy(crateId);
    setError(null);
    try {
      const result = await api<Record<string, unknown>>(`/crates/${crateId}/${action}`, {
        method: 'POST',
      });
      if (typeof result.balance === 'number') setBalance(result.balance);
      if (action === 'open') {
        setOpened(result as unknown as OpenResult);
        void refresh();
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const slots = data?.slots ?? 4;

  return (
    <div className="animate-fade-up space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Crates</h1>
          <p className="text-sm text-white/45">
            Win a match to earn one. Unlock timers run whether the app is open or not.
          </p>
        </div>

        {/* Short of coins for a skip? Watching pays instead of spending. */}
        <RewardedAdButton label="Watch for 500 coins" onRewarded={() => void refresh()} />
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: slots }).map((_, index) => {
          const crate = data?.crates[index];

          if (!crate) {
            return (
              <div
                key={`empty-${index}`}
                className="grid aspect-[4/5] place-items-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] text-center"
              >
                <div className="px-4">
                  <div className="mb-2 text-3xl opacity-25">{'\u{1F381}'}</div>
                  <p className="text-xs text-white/30">Empty slot</p>
                </div>
              </div>
            );
          }

          return (
            <article
              key={crate.id}
              className="panel relative flex flex-col items-center gap-3 overflow-hidden p-4"
              style={{ borderColor: `${crate.accent}55` }}
            >
              <div
                className="pointer-events-none absolute -top-16 h-32 w-32 rounded-full blur-2xl"
                style={{ background: crate.glow }}
              />

              <div
                className={`relative grid h-24 w-24 place-items-center rounded-2xl text-4xl ${
                  crate.ready ? 'animate-float' : ''
                }`}
                style={{
                  background: `linear-gradient(160deg, ${crate.accent}44, ${crate.color})`,
                  boxShadow: `0 10px 30px -12px ${crate.accent}`,
                }}
              >
                {'\u{1F381}'}
              </div>

              <div className="text-center">
                <div className="text-sm font-semibold">{crate.name}</div>
                <div className="text-[11px] text-white/40">
                  {crate.ready
                    ? 'Ready to open'
                    : crate.unlocking
                      ? formatDuration(crate.remaining)
                      : `Unlocks in ${formatDuration(crate.unlockMs)}`}
                </div>
              </div>

              {crate.ready ? (
                <button
                  type="button"
                  className="btn-primary w-full"
                  disabled={busy === crate.id}
                  onClick={() => void act(crate.id, 'open')}
                >
                  {busy === crate.id ? 'Opening…' : 'Open'}
                </button>
              ) : crate.unlocking ? (
                <button
                  type="button"
                  className="btn-ghost w-full text-xs"
                  disabled={busy === crate.id}
                  onClick={() => void act(crate.id, 'speed-up')}
                >
                  Skip for {formatCoins(crate.speedUpCost)}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary w-full"
                  disabled={busy === crate.id}
                  onClick={() => void act(crate.id, 'unlock')}
                >
                  Start unlock
                </button>
              )}
            </article>
          );
        })}
      </section>

      {/* Published odds */}
      <section className="grid gap-3 md:grid-cols-3">
        {(data?.types ?? []).map((type) => (
          <div key={type.id} className="panel p-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: type.accent }} aria-hidden />
              <h3 className="font-display text-base font-semibold">{type.name}</h3>
            </div>
            <p className="mb-3 text-xs leading-snug text-white/45">{type.description}</p>

            <dl className="space-y-1 text-[11px]">
              {type.dropRates.map((rate) => (
                <div key={rate.rarity} className="flex items-center justify-between">
                  <dt style={{ color: RARITY[rate.rarity].color }}>{RARITY[rate.rarity].name}</dt>
                  <dd className="tabular-nums text-white/60">{rate.percent}%</dd>
                </div>
              ))}
            </dl>

            <p className="mt-3 border-t border-white/8 pt-2 text-[10px] text-white/35">
              {type.itemDrops} items · {RARITY[type.guaranteed].name} guaranteed ·{' '}
              {formatDuration(type.unlockMs)} wait · +{type.xp} XP
            </p>
          </div>
        ))}
      </section>

      {opened && <RewardReveal result={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}

/** Reveals drops one at a time, best last. */
function RewardReveal({ result, onClose }: { result: OpenResult; onClose(): void }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= result.drops.length) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), 550);
    return () => window.clearTimeout(id);
  }, [shown, result.drops.length]);

  const allShown = shown >= result.drops.length;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-lg animate-pop-in p-6 text-center">
        <h2 className="font-display text-2xl font-bold">Crate opened</h2>
        <p className="mt-1 text-sm text-white/50">
          +{formatCoins(result.coins)} coins · +{result.xp} XP
          {result.levelUp ? ` · reached level ${result.levelUp}` : ''}
        </p>

        <div className="my-6 flex flex-wrap justify-center gap-3">
          {result.drops.slice(0, shown).map((drop, index) => (
            <div
              key={`${drop.item.id}-${index}`}
              className={`rarity-${drop.item.rarity} rarity-card animate-pop-in flex w-32 flex-col items-center gap-2 rounded-xl border p-3`}
            >
              <ItemPreview item={drop.item} size={72} />
              <div className="text-xs font-semibold">{drop.item.name}</div>
              <div
                className="text-[10px] uppercase tracking-wider"
                style={{ color: RARITY[drop.item.rarity].color }}
              >
                {RARITY[drop.item.rarity].name}
              </div>
              {drop.duplicate && (
                <div className="text-[10px] text-white/45">
                  Duplicate · +{formatCoins(drop.coins)} coins
                </div>
              )}
            </div>
          ))}

          {!allShown && (
            <div className="grid h-[152px] w-32 place-items-center rounded-xl border border-dashed border-white/15">
              <span className="animate-coin-flip text-3xl">{'\u{1FA99}'}</span>
            </div>
          )}
        </div>

        <button type="button" className="btn-primary w-full" onClick={onClose} disabled={!allShown}>
          {allShown ? 'Collect' : 'Revealing…'}
        </button>
      </div>
    </div>
  );
}
