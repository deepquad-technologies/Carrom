'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

/**
 * Advertisers and campaigns.
 *
 * A creative is four fields and two colours, not an uploaded asset — the ads
 * are drawn by the client, so booking one is a form rather than a file
 * handover, and nothing an advertiser supplies can run code in the game.
 */
interface Advertiser {
  id: string;
  name: string;
  contact_email: string | null;
  status: string;
  campaigns: string;
}

interface Campaign {
  id: string;
  advertiser_id: string;
  advertiser_name: string;
  name: string;
  status: string;
  placement: string;
  budget_minor: string;
  spent_minor: string;
  cpm_minor: number;
  currency: string;
  daily_cap: number;
  impressions: string;
  clicks: string;
  creatives: string;
}

interface Creative {
  id: string;
  headline: string;
  body: string;
  cta: string;
  accent: string;
  background: string;
  active: boolean;
}

const PLACEMENTS = ['banner', 'interstitial', 'rewarded', 'sponsored'] as const;

export default function AdvertisersPage() {
  const [advertisers, setAdvertisers] = useState<Advertiser[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [advertiserForm, setAdvertiserForm] = useState({ name: '', contactEmail: '' });
  const [campaignForm, setCampaignForm] = useState({
    advertiserId: '',
    name: '',
    placement: 'banner' as (typeof PLACEMENTS)[number],
    budgetMinor: 0,
    cpmMinor: 0,
    dailyCap: 6,
  });
  const [creativeForm, setCreativeForm] = useState({
    headline: '',
    body: '',
    cta: 'Learn more',
    clickUrl: '',
    accent: '#f2c94c',
  });

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        adminApi<{ advertisers: Advertiser[] }>('/admin/ads/advertisers'),
        adminApi<{ campaigns: Campaign[] }>('/admin/ads/campaigns'),
      ]);
      setAdvertisers(a.advertisers);
      setCampaigns(c.campaigns);
      if (!campaignForm.advertiserId && a.advertisers[0]) {
        setCampaignForm((prev) => ({ ...prev, advertiserId: a.advertisers[0]!.id }));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [campaignForm.advertiserId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) {
      setCreatives([]);
      return;
    }
    void adminApi<{ creatives: Creative[] }>(`/admin/ads/campaigns/${selected}/creatives`)
      .then((d) => setCreatives(d.creatives))
      .catch(() => setCreatives([]));
  }, [selected]);

  const saveAdvertiser = async () => {
    if (advertiserForm.name.length < 2) return;
    await adminApi('/admin/ads/advertisers', {
      method: 'POST',
      body: {
        name: advertiserForm.name,
        contactEmail: advertiserForm.contactEmail || null,
      },
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed'));
    setAdvertiserForm({ name: '', contactEmail: '' });
    await load();
  };

  const saveCampaign = async () => {
    if (!campaignForm.advertiserId || campaignForm.name.length < 2) return;
    await adminApi('/admin/ads/campaigns', {
      method: 'POST',
      body: { ...campaignForm, status: 'running' },
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed'));
    setCampaignForm((prev) => ({ ...prev, name: '' }));
    await load();
  };

  const saveCreative = async () => {
    if (!selected || creativeForm.headline.length < 2) return;
    await adminApi('/admin/ads/creatives', {
      method: 'POST',
      body: {
        campaignId: selected,
        headline: creativeForm.headline,
        body: creativeForm.body,
        cta: creativeForm.cta,
        clickUrl: creativeForm.clickUrl || null,
        accent: creativeForm.accent,
      },
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed'));
    setCreativeForm((prev) => ({ ...prev, headline: '', body: '' }));
    const refreshed = await adminApi<{ creatives: Creative[] }>(
      `/admin/ads/campaigns/${selected}/creatives`,
    ).catch(() => ({ creatives: [] }));
    setCreatives(refreshed.creatives);
  };

  const setStatus = async (campaign: Campaign, status: string) => {
    await adminApi('/admin/ads/campaigns', {
      method: 'POST',
      body: {
        id: campaign.id,
        advertiserId: campaign.advertiser_id,
        name: campaign.name,
        placement: campaign.placement,
        status,
        budgetMinor: Number(campaign.budget_minor),
        cpmMinor: campaign.cpm_minor,
        dailyCap: campaign.daily_cap,
      },
    }).catch((err) => setError(err instanceof Error ? err.message : 'Failed'));
    await load();
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Advertisers</h1>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Add an advertiser</h2>
          <div className="space-y-2">
            <input
              className="field"
              placeholder="Company name"
              value={advertiserForm.name}
              onChange={(e) => setAdvertiserForm({ ...advertiserForm, name: e.target.value })}
            />
            <input
              className="field"
              type="email"
              placeholder="Contact email (optional)"
              value={advertiserForm.contactEmail}
              onChange={(e) =>
                setAdvertiserForm({ ...advertiserForm, contactEmail: e.target.value })
              }
            />
            <button type="button" className="btn-primary text-sm" onClick={() => void saveAdvertiser()}>
              Save advertiser
            </button>
          </div>

          <ul className="mt-4 space-y-1.5">
            {advertisers.map((advertiser) => (
              <li
                key={advertiser.id}
                className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{advertiser.name}</span>
                <span className="text-[11px] text-white/40">
                  {advertiser.campaigns} campaign(s) · {advertiser.status}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Book a campaign</h2>
          <div className="space-y-2">
            <select
              className="field"
              value={campaignForm.advertiserId}
              onChange={(e) => setCampaignForm({ ...campaignForm, advertiserId: e.target.value })}
            >
              <option value="">Choose an advertiser…</option>
              {advertisers.map((advertiser) => (
                <option key={advertiser.id} value={advertiser.id}>
                  {advertiser.name}
                </option>
              ))}
            </select>

            <input
              className="field"
              placeholder="Campaign name"
              value={campaignForm.name}
              onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })}
            />

            <div className="grid grid-cols-2 gap-2">
              <select
                className="field"
                value={campaignForm.placement}
                onChange={(e) =>
                  setCampaignForm({
                    ...campaignForm,
                    placement: e.target.value as (typeof PLACEMENTS)[number],
                  })
                }
              >
                {PLACEMENTS.map((placement) => (
                  <option key={placement} value={placement}>
                    {placement}
                  </option>
                ))}
              </select>

              <input
                className="field"
                type="number"
                min={1}
                max={100}
                placeholder="Daily cap per player"
                value={campaignForm.dailyCap}
                onChange={(e) =>
                  setCampaignForm({ ...campaignForm, dailyCap: Number(e.target.value) })
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-white/40">
                  Budget (paise)
                </span>
                <input
                  className="field"
                  type="number"
                  min={0}
                  value={campaignForm.budgetMinor}
                  onChange={(e) =>
                    setCampaignForm({ ...campaignForm, budgetMinor: Number(e.target.value) })
                  }
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-white/40">
                  CPM (paise)
                </span>
                <input
                  className="field"
                  type="number"
                  min={0}
                  value={campaignForm.cpmMinor}
                  onChange={(e) =>
                    setCampaignForm({ ...campaignForm, cpmMinor: Number(e.target.value) })
                  }
                />
              </label>
            </div>

            <button type="button" className="btn-primary text-sm" onClick={() => void saveCampaign()}>
              Start campaign
            </button>
          </div>
        </section>
      </div>

      <section className="panel overflow-hidden">
        <h2 className="border-b border-white/8 px-5 py-3 font-semibold">Campaigns</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Campaign</th>
                <th className="th">Placement</th>
                <th className="th">Delivered</th>
                <th className="th">CTR</th>
                <th className="th">Spend</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => {
                const impressions = Number(campaign.impressions);
                const clicks = Number(campaign.clicks);
                return (
                  <tr
                    key={campaign.id}
                    className={`cursor-pointer border-t border-white/6 transition hover:bg-white/[0.03] ${
                      selected === campaign.id ? 'bg-white/[0.05]' : ''
                    }`}
                    onClick={() => setSelected(campaign.id === selected ? null : campaign.id)}
                  >
                    <td className="td">
                      <div className="font-medium">{campaign.name}</div>
                      <div className="text-[11px] text-white/40">{campaign.advertiser_name}</div>
                    </td>
                    <td className="td capitalize">{campaign.placement}</td>
                    <td className="td tabular-nums">{impressions.toLocaleString()}</td>
                    <td className="td tabular-nums">
                      {impressions > 0 ? `${((clicks / impressions) * 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className="td tabular-nums">
                      {(Number(campaign.spent_minor) / 100).toFixed(0)} /{' '}
                      {Number(campaign.budget_minor) === 0
                        ? '∞'
                        : (Number(campaign.budget_minor) / 100).toFixed(0)}
                    </td>
                    <td className="td">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                          campaign.status === 'running'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-white/8 text-white/50'
                        }`}
                      >
                        {campaign.status}
                      </span>
                    </td>
                    <td className="td text-right">
                      <button
                        type="button"
                        className="btn-ghost px-2.5 py-1 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          void setStatus(campaign, campaign.status === 'running' ? 'paused' : 'running');
                        }}
                      >
                        {campaign.status === 'running' ? 'Pause' : 'Run'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="panel p-5">
          <h2 className="mb-3 font-semibold">Creatives</h2>

          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="field"
              placeholder="Headline"
              value={creativeForm.headline}
              onChange={(e) => setCreativeForm({ ...creativeForm, headline: e.target.value })}
            />
            <input
              className="field"
              placeholder="Body"
              value={creativeForm.body}
              onChange={(e) => setCreativeForm({ ...creativeForm, body: e.target.value })}
            />
            <input
              className="field"
              placeholder="Call to action"
              value={creativeForm.cta}
              onChange={(e) => setCreativeForm({ ...creativeForm, cta: e.target.value })}
            />
            <input
              className="field"
              placeholder="Click URL (optional)"
              value={creativeForm.clickUrl}
              onChange={(e) => setCreativeForm({ ...creativeForm, clickUrl: e.target.value })}
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={creativeForm.accent}
              onChange={(e) => setCreativeForm({ ...creativeForm, accent: e.target.value })}
              className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-white/5"
              aria-label="Accent colour"
            />
            <button type="button" className="btn-primary text-sm" onClick={() => void saveCreative()}>
              Add creative
            </button>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {creatives.map((creative) => (
              <article
                key={creative.id}
                className="rounded-xl border p-3"
                style={{ borderColor: `${creative.accent}44`, background: creative.background }}
              >
                <div className="text-sm font-semibold">{creative.headline}</div>
                <div className="text-[11px] text-white/50">{creative.body}</div>
                <span
                  className="mt-2 inline-block rounded-lg px-3 py-1 text-[11px] font-semibold"
                  style={{ background: creative.accent, color: '#07080d' }}
                >
                  {creative.cta}
                </span>
              </article>
            ))}
            {creatives.length === 0 && (
              <p className="py-4 text-xs text-white/35">
                No creatives yet. A campaign with none will never serve.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
