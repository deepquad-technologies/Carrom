import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
} from 'react-native';
import { formatCoins } from '@carrom/config';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { colors, styles } from '../theme';

/**
 * The store, on a phone.
 *
 * Same two-step purchase as the web: ask the server to open an order, hand it
 * the platform receipt, and let the server decide whether anything was bought.
 * On a real build the middle step is the App Store or Play sheet; without a
 * configured provider the server falls back to a sandbox receipt it verifies
 * itself, and refuses that outright in production.
 */
interface Product {
  id: string;
  kind: string;
  name: string;
  description: string;
  grants: { coins?: number; gems?: number; crates?: string[]; entitlement?: { kind: string; days?: number | null } };
  priceMinor: number;
  compareMinor: number | null;
  currency: string;
  badge: string | null;
  owned: number;
  soldOut: boolean;
}

interface StoreResponse {
  products: Product[];
  currency: string;
  balances: { coins: number; gems: number };
  notice: string;
}

const SECTIONS: Array<[string, string]> = [
  ['bundle', 'Bundles'],
  ['pass', 'Season pass'],
  ['subscription', 'Membership'],
  ['ad_free', 'Remove ads'],
  ['coin_pack', 'Coins'],
  ['gem_pack', 'Gems'],
];

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(0)} ${currency}`;
  }
}

export default function StoreScreen() {
  const { refresh } = useSession();
  const [data, setData] = useState<StoreResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [promo, setPromo] = useState('');

  const load = useCallback(async () => {
    const response = await api<StoreResponse>('/store').catch(() => null);
    if (response) setData(response);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buy = async (product: Product) => {
    setBusy(product.id);
    setNote(null);
    try {
      const checkout = await api<{ purchaseId: string; provider: string }>('/store/checkout', {
        method: 'POST',
        body: { productId: product.id, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
      });

      // With Apple or Google configured this is where their sheet runs and
      // returns a real receipt. Anything else means a sandbox build.
      const receipt = `sandbox:${checkout.purchaseId}`;

      const confirmed = await api<{ status: string }>('/store/confirm', {
        method: 'POST',
        body: { purchaseId: checkout.purchaseId, receipt },
      });

      if (confirmed.status === 'granted') {
        setNote({ ok: true, text: `${product.name} added.` });
        await Promise.all([load(), refresh()]);
      }
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'That did not go through.' });
    } finally {
      setBusy(null);
    }
  };

  const redeem = async () => {
    if (promo.trim().length < 3) return;
    setBusy('promo');
    try {
      const result = await api<{ description: string }>('/promos/redeem', {
        method: 'POST',
        body: { code: promo.trim() },
      });
      setNote({ ok: true, text: result.description || 'Code redeemed.' });
      setPromo('');
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'That code did not work.' });
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <View style={[styles.screen, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.brass} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.brass} />
      }
    >
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={[styles.panelTight, { flex: 1, padding: 12 }]}>
          <Text style={{ color: colors.textFaint, fontSize: 10, textTransform: 'uppercase' }}>
            Coins
          </Text>
          <Text style={{ color: colors.brass, fontSize: 16, fontWeight: '800' }}>
            {formatCoins(data.balances.coins)}
          </Text>
        </View>
        <View style={[styles.panelTight, { flex: 1, padding: 12 }]}>
          <Text style={{ color: colors.textFaint, fontSize: 10, textTransform: 'uppercase' }}>
            Gems
          </Text>
          <Text style={{ color: colors.epic, fontSize: 16, fontWeight: '800' }}>
            {data.balances.gems}
          </Text>
        </View>
      </View>

      {note && (
        <View
          style={[
            styles.panelTight,
            {
              padding: 12,
              borderColor: note.ok ? colors.felt : colors.danger,
            },
          ]}
        >
          <Text style={{ color: note.ok ? colors.felt : colors.danger, fontSize: 13 }}>
            {note.text}
          </Text>
        </View>
      )}

      {SECTIONS.map(([kind, title]) => {
        const products = data.products.filter((p) => p.kind === kind);
        if (products.length === 0) return null;

        return (
          <View key={kind} style={{ gap: 8 }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>

            {products.map((product) => (
              <View key={product.id} style={styles.panel}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 }}>
                    {product.name}
                  </Text>
                  {product.badge && (
                    <Text
                      style={{
                        color: colors.brass,
                        fontSize: 10,
                        fontWeight: '800',
                        textTransform: 'uppercase',
                      }}
                    >
                      {product.badge}
                    </Text>
                  )}
                </View>

                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                  {product.description}
                </Text>

                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: 12,
                    gap: 10,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800' }}>
                      {money(product.priceMinor, product.currency)}
                    </Text>
                    {product.compareMinor && (
                      <Text
                        style={{
                          color: colors.textFaint,
                          fontSize: 11,
                          textDecorationLine: 'line-through',
                        }}
                      >
                        {money(product.compareMinor, product.currency)}
                      </Text>
                    )}
                  </View>

                  <Pressable
                    disabled={busy === product.id || product.soldOut}
                    onPress={() => void buy(product)}
                    style={{
                      backgroundColor: product.soldOut ? colors.surfaceAlt : colors.brass,
                      paddingHorizontal: 20,
                      paddingVertical: 10,
                      borderRadius: 12,
                      opacity: busy === product.id ? 0.5 : 1,
                    }}
                  >
                    <Text
                      style={{
                        color: product.soldOut ? colors.textMuted : colors.bg,
                        fontWeight: '800',
                        fontSize: 13,
                      }}
                    >
                      {product.soldOut ? 'Owned' : busy === product.id ? '…' : 'Buy'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        );
      })}

      <View style={styles.panel}>
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700' }}>Have a code?</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <TextInput
            value={promo}
            onChangeText={(value) => setPromo(value.toUpperCase())}
            placeholder="CARROM2026"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
            style={{
              flex: 1,
              backgroundColor: colors.bg,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: colors.text,
            }}
          />
          <Pressable
            onPress={() => void redeem()}
            disabled={busy === 'promo'}
            style={{
              backgroundColor: colors.brass,
              paddingHorizontal: 18,
              justifyContent: 'center',
              borderRadius: 12,
            }}
          >
            <Text style={{ color: colors.bg, fontWeight: '800', fontSize: 13 }}>Redeem</Text>
          </Pressable>
        </View>
      </View>

      <Text
        style={{
          color: colors.textFaint,
          fontSize: 11,
          textAlign: 'center',
          lineHeight: 16,
          paddingBottom: 20,
        }}
      >
        Coins and gems are virtual items with no cash value. They cannot be exchanged for money or
        withdrawn, and nothing here affects the outcome of a match.
      </Text>
    </ScrollView>
  );
}
