'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The store.
 *
 * Every card states exactly what it contains and what it costs before the
 * player touches anything, and the page says plainly that none of it is
 * redeemable for money or affects a match. The buy flow is two server calls —
 * checkout, then confirm — and nothing is granted until the second one comes
 * back verified.
 */
interface Product {
  id: string;
  kind: string;
  name: string;
  description: string;
  grants: {
    coins?: number;
    gems?: number;
    crates?: string[];
    items?: string[];
    entitlement?: { kind: string; days?: number | null };
  };
  priceMinor: number;
  compareMinor: number | null;
  currency: string;
  badge: string | null;
  periodDays: number | null;
  owned: number;
  soldOut: boolean;
}

interface StoreResponse {
  products: Product[];
  currency: string;
  providers: string[];
  balances: { coins: number; gems: number };
  notice: string;
}

const SECTIONS: Array<[string, string, string]> = [
  ['bundle', 'Bundles', 'Everything at once, for less than the parts.'],
  ['pass', 'Season', 'The Carrom Pass for this season.'],
  ['subscription', 'Membership', 'Ongoing benefits, cancel any time.'],
  ['ad_free', 'No ads', 'One payment, ads gone.'],
  ['coin_pack', 'Coins', 'Virtual coins for the tables.'],
  ['gem_pack', 'Gems', 'Premium currency for cosmetics.'],
];

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(minor / 100);
}

export default function StorePage() {
  const { refresh } = useSession();
  const [data, setData] = useState<StoreResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [promo, setPromo] = useState('');

  const load = useCallback(async () => {
    const response = await api<StoreResponse>('/store').catch(() => null);
    if (response) setData(response);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Buy.
   *
   * With a real payment provider the middle of this is the platform's own
   * sheet, and what comes back is a receipt. In a sandbox build there is no
   * sheet, so we send a sandbox receipt straight through — the server still
   * verifies it, and refuses outright in production.
   */
  const buy = async (product: Product) => {
    setBusy(product.id);
    setMessage(null);
    try {
      const checkout = await api<{
        purchaseId: string;
        provider: string;
        sku: string | null;
        priceMinor: number;
        currency: string;
      }>('/store/checkout', { method: 'POST', body: { productId: product.id, platform: 'web' } });

      if (checkout.provider === 'stripe') {
        setMessage({
          tone: 'bad',
          text: 'Card payments are not connected in this build yet.',
        });
        return;
      }

      const confirmed = await api<{ status: string; alreadyGranted?: boolean }>('/store/confirm', {
        method: 'POST',
        body: {
          purchaseId: checkout.purchaseId,
          receipt: `sandbox:${checkout.purchaseId}`,
        },
      });

      if (confirmed.status === 'granted') {
        setMessage({ tone: 'ok', text: `${product.name} added to your account.` });
        await Promise.all([load(), refresh()]);
      }
    } catch (err) {
      setMessage({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : 'That did not go through.',
      });
    } finally {
      setBusy(null);
    }
  };

  const redeem = async () => {
    if (!promo.trim()) return;
    setBusy('promo');
    setMessage(null);
    try {
      const result = await api<{ description: string }>('/promos/redeem', {
        method: 'POST',
        body: { code: promo.trim() },
      });
      setMessage({ tone: 'ok', text: result.description || 'Code redeemed.' });
      setPromo('');
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setMessage({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : 'That code did not work.',
      });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    try {
      const result = await api<{ message: string }>('/store/restore', { method: 'POST' });
      setMessage({ tone: 'ok', text: result.message });
      await load();
    } catch {
      setMessage({ tone: 'bad', text: 'Could not restore right now.' });
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <p className="py-16 text-center text-sm text-white/40">Loading the store…</p>;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Store</h1>
          <p className="max-w-xl text-sm text-white/45">{data.notice}</p>
        </div>

        <div className="flex items-center gap-2">
          <Balance label="Coins" value={formatCoins(data.balances.coins)} color="#f2c94c" />
          <Balance label="Gems" value={String(data.balances.gems)} color="#a78bfa" />
        </div>
      </header>

      {message && (
        <p
          className={`animate-fade-up rounded-xl border px-4 py-2.5 text-sm ${
            message.tone === 'ok'
              ? 'border-felt-500/40 bg-felt-500/10 text-felt-400'
              : 'border-red-500/30 bg-red-500/10 text-red-200'
          }`}
        >
          {message.text}
        </p>
      )}

      {SECTIONS.map(([kind, title, blurb]) => {
        const products = data.products.filter((p) => p.kind === kind);
        if (products.length === 0) return null;

        return (
          <section key={kind}>
            <h2 className="font-display text-lg font-semibold">{title}</h2>
            <p className="mb-3 text-xs text-white/40">{blurb}</p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  currency={data.currency}
                  busy={busy === product.id}
                  onBuy={() => void buy(product)}
                />
              ))}
            </div>
          </section>
        );
      })}

      <section className="panel p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Have a code?</h2>
        <p className="mb-3 text-xs text-white/45">
          Promo codes from events and giveaways.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={promo}
            onChange={(e) => setPromo(e.target.value.toUpperCase())}
            placeholder="CARROM2026"
            maxLength={32}
            className="field max-w-xs flex-1 uppercase"
            aria-label="Promo code"
          />
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={busy === 'promo' || promo.trim().length < 3}
            onClick={() => void redeem()}
          >
            Redeem
          </button>
          <button
            type="button"
            className="btn-ghost text-sm"
            disabled={busy === 'restore'}
            onClick={() => void restore()}
          >
            Restore purchases
          </button>
        </div>
      </section>

      <p className="pb-4 text-center text-[11px] leading-relaxed text-white/30">
        Coins and gems are virtual items with no cash value. They cannot be exchanged for money,
        withdrawn, or transferred. Nothing in this store affects the outcome of a match.
      </p>
    </div>
  );
}

function Balance({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      className="rounded-xl border px-3 py-1.5"
      style={{ borderColor: `${color}44`, background: `${color}14` }}
    >
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-sm font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function ProductCard({
  product,
  currency,
  busy,
  onBuy,
}: {
  product: Product;
  currency: string;
  busy: boolean;
  onBuy(): void;
}) {
  const contents: string[] = [];
  if (product.grants.coins) contents.push(`${formatCoins(product.grants.coins)} coins`);
  if (product.grants.gems) contents.push(`${product.grants.gems} gems`);
  if (product.grants.crates?.length) {
    contents.push(`${product.grants.crates.length} crate${product.grants.crates.length > 1 ? 's' : ''}`);
  }
  if (product.grants.entitlement) {
    const days = product.grants.entitlement.days;
    const name =
      product.grants.entitlement.kind === 'ad_free'
        ? 'No ads'
        : product.grants.entitlement.kind === 'pass_premium'
          ? 'Premium pass track'
          : 'Membership';
    contents.push(days ? `${name} for ${days} days` : `${name}, permanent`);
  }

  const discount =
    product.compareMinor && product.compareMinor > product.priceMinor
      ? Math.round((1 - product.priceMinor / product.compareMinor) * 100)
      : null;

  return (
    <article className="panel flex flex-col p-4">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-tight">{product.name}</h3>
        {product.badge && (
          <span className="shrink-0 rounded-full bg-brass-400/15 px-2 py-0.5 text-[10px] font-bold uppercase text-brass-400">
            {product.badge}
          </span>
        )}
      </div>

      <p className="mb-3 flex-1 text-xs leading-relaxed text-white/50">{product.description}</p>

      {contents.length > 0 && (
        <ul className="mb-3 space-y-1">
          {contents.map((line) => (
            <li key={line} className="flex items-center gap-1.5 text-xs text-white/70">
              <span className="text-felt-400">•</span>
              {line}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold">{money(product.priceMinor, currency)}</span>
            {product.compareMinor && (
              <span className="text-xs text-white/30 line-through">
                {money(product.compareMinor, currency)}
              </span>
            )}
          </div>
          {discount && <div className="text-[10px] font-bold text-felt-400">Save {discount}%</div>}
          {product.periodDays && (
            <div className="text-[10px] text-white/35">every {product.periodDays} days</div>
          )}
        </div>

        <button
          type="button"
          className={product.soldOut ? 'btn-ghost text-sm' : 'btn-primary text-sm'}
          disabled={busy || product.soldOut}
          onClick={onBuy}
        >
          {product.soldOut ? 'Owned' : busy ? '…' : 'Buy'}
        </button>
      </div>
    </article>
  );
}
