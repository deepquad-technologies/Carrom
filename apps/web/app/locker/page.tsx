'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { RARITY, RARITY_ORDER, type BoardTheme, type CosmeticItem, type Rarity } from '@carrom/content';
import { ApiError, api } from '@/lib/api';
import { BoardPreview, ItemPreview } from '@/components/SkinPreview';
import { useSession } from '@/lib/session';

type Owned<T> = T & { owned: boolean; favorite: boolean; duplicates: number };

interface LockerPayload {
  strikers: Owned<CosmeticItem>[];
  coinSets: Owned<CosmeticItem>[];
  boards: Owned<BoardTheme>[];
  equipped: { striker: string; coinSet: string; board: string };
  fragments: Record<Rarity, number>;
  counts: { strikers: number; coinSets: number; boards: number; total: number; owned: number };
  level: number;
  coins: number;
}

type Tab = 'strikers' | 'coinSets' | 'boards';

export default function LockerPage() {
  const { setBalance } = useSession();
  const [data, setData] = useState<LockerPayload | null>(null);
  const [tab, setTab] = useState<Tab>('strikers');
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api<LockerPayload>('/inventory').then(setData).catch(() => undefined);

  useEffect(() => {
    void load();
  }, []);

  const equip = async (itemId: string) => {
    setBusy(itemId);
    try {
      await api('/inventory/equip', { method: 'POST', body: { itemId } });
      await load();
      setNotice('Equipped');
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not equip that');
    } finally {
      setBusy(null);
    }
  };

  const buy = async (itemId: string) => {
    setBusy(itemId);
    try {
      const result = await api<{ balance: number; name: string }>('/inventory/buy', {
        method: 'POST',
        body: { itemId },
      });
      setBalance(result.balance);
      await load();
      setNotice(`${result.name} unlocked`);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not buy that');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(id);
  }, [notice]);

  const items = useMemo(() => {
    if (!data) return [];
    const source =
      tab === 'strikers' ? data.strikers : tab === 'coinSets' ? data.coinSets : data.boards;
    return source.filter((item) => {
      if (rarity !== 'all' && item.rarity !== rarity) return false;
      if (ownedOnly && !item.owned) return false;
      if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, tab, rarity, ownedOnly, search]);

  const equippedId = data
    ? tab === 'strikers'
      ? data.equipped.striker
      : tab === 'coinSets'
        ? data.equipped.coinSet
        : data.equipped.board
    : '';

  return (
    <div className="animate-fade-up space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Locker</h1>
          <p className="text-sm text-white/45">
            {data ? `${data.counts.owned} of ${data.counts.total} collected` : 'Loading…'}
          </p>
        </div>
        {data && (
          <div className="flex gap-2">
            {RARITY_ORDER.map((r) => (
              <span
                key={r}
                className="chip py-0.5 text-[10px]"
                style={{ color: RARITY[r].color, borderColor: `${RARITY[r].color}44` }}
                title={`${RARITY[r].name} fragments`}
              >
                {data.fragments[r] ?? 0}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="panel space-y-3 p-4">
        <div className="flex gap-2">
          {(
            [
              ['strikers', 'Strikers', data?.counts.strikers],
              ['coinSets', 'Coin sets', data?.counts.coinSets],
              ['boards', 'Boards', data?.counts.boards],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                tab === id ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
              }`}
            >
              {label}
              {count ? <span className="ml-1.5 text-[11px] text-white/35">{count}</span> : null}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field max-w-[200px] py-2 text-xs"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className={`chip ${rarity === 'all' ? 'border-white/40 text-white' : ''}`}
            onClick={() => setRarity('all')}
          >
            All
          </button>
          {RARITY_ORDER.map((r) => (
            <button
              key={r}
              type="button"
              className="chip"
              style={
                rarity === r
                  ? { color: RARITY[r].color, borderColor: RARITY[r].color }
                  : { color: `${RARITY[r].color}99` }
              }
              onClick={() => setRarity(r)}
            >
              {RARITY[r].name}
            </button>
          ))}
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-white/55">
            <input
              type="checkbox"
              className="accent-brass-400"
              checked={ownedOnly}
              onChange={(e) => setOwnedOnly(e.target.checked)}
            />
            Owned only
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => {
          const isEquipped = item.id === equippedId;
          const price = 'unlock' in item && item.unlock.kind === 'shop' ? item.unlock.coins : undefined;
          const canBuy = !item.owned && price !== undefined && (data?.coins ?? 0) >= price;

          return (
            <article
              key={item.id}
              className={`rarity-${item.rarity} rarity-card panel flex flex-col items-center gap-2 p-3 transition ${
                item.owned ? '' : 'opacity-70'
              } ${isEquipped ? 'ring-1 ring-brass-400/60' : ''}`}
            >
              <div className={item.owned ? '' : 'grayscale'}>
                {tab === 'boards' ? (
                  <BoardPreview theme={item as BoardTheme} size={110} />
                ) : (
                  <ItemPreview item={item as CosmeticItem} size={92} animate={item.owned} />
                )}
              </div>

              <div className="w-full text-center">
                <div className="truncate text-sm font-semibold">{item.name}</div>
                <div className="text-[10px] uppercase tracking-wider" style={{ color: RARITY[item.rarity].color }}>
                  {RARITY[item.rarity].name}
                  {item.duplicates > 0 ? ` · ${item.duplicates} dup` : ''}
                </div>
              </div>

              {isEquipped ? (
                <span className="chip w-full justify-center border-brass-400/40 text-brass-400">
                  Equipped
                </span>
              ) : item.owned ? (
                <button
                  type="button"
                  className="btn-ghost w-full py-1.5 text-xs"
                  disabled={busy === item.id}
                  onClick={() => void equip(item.id)}
                >
                  {busy === item.id ? '…' : 'Equip'}
                </button>
              ) : price !== undefined ? (
                <button
                  type="button"
                  className="btn-primary w-full py-1.5 text-xs"
                  disabled={!canBuy || busy === item.id}
                  onClick={() => void buy(item.id)}
                >
                  {busy === item.id ? '…' : `${formatCoins(price)} coins`}
                </button>
              ) : (
                <span className="w-full text-center text-[10px] leading-tight text-white/35">
                  {unlockHint(item)}
                </span>
              )}
            </article>
          );
        })}
      </div>

      {items.length === 0 && data && (
        <p className="py-10 text-center text-sm text-white/40">Nothing matches those filters.</p>
      )}

      {notice && (
        <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 animate-pop-in rounded-xl border border-white/12 bg-ink-900/95 px-4 py-2.5 text-sm shadow-card backdrop-blur md:bottom-6">
          {notice}
        </div>
      )}
    </div>
  );
}

function unlockHint(item: { unlock: { kind: string; level?: number; tierId?: string; achievementId?: string } }): string {
  switch (item.unlock.kind) {
    case 'level':
      return `Reach level ${item.unlock.level}`;
    case 'tier':
      return `Play the ${item.unlock.tierId} room`;
    case 'achievement':
      return 'Earn an achievement';
    case 'crate':
      return 'Found in crates';
    default:
      return 'Locked';
  }
}
