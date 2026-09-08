'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';
import { BarChart, LineChart } from '@/components/Chart';

/**
 * Revenue.
 *
 * Net rather than gross at the top, because refunds are money that left again.
 * Conversion and ARPPU sit beside it, since a revenue number without them says
 * nothing about whether the game is healthy or just has one very generous
 * player.
 */
interface Monetization {
  days: number;
  currency: string;
  totals: {
    grossMinor: number;
    refundedMinor: number;
    netMinor: number;
    orders: number;
    payers: number;
    players: number;
    failed: number;
    conversion: number;
    arppuMinor: number;
  };
  daily: Array<{ day: string; grossMinor: number; orders: number }>;
  byProduct: Array<{ productId: string; name: string; kind: string; orders: number; grossMinor: number }>;
  byProvider: Array<{ provider: string; orders: number; grossMinor: number }>;
  entitlements: Array<{ kind: string; live: number }>;
  subscriptions: { active: number; cancelling: number };
  ads: { impressions: number; clicks: number; rewarded: number; revenueMinor: number };
  failures: Array<{ reason: string; count: number }>;
}

interface Purchase {
  id: string;
  username: string;
  product_name: string;
  status: string;
  provider: string;
  price_minor: number;
  currency: string;
  failure_reason: string | null;
  created_at: string;
}

interface Audit {
  ok: boolean;
  mismatches: Array<{ username: string; balance: number; ledger: number; difference: number }>;
}

const RANGES: Array<[number, string]> = [
  [7, '7d'],
  [30, '30d'],
  [90, '90d'],
  [365, '1y'],
];

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

export default function MonetizationPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Monetization | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [report, orders, gemAudit] = await Promise.all([
        adminApi<Monetization>(`/admin/monetization?days=${days}`),
        adminApi<{ purchases: Purchase[] }>('/admin/monetization/purchases?limit=25'),
        adminApi<Audit>('/admin/monetization/gem-audit'),
      ]);
      setData(report);
      setPurchases(orders.purchases);
      setAudit(gemAudit);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const refund = async (purchase: Purchase) => {
    const reason = window.prompt(
      `Refund ${purchase.product_name} for ${purchase.username}? Give a reason:`,
    );
    if (!reason) return;
    try {
      const result = await adminApi<{ clawedBack: boolean }>('/admin/store/refund', {
        method: 'POST',
        body: { purchaseId: purchase.id, reason, clawBack: true },
      });
      window.alert(
        result.clawedBack
          ? 'Refunded and the currency was taken back.'
          : 'Refunded. The currency was already spent, so it was not clawed back.',
      );
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Refund failed');
    }
  };

  if (error) return <p className="text-sm text-red-300">{error}</p>;
  if (!data) return <p className="text-sm text-white/40">Loading…</p>;

  const currency = data.currency;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Monetization</h1>
        <div className="ml-auto flex gap-1">
          {RANGES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDays(value)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                days === value ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {audit && !audit.ok && (
        <div className="panel border-red-500/40 bg-red-500/10 p-4">
          <h2 className="text-sm font-bold text-red-200">Gem ledger does not balance</h2>
          <p className="mt-1 text-xs text-red-200/70">
            {audit.mismatches.length} account(s) where the balance and the ledger disagree. This is a
            bug, not a report — investigate before granting anything else.
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {audit.mismatches.slice(0, 5).map((row) => (
              <li key={row.username} className="tabular-nums text-red-100">
                {row.username}: balance {row.balance}, ledger {row.ledger} (
                {row.difference > 0 ? '+' : ''}
                {row.difference})
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Net revenue" value={money(data.totals.netMinor, currency)} />
        <Stat label="Gross" value={money(data.totals.grossMinor, currency)} sub={`less ${money(data.totals.refundedMinor, currency)} refunded`} />
        <Stat label="Paying players" value={String(data.totals.payers)} sub={`${(data.totals.conversion * 100).toFixed(2)}% of players`} />
        <Stat label="ARPPU" value={money(data.totals.arppuMinor, currency)} sub={`${data.totals.orders} orders`} />
      </div>

      <section className="panel p-5">
        <h2 className="mb-3 font-semibold">Revenue over time</h2>
        <LineChart
          series={[
            {
              name: 'Gross',
              color: '#4dd6a0',
              points: data.daily.map((row) => ({
                label: row.day.slice(5),
                value: row.grossMinor / 100,
              })),
            },
          ]}
          format={(n) => money(n * 100, currency)}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Best sellers</h2>
          <BarChart
            points={data.byProduct.slice(0, 8).map((row) => ({
              label: row.name,
              value: row.grossMinor / 100,
            }))}
            format={(n) => money(n * 100, currency)}
          />
        </section>

        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Live entitlements</h2>
          <BarChart
            points={data.entitlements.map((row) => ({ label: row.kind, value: row.live }))}
            color="#a78bfa"
          />
          <p className="mt-3 text-xs text-white/45">
            {data.subscriptions.active} active subscriptions
            {data.subscriptions.cancelling > 0
              ? `, ${data.subscriptions.cancelling} cancelling at period end`
              : ''}
            .
          </p>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Advertising</h2>
          <dl className="grid grid-cols-2 gap-3">
            <Mini label="Impressions" value={data.ads.impressions.toLocaleString()} />
            <Mini
              label="Click rate"
              value={
                data.ads.impressions > 0
                  ? `${((data.ads.clicks / data.ads.impressions) * 100).toFixed(2)}%`
                  : '—'
              }
            />
            <Mini label="Rewarded views" value={data.ads.rewarded.toLocaleString()} />
            <Mini label="Booked spend" value={money(data.ads.revenueMinor, currency)} />
          </dl>
        </section>

        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Failed purchases</h2>
          {data.failures.length === 0 ? (
            <p className="py-4 text-center text-xs text-white/35">No failures. Good.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.failures.map((row) => (
                <li key={row.reason} className="flex justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-white/70">{row.reason}</span>
                  <span className="tabular-nums text-white/50">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel overflow-hidden">
        <h2 className="border-b border-white/8 px-5 py-3 font-semibold">Recent orders</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Player</th>
                <th className="th">Product</th>
                <th className="th">Amount</th>
                <th className="th">Status</th>
                <th className="th">When</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {purchases.map((purchase) => (
                <tr key={purchase.id} className="border-t border-white/6">
                  <td className="td">{purchase.username}</td>
                  <td className="td">{purchase.product_name ?? '—'}</td>
                  <td className="td tabular-nums">
                    {money(purchase.price_minor, purchase.currency)}
                    <span className="ml-1 text-[10px] text-white/30">{purchase.provider}</span>
                  </td>
                  <td className="td">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                        purchase.status === 'granted'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : purchase.status === 'refunded'
                            ? 'bg-amber-500/15 text-amber-300'
                            : purchase.status === 'failed'
                              ? 'bg-red-500/15 text-red-300'
                              : 'bg-white/8 text-white/50'
                      }`}
                      title={purchase.failure_reason ?? undefined}
                    >
                      {purchase.status}
                    </span>
                  </td>
                  <td className="td text-white/45">
                    {new Date(purchase.created_at).toLocaleString()}
                  </td>
                  <td className="td text-right">
                    {purchase.status === 'granted' && (
                      <button
                        type="button"
                        className="btn-danger px-2.5 py-1 text-xs"
                        onClick={() => void refund(purchase)}
                      >
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-4">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-white/35">{sub}</div>}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="text-sm font-bold tabular-nums">{value}</dd>
    </div>
  );
}
