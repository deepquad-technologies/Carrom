'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface Item {
  id: string;
  name: string;
  category: string;
  rarity: string;
  unlock_kind: string;
  price_coins: number | null;
  enabled: boolean;
  droppable: boolean;
  owners: string;
}

/**
 * Item visuals live in code (@carrom/content). These switches control runtime
 * availability, drop eligibility and shop price without a deploy.
 */
export default function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ items: Item[] }>('/admin/items');
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    try {
      await adminApi(`/admin/items/${id}`, { method: 'PATCH', body });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  };

  const shown = category === 'all' ? items : items.filter((item) => item.category === category);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Items</h1>
        <span className="text-sm text-white/40">{shown.length} shown</span>

        <div className="ml-auto flex gap-1">
          {['all', 'striker', 'coin_set', 'board'].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setCategory(option)}
              className={`rounded-lg px-3 py-1.5 text-xs capitalize ${
                category === option ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5'
              }`}
            >
              {option.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-white/8">
            <tr>
              <th className="th">Item</th>
              <th className="th">Category</th>
              <th className="th">Rarity</th>
              <th className="th">Unlock</th>
              <th className="th">Owners</th>
              <th className="th">Enabled</th>
              <th className="th">Droppable</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {shown.map((item) => (
              <tr key={item.id} className="hover:bg-white/[0.03]">
                <td className="td font-medium">{item.name}</td>
                <td className="td capitalize text-white/55">{item.category.replace('_', ' ')}</td>
                <td className="td capitalize text-white/55">{item.rarity}</td>
                <td className="td text-white/55">
                  {item.unlock_kind}
                  {item.price_coins ? ` · ${Number(item.price_coins).toLocaleString()}` : ''}
                </td>
                <td className="td tabular-nums text-white/45">{item.owners}</td>
                <td className="td">
                  <input
                    type="checkbox"
                    className="accent-brass-400"
                    checked={item.enabled}
                    disabled={busy === item.id}
                    onChange={(e) => void patch(item.id, { enabled: e.target.checked })}
                  />
                </td>
                <td className="td">
                  <input
                    type="checkbox"
                    className="accent-brass-400"
                    checked={item.droppable}
                    disabled={busy === item.id}
                    onChange={(e) => void patch(item.id, { droppable: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
