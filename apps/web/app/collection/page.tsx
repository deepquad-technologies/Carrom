'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { RARITY, RARITY_ORDER, type Rarity } from '@carrom/content';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Collections.
 *
 * Progress is derived server-side from what a player actually owns, so the
 * percentages here cannot drift from the locker. Milestones pay once; the
 * server enforces that, and this screen only ever asks.
 */
interface Milestone {
  id: string;
  at: number;
  label: string;
  reached: boolean;
  claimed: boolean;
  coins: number;
  xp: number;
  crateKind?: string;
}

interface Collection {
  id: string;
  name: string;
  noun: string;
  icon: string;
  accent: string;
  owned: number;
  total: number;
  percent: number;
  byRarity: Record<Rarity, { owned: number; total: number }>;
  milestones: Milestone[];
  nextAt: number | null;
  itemsToNext: number;
}

interface Payload {
  collections: Collection[];
  overall: { owned: number; total: number; percent: number };
  unclaimed: number;
}

export default function CollectionPage() {
  const { setBalance, refresh } = useSession();
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    () => api<Payload>('/collections').then(setData).catch(() => undefined),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(id);
  }, [notice]);

  const claim = async (collection: Collection, milestone: Milestone) => {
    setBusy(milestone.id);
    try {
      const result = await api<{ coins: number; xp: number; balance: number; crateKind?: string }>(
        `/collections/${collection.id}/claim/${milestone.at}`,
        { method: 'POST' },
      );
      setBalance(result.balance);
      setNotice(
        `${collection.name}: +${formatCoins(result.coins)} coins, +${result.xp} XP` +
          (result.crateKind ? `, ${result.crateKind} crate` : ''),
      );
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not claim that');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="animate-fade-up space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Collection</h1>
          <p className="text-sm text-white/45">
            {data
              ? `${data.overall.owned} of ${data.overall.total} collected · ${data.overall.percent}%`
              : 'Loading…'}
          </p>
        </div>

        {data && data.unclaimed > 0 && (
          <span className="chip border-brass-400/50 text-brass-400">
            {data.unclaimed} reward{data.unclaimed === 1 ? '' : 's'} to claim
          </span>
        )}
      </header>

      {data && (
        <div className="panel p-5">
          <div className="mb-2 flex justify-between text-xs text-white/45">
            <span>Overall completion</span>
            <span className="tabular-nums">{data.overall.percent}%</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-gradient-to-r from-felt-500 via-brass-600 to-brass-400 transition-[width] duration-700"
              style={{ width: `${data.overall.percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {(data?.collections ?? []).map((collection) => {
          const expanded = open === collection.id;
          const claimable = collection.milestones.filter((m) => m.reached && !m.claimed);

          return (
            <section
              key={collection.id}
              className="panel overflow-hidden"
              style={{ borderColor: claimable.length ? `${collection.accent}66` : undefined }}
            >
              <button
                type="button"
                className="flex w-full items-center gap-3 p-4 text-left"
                onClick={() => setOpen(expanded ? null : collection.id)}
              >
                <span className="text-2xl">{collection.icon}</span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="font-display text-lg font-semibold">{collection.name}</h2>
                    {claimable.length > 0 && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brass-400 px-1 text-[10px] font-bold text-ink-950">
                        {claimable.length}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/45">
                    {collection.owned} / {collection.total} {collection.noun}
                    {collection.nextAt !== null && collection.itemsToNext > 0 && (
                      <span className="text-white/30">
                        {' '}
                        · {collection.itemsToNext} to {Math.round(collection.nextAt * 100)}%
                      </span>
                    )}
                  </p>
                </div>

                <div className="text-right">
                  <div
                    className="text-xl font-bold tabular-nums"
                    style={{ color: collection.accent }}
                  >
                    {collection.percent}%
                  </div>
                </div>

                <span className={`text-white/35 transition ${expanded ? 'rotate-180' : ''}`}>
                  {'▾'}
                </span>
              </button>

              <div className="px-4 pb-4">
                <div className="h-2 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full transition-[width] duration-700"
                    style={{ width: `${collection.percent}%`, background: collection.accent }}
                  />
                </div>

                {/* Milestone pips sit on the same axis as the bar. */}
                <div className="relative mt-1.5 h-4">
                  {collection.milestones.map((milestone) => (
                    <span
                      key={milestone.id}
                      title={`${Math.round(milestone.at * 100)}% — ${milestone.label}`}
                      className={`absolute top-0 h-2 w-2 -translate-x-1/2 rounded-full ${
                        milestone.claimed
                          ? 'bg-white/25'
                          : milestone.reached
                            ? 'animate-pulse-ring bg-brass-400'
                            : 'bg-white/12'
                      }`}
                      style={{ left: `${milestone.at * 100}%` }}
                    />
                  ))}
                </div>

                {expanded && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap gap-1.5">
                      {RARITY_ORDER.map((rarity) => {
                        const counts = collection.byRarity[rarity];
                        if (!counts || counts.total === 0) return null;
                        return (
                          <span
                            key={rarity}
                            className="chip py-0.5 text-[10px]"
                            style={{
                              color: RARITY[rarity].color,
                              borderColor: `${RARITY[rarity].color}44`,
                            }}
                          >
                            {RARITY[rarity].name} {counts.owned}/{counts.total}
                          </span>
                        );
                      })}
                    </div>

                    <div className="space-y-2">
                      {collection.milestones.map((milestone) => (
                        <div
                          key={milestone.id}
                          className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${
                            milestone.reached && !milestone.claimed
                              ? 'border-brass-400/40 bg-brass-400/10'
                              : 'border-white/8 bg-white/[0.03]'
                          }`}
                        >
                          <span className="w-10 text-sm font-bold tabular-nums text-white/50">
                            {Math.round(milestone.at * 100)}%
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="text-sm">{milestone.label}</div>
                            <div className="text-[11px] text-white/40">
                              {formatCoins(milestone.coins)} coins · {milestone.xp} XP
                              {milestone.crateKind ? ` · ${milestone.crateKind} crate` : ''}
                            </div>
                          </div>

                          {milestone.claimed ? (
                            <span className="chip py-0.5 text-[10px] text-felt-400">Claimed</span>
                          ) : milestone.reached ? (
                            <button
                              type="button"
                              className="btn-primary px-3 py-1.5 text-xs"
                              disabled={busy === milestone.id}
                              onClick={() => void claim(collection, milestone)}
                            >
                              {busy === milestone.id ? '…' : 'Claim'}
                            </button>
                          ) : (
                            <span className="text-[11px] text-white/30">
                              {Math.max(
                                0,
                                Math.ceil(milestone.at * collection.total) - collection.owned,
                              )}{' '}
                              to go
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {data && data.collections.length === 0 && (
        <p className="py-10 text-center text-sm text-white/40">Nothing to collect yet.</p>
      )}

      {notice && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 animate-pop-in rounded-xl border border-white/12 bg-ink-900/95 px-4 py-2.5 text-sm shadow-card backdrop-blur md:bottom-6">
          {notice}
        </div>
      )}
    </div>
  );
}
