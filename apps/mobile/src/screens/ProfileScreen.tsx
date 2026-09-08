import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatCoins, rankForTrophies } from '@carrom/config';
import { colors, styles } from '../theme';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface Achievement {
  id: string;
  name: string;
  description: string;
  target: number;
  progress: number;
  unlockedAt: string | null;
}

interface MatchRow {
  id: string;
  mode_id: string;
  won: boolean | null;
  coins_delta: number | null;
  created_at: string;
  opponents: string[];
}

type Tab = 'stats' | 'achievements' | 'history' | 'account';

export default function ProfileScreen() {
  const { profile, user, stats, signOut, setBalance, refresh, error } = useSession();
  const [tab, setTab] = useState<Tab>('stats');
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [history, setHistory] = useState<MatchRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState({ email: '', password: '' });

  useEffect(() => {
    api<{ achievements: Achievement[] }>('/profile/achievements')
      .then((d) => setAchievements(d.achievements))
      .catch(() => undefined);
    api<{ matches: MatchRow[] }>('/profile/history')
      .then((d) => setHistory(d.matches))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(id);
  }, [notice]);

  const claimBonus = async () => {
    const result = await api<{ balance: number; message: string }>('/profile/bonus', {
      method: 'POST',
    }).catch(() => null);
    if (result) {
      setBalance(result.balance);
      setNotice(result.message);
    }
  };

  const saveAccount = async () => {
    try {
      await api('/auth/upgrade', { method: 'POST', body: upgrade });
      await refresh();
      setNotice('Account saved');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not save that');
    }
  };

  const rank = profile ? rankForTrophies(profile.trophies) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.panel}>
        <Text style={styles.title}>{profile?.displayName}</Text>
        <Text style={styles.muted}>
          @{profile?.username} · Level {profile?.level}
          {rank ? ` · ${rank.name}` : ''}
        </Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          <Stat label="Coins" value={formatCoins(profile?.coins ?? 0)} accent />
          <Stat label="Trophies" value={String(profile?.trophies ?? 0)} />
          <Stat label="Win rate" value={`${stats?.winRate ?? 0}%`} />
          <Stat label="Best streak" value={String(profile?.bestStreak ?? 0)} />
        </View>

        <View style={[styles.row, { gap: 8, marginTop: 14 }]}>
          <Pressable
            style={[styles.button, styles.buttonGhost, { flex: 1, paddingVertical: 10 }]}
            onPress={() => void claimBonus()}
          >
            <Text style={styles.buttonGhostText}>Free top-up</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonGhost, { flex: 1, paddingVertical: 10 }]}
            onPress={() => void signOut()}
          >
            <Text style={styles.buttonGhostText}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 40 }}>
        <View style={[styles.row, { gap: 6 }]}>
          {(
            [
              ['stats', 'Stats'],
              ['achievements', 'Achievements'],
              ['history', 'History'],
              ['account', 'Account'],
            ] as const
          ).map(([id, label]) => (
            <Pressable
              key={id}
              style={[styles.chip, { borderColor: tab === id ? colors.brass : colors.border }]}
              onPress={() => setTab(id)}
            >
              <Text style={[styles.chipText, tab === id ? { color: colors.brass } : null]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {tab === 'stats' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <BigStat label="Games" value={String(profile?.gamesPlayed ?? 0)} />
          <BigStat label="Wins" value={String(profile?.wins ?? 0)} />
          <BigStat label="Losses" value={String(profile?.losses ?? 0)} />
          <BigStat label="Streak" value={String(profile?.currentStreak ?? 0)} />
        </View>
      ) : null}

      {tab === 'achievements'
        ? achievements.map((achievement) => {
            const percent = Math.min(100, (achievement.progress / achievement.target) * 100);
            const done = Boolean(achievement.unlockedAt);
            return (
              <View
                key={achievement.id}
                style={[styles.panelTight, done ? { borderColor: 'rgba(242,201,76,0.35)' } : null]}
              >
                <Text style={[styles.body, { fontWeight: '700' }]}>
                  {done ? '\u{1F3C5} ' : ''}
                  {achievement.name}
                </Text>
                <Text style={styles.faint}>{achievement.description}</Text>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    marginTop: 8,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${percent}%`,
                      backgroundColor: done ? colors.brass : colors.felt,
                    }}
                  />
                </View>
              </View>
            );
          })
        : null}

      {tab === 'history'
        ? history.map((row) => (
            <View key={row.id} style={[styles.panelTight, styles.row, { justifyContent: 'space-between' }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.body} numberOfLines={1}>
                  vs {row.opponents.join(', ') || 'practice'}
                </Text>
                <Text style={styles.faint}>
                  {row.mode_id} · {new Date(row.created_at).toLocaleDateString()}
                </Text>
              </View>
              <Text
                style={{
                  fontWeight: '800',
                  color: row.won ? colors.felt : colors.textMuted,
                }}
              >
                {row.won === true ? 'W' : row.won === false ? 'L' : '–'}
              </Text>
            </View>
          ))
        : null}

      {tab === 'account' ? (
        <View style={{ gap: 12 }}>
          {user?.isGuest ? (
            <View style={styles.panel}>
              <Text style={styles.heading}>Save your progress</Text>
              <Text style={[styles.muted, { marginTop: 4 }]}>
                Add an email and password to keep your coins and cosmetics on any device.
              </Text>

              {error ? (
                <Text style={{ color: '#fca5a5', fontSize: 13, marginTop: 8 }}>{error}</Text>
              ) : null}

              <TextInput
                style={[styles.input, { marginTop: 12 }]}
                placeholder="Email"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                keyboardType="email-address"
                value={upgrade.email}
                onChangeText={(email) => setUpgrade({ ...upgrade, email })}
              />
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                placeholder="Password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                value={upgrade.password}
                onChangeText={(password) => setUpgrade({ ...upgrade, password })}
              />
              <Pressable
                style={[styles.button, styles.buttonPrimary, { marginTop: 12 }]}
                onPress={() => void saveAccount()}
              >
                <Text style={styles.buttonPrimaryText}>Save my account</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.panel}>
              <Text style={styles.heading}>Account</Text>
              <Text style={[styles.muted, { marginTop: 8 }]}>
                {user?.email ?? 'No email set'}
              </Text>
              <Text style={styles.faint}>
                Member since{' '}
                {profile ? new Date(profile.createdAt).toLocaleDateString() : '—'}
              </Text>
            </View>
          )}

          <View style={styles.panel}>
            <Text style={styles.heading}>About coins</Text>
            <Text style={[styles.muted, { marginTop: 8, lineHeight: 20 }]}>
              Coins are a virtual in-game currency used to enter tables and open crates
              early. They cannot be purchased, sold, transferred, or exchanged for money
              or anything of value.
            </Text>
          </View>
        </View>
      ) : null}

      {notice ? (
        <View style={styles.panelTight}>
          <Text style={styles.muted}>{notice}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={[styles.panelTight, { flexGrow: 1, minWidth: '45%' }]}>
      <Text style={styles.faint}>{label}</Text>
      <Text style={{ fontSize: 18, fontWeight: '800', color: accent ? colors.brass : colors.text }}>
        {value}
      </Text>
    </View>
  );
}

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.panel, { flexGrow: 1, minWidth: '45%' }]}>
      <Text style={styles.faint}>{label}</Text>
      <Text style={{ fontSize: 26, fontWeight: '800', color: colors.text }}>{value}</Text>
    </View>
  );
}
