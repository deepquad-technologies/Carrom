import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { formatCoins, rankForTrophies } from '@carrom/config';
import { colors, styles } from '../theme';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface HomePayload {
  crates: { held: number; ready: number; slots: number };
  missions: Array<{
    id: string; name: string; description: string;
    target: number; progress: number; complete: boolean; claimed: boolean; coins: number;
  }>;
  stats: { winRate: number; xpIntoLevel: number; xpForNextLevel: number; globalPosition: number | null };
}

export default function HomeScreen({ onPlay }: { onPlay(): void }) {
  const { profile, setBalance } = useSession();
  const [home, setHome] = useState<HomePayload | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await api<HomePayload>('/profile/home').then(setHome).catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (missionId: string) => {
    const result = await api<{ balance?: number }>(`/profile/missions/${missionId}/claim`, {
      method: 'POST',
    }).catch(() => null);
    if (result?.balance !== undefined) setBalance(result.balance);
    await load();
  };

  const rank = profile ? rankForTrophies(profile.trophies) : null;
  const xpPercent = home
    ? Math.min(100, (home.stats.xpIntoLevel / home.stats.xpForNextLevel) * 100)
    : 0;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.brass}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={styles.panel}>
        <Text style={styles.title}>{profile?.displayName ?? 'Player'}</Text>
        <Text style={styles.muted}>
          Level {profile?.level} · {rank?.name}
          {home?.stats.globalPosition ? ` · #${home.stats.globalPosition}` : ''}
        </Text>

        <View style={[styles.row, { marginTop: 14, flexWrap: 'wrap', gap: 8 }]}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{profile?.trophies ?? 0} trophies</Text>
          </View>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{home?.stats.winRate ?? 0}% wins</Text>
          </View>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{profile?.currentStreak ?? 0} streak</Text>
          </View>
        </View>

        <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 16, overflow: 'hidden' }}>
          <View style={{ height: '100%', width: `${xpPercent}%`, backgroundColor: colors.brass }} />
        </View>
      </View>

      <Pressable
        style={[styles.panel, { borderColor: 'rgba(242,201,76,0.35)', backgroundColor: 'rgba(242,201,76,0.08)' }]}
        onPress={onPlay}
      >
        <Text style={[styles.title, { fontSize: 30 }]}>Play</Text>
        <Text style={styles.muted}>Quick match, ranked, team or a private room.</Text>
      </Pressable>

      <View style={styles.panel}>
        <Text style={styles.heading}>Crates</Text>
        <View style={[styles.row, { marginTop: 12, gap: 8 }]}>
          {Array.from({ length: home?.crates.slots ?? 4 }).map((_, index) => {
            const filled = index < (home?.crates.held ?? 0);
            return (
              <View
                key={index}
                style={{
                  flex: 1,
                  aspectRatio: 1,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderStyle: filled ? 'solid' : 'dashed',
                  borderColor: filled ? colors.brass : colors.border,
                  backgroundColor: filled ? 'rgba(242,201,76,0.10)' : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 22, opacity: filled ? 1 : 0.2 }}>{'\u{1F381}'}</Text>
              </View>
            );
          })}
        </View>
        <Text style={[styles.faint, { marginTop: 10 }]}>
          {home?.crates.ready
            ? `${home.crates.ready} ready to open`
            : 'Win a match to earn a crate'}
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.heading}>Today</Text>
        <View style={{ gap: 10, marginTop: 12 }}>
          {(home?.missions ?? []).slice(0, 4).map((mission) => (
            <View key={mission.id} style={styles.panelTight}>
              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.body, { fontWeight: '600' }]}>{mission.name}</Text>
                  <Text style={styles.faint}>{mission.description}</Text>
                </View>
                {mission.claimed ? (
                  <Text style={[styles.faint, { color: colors.felt }]}>Claimed</Text>
                ) : mission.complete ? (
                  <Pressable
                    style={[styles.chip, { borderColor: colors.brass }]}
                    onPress={() => void claim(mission.id)}
                  >
                    <Text style={[styles.chipText, { color: colors.brass }]}>
                      +{formatCoins(mission.coins)}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.faint}>
                    {mission.progress}/{mission.target}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      </View>

      <Text style={[styles.faint, { textAlign: 'center' }]}>
        Coins are virtual and have no cash value.
      </Text>
    </ScrollView>
  );
}
