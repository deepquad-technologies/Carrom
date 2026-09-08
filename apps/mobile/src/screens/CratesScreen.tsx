import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { formatCoins } from '@carrom/config';
import { RARITY, formatDuration, type CosmeticItem, type Rarity } from '@carrom/content';
import { colors, rarityColor, styles } from '../theme';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface OwnedCrate {
  id: string; kind: string; name: string;
  remaining: number; ready: boolean; unlocking: boolean;
  speedUpCost: number; unlockMs: number; accent: string;
}

interface CrateType {
  id: string; name: string; description: string;
  itemDrops: number; guaranteed: Rarity; accent: string;
  dropRates: Array<{ rarity: Rarity; percent: number }>;
}

interface OpenResult {
  coins: number; xp: number; balance: number;
  drops: Array<{ item: CosmeticItem; duplicate: boolean; coins: number }>;
}

export default function CratesScreen() {
  const { setBalance, refresh } = useSession();
  const [crates, setCrates] = useState<OwnedCrate[]>([]);
  const [types, setTypes] = useState<CrateType[]>([]);
  const [slots, setSlots] = useState(4);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    await api<{ crates: OwnedCrate[]; types: CrateType[]; slots: number }>('/crates')
      .then((data) => {
        setCrates(data.crates);
        setTypes(data.types);
        setSlots(data.slots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep unlock countdowns moving.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const act = async (crateId: string, action: 'unlock' | 'speed-up' | 'open') => {
    setBusy(crateId);
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
      setNotice(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Crates</Text>
      <Text style={styles.muted}>Win a match to earn one. Timers run in the background.</Text>

      {notice ? (
        <View style={styles.panelTight}>
          <Text style={styles.muted}>{notice}</Text>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {Array.from({ length: slots }).map((_, index) => {
          const crate = crates[index];

          if (!crate) {
            return (
              <View
                key={`empty-${index}`}
                style={[
                  styles.panelTight,
                  { width: '47%', aspectRatio: 0.85, alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed' },
                ]}
              >
                <Text style={{ fontSize: 28, opacity: 0.2 }}>{'\u{1F381}'}</Text>
                <Text style={styles.faint}>Empty</Text>
              </View>
            );
          }

          return (
            <View
              key={crate.id}
              style={[
                styles.panelTight,
                { width: '47%', alignItems: 'center', gap: 8, borderColor: `${crate.accent}66` },
              ]}
            >
              <Text style={{ fontSize: 38 }}>{'\u{1F381}'}</Text>
              <Text style={[styles.body, { fontWeight: '700' }]}>{crate.name}</Text>
              <Text style={styles.faint}>
                {crate.ready
                  ? 'Ready'
                  : crate.unlocking
                    ? formatDuration(crate.remaining)
                    : `Takes ${formatDuration(crate.unlockMs)}`}
              </Text>

              <Pressable
                style={[
                  styles.button,
                  crate.ready ? styles.buttonPrimary : styles.buttonGhost,
                  { alignSelf: 'stretch', paddingVertical: 10 },
                ]}
                disabled={busy === crate.id}
                onPress={() =>
                  void act(crate.id, crate.ready ? 'open' : crate.unlocking ? 'speed-up' : 'unlock')
                }
              >
                <Text style={crate.ready ? styles.buttonPrimaryText : styles.buttonGhostText}>
                  {busy === crate.id
                    ? '…'
                    : crate.ready
                      ? 'Open'
                      : crate.unlocking
                        ? `Skip ${formatCoins(crate.speedUpCost)}`
                        : 'Start'}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      {types.map((type) => (
        <View key={type.id} style={styles.panel}>
          <Text style={[styles.heading, { color: type.accent }]}>{type.name}</Text>
          <Text style={[styles.faint, { marginBottom: 8 }]}>{type.description}</Text>
          {type.dropRates.map((rate) => (
            <View key={rate.rarity} style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text style={[styles.faint, { color: rarityColor[rate.rarity] }]}>
                {RARITY[rate.rarity].name}
              </Text>
              <Text style={styles.faint}>{rate.percent}%</Text>
            </View>
          ))}
        </View>
      ))}

      <Modal visible={Boolean(opened)} transparent animationType="fade">
        <View style={[styles.center, { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', padding: 24 }]}>
          <View style={[styles.panel, { width: '100%' }]}>
            <Text style={[styles.title, { textAlign: 'center' }]}>Crate opened</Text>
            <Text style={[styles.muted, { textAlign: 'center', marginTop: 4 }]}>
              +{formatCoins(opened?.coins ?? 0)} coins · +{opened?.xp ?? 0} XP
            </Text>

            <View style={{ gap: 8, marginTop: 16 }}>
              {(opened?.drops ?? []).map((drop, index) => (
                <View
                  key={`${drop.item.id}-${index}`}
                  style={[styles.panelTight, { borderColor: `${rarityColor[drop.item.rarity]}66` }]}
                >
                  <Text style={[styles.body, { fontWeight: '700' }]}>{drop.item.name}</Text>
                  <Text style={[styles.faint, { color: rarityColor[drop.item.rarity] }]}>
                    {RARITY[drop.item.rarity].name}
                    {drop.duplicate ? ` · duplicate, +${formatCoins(drop.coins)} coins` : ''}
                  </Text>
                </View>
              ))}
            </View>

            <Pressable
              style={[styles.button, styles.buttonPrimary, { marginTop: 18 }]}
              onPress={() => setOpened(null)}
            >
              <Text style={styles.buttonPrimaryText}>Collect</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
