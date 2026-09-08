import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Svg from 'react-native-svg';
import { formatCoins } from '@carrom/config';
import { RARITY_ORDER, type BoardTheme, type CosmeticItem, type Rarity } from '@carrom/content';
import { drawBoard, drawPiece, SCENE_SIZE } from '@carrom/ui';
import { SvgPainter } from '../components/SvgPainter';
import { colors, rarityColor, styles } from '../theme';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

type Owned<T> = T & { owned: boolean; duplicates: number };

interface LockerPayload {
  strikers: Owned<CosmeticItem>[];
  coinSets: Owned<CosmeticItem>[];
  boards: Owned<BoardTheme>[];
  equipped: { striker: string; coinSet: string; board: string };
  counts: { owned: number; total: number };
  coins: number;
}

type Tab = 'strikers' | 'coinSets' | 'boards';

/** One cosmetic drawn with the shared renderer, sized for a grid tile. */
function ItemTile({ item, size = 64 }: { item: CosmeticItem; size?: number }) {
  const painter = new SvgPainter();
  drawPiece(painter, size / 2, size / 2, size * 0.36, { item }, 0);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {painter.render()}
    </Svg>
  );
}

function BoardTile({ theme, size = 96 }: { theme: BoardTheme; size?: number }) {
  const painter = new SvgPainter();
  drawBoard(painter, { theme, time: 1.2, ambience: false });
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${SCENE_SIZE} ${SCENE_SIZE}`}>
      {painter.render()}
    </Svg>
  );
}

export default function LockerScreen() {
  const { setBalance } = useSession();
  const [data, setData] = useState<LockerPayload | null>(null);
  const [tab, setTab] = useState<Tab>('strikers');
  const [rarity, setRarity] = useState<Rarity | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api<LockerPayload>('/inventory').then(setData).catch(() => undefined);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(id);
  }, [notice]);

  const act = async (itemId: string, action: 'equip' | 'buy') => {
    setBusy(itemId);
    try {
      const result = await api<{ balance?: number; name?: string }>(`/inventory/${action}`, {
        method: 'POST',
        body: { itemId },
      });
      if (result.balance !== undefined) setBalance(result.balance);
      await load();
      setNotice(action === 'buy' ? `${result.name} unlocked` : 'Equipped');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const items = useMemo(() => {
    if (!data) return [];
    const source = tab === 'strikers' ? data.strikers : tab === 'coinSets' ? data.coinSets : data.boards;
    return rarity === 'all' ? source : source.filter((i) => i.rarity === rarity);
  }, [data, tab, rarity]);

  const equippedId = data
    ? tab === 'strikers'
      ? data.equipped.striker
      : tab === 'coinSets'
        ? data.equipped.coinSet
        : data.equipped.board
    : '';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Locker</Text>
      <Text style={styles.muted}>
        {data ? `${data.counts.owned} of ${data.counts.total} collected` : 'Loading…'}
      </Text>

      <View style={[styles.row, { gap: 8 }]}>
        {(
          [
            ['strikers', 'Strikers'],
            ['coinSets', 'Coins'],
            ['boards', 'Boards'],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            onPress={() => setTab(id)}
            style={[
              styles.chip,
              { flex: 1, alignItems: 'center', borderColor: tab === id ? colors.brass : colors.border },
            ]}
          >
            <Text style={[styles.chipText, tab === id ? { color: colors.brass } : null]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 36 }}>
        <View style={[styles.row, { gap: 6 }]}>
          <Pressable style={styles.chip} onPress={() => setRarity('all')}>
            <Text style={[styles.chipText, rarity === 'all' ? { color: colors.text } : null]}>All</Text>
          </Pressable>
          {RARITY_ORDER.map((r) => (
            <Pressable key={r} style={styles.chip} onPress={() => setRarity(r)}>
              <Text style={[styles.chipText, { color: rarity === r ? rarityColor[r] : colors.textMuted }]}>
                {r}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {items.map((item) => {
          const equipped = item.id === equippedId;
          const price =
            'unlock' in item && item.unlock.kind === 'shop' ? item.unlock.coins : undefined;

          return (
            <View
              key={item.id}
              style={[
                styles.panelTight,
                {
                  width: '47%',
                  alignItems: 'center',
                  gap: 6,
                  opacity: item.owned ? 1 : 0.55,
                  borderColor: equipped ? colors.brass : `${rarityColor[item.rarity]}55`,
                },
              ]}
            >
              {tab === 'boards' ? (
                <BoardTile theme={item as BoardTheme} />
              ) : (
                <ItemTile item={item as CosmeticItem} />
              )}

              <Text style={[styles.body, { fontWeight: '700', fontSize: 13 }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.faint, { color: rarityColor[item.rarity], textTransform: 'uppercase' }]}>
                {item.rarity}
              </Text>

              {equipped ? (
                <Text style={[styles.chipText, { color: colors.brass }]}>Equipped</Text>
              ) : item.owned ? (
                <Pressable
                  style={[styles.chip, { alignSelf: 'stretch', alignItems: 'center' }]}
                  disabled={busy === item.id}
                  onPress={() => void act(item.id, 'equip')}
                >
                  <Text style={styles.chipText}>{busy === item.id ? '…' : 'Equip'}</Text>
                </Pressable>
              ) : price !== undefined ? (
                <Pressable
                  style={[
                    styles.chip,
                    { alignSelf: 'stretch', alignItems: 'center', borderColor: colors.brass },
                  ]}
                  disabled={busy === item.id || (data?.coins ?? 0) < price}
                  onPress={() => void act(item.id, 'buy')}
                >
                  <Text style={[styles.chipText, { color: colors.brass }]}>
                    {formatCoins(price)}
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.faint}>Locked</Text>
              )}
            </View>
          );
        })}
      </View>

      {notice ? (
        <View style={styles.panelTight}>
          <Text style={styles.muted}>{notice}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
