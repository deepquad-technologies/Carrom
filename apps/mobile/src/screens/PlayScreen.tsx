import React, { useCallback, useState } from 'react';
import {
  Dimensions, Modal, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import { GAME_MODE_LIST, MATCH_TIERS, formatCoins } from '@carrom/config';
import { QUICK_MESSAGES } from '@carrom/content';
import type { Shot } from '@carrom/types';
import Board from '../components/Board';
import { colors, styles } from '../theme';
import { useMatch } from '../lib/useMatch';
import { useSession } from '../lib/session';

/**
 * The three practice opponents.
 *
 * Described by how they play rather than by a number, because "medium" tells a
 * player nothing about what they are about to face.
 */
const BOT_LEVELS = [
  {
    id: 'easy' as const,
    name: 'Easy',
    icon: '\u{1F331}',
    blurb: 'Aims roughly and misses often. A fair first opponent.',
  },
  {
    id: 'medium' as const,
    name: 'Medium',
    icon: '\u{1F3AF}',
    blurb: 'Takes the obvious shot and usually makes it.',
  },
  {
    id: 'hard' as const,
    name: 'Hard',
    icon: '\u{1F525}',
    blurb: 'Hunts the queen, plays position, rarely fouls.',
  },
];

export default function PlayScreen() {
  const { profile, setBalance, refresh } = useSession();
  const match = useMatch(setBalance);

  const [modeId, setModeId] = useState('quick');
  const [tierId, setTierId] = useState('beginner');
  const [code, setCode] = useState('');

  const mode = GAME_MODE_LIST.find((m) => m.id === modeId) ?? GAME_MODE_LIST[0];
  const tier = MATCH_TIERS.find((t) => t.id === tierId) ?? MATCH_TIERS[0];
  const coins = profile?.coins ?? 0;
  const canAfford = !mode.staked || coins >= tier.minBalance;

  const onShoot = useCallback((shot: Shot) => match.shoot(shot), [match]);

  const boardSize = Math.min(Dimensions.get('window').width - 24, 520);
  const board = match.displayState;
  const inMatch = board && ['playing', 'animating', 'over'].includes(match.phase);

  /* --------------------------------- in play -------------------------------- */

  if (inMatch && board && match.room) {
    const room = match.room;
    const urgent = match.secondsLeft <= Math.max(5, room.turnSeconds * 0.2);

    return (
      <View style={styles.screen}>
        <View style={{ padding: 12, gap: 10 }}>
          <View style={[styles.panel, { padding: 12 }]}>
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              {room.players.map((player) => {
                const isTurn = board.turnSeat === player.seat;
                const left = board.bodies.filter(
                  (b) => b.kind === player.color && !b.pocketed,
                ).length;
                return (
                  <View
                    key={player.userId}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: isTurn ? colors.brass : colors.border,
                      backgroundColor: isTurn ? 'rgba(242,201,76,0.10)' : 'transparent',
                      opacity: player.connected ? 1 : 0.5,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Text
                        style={[styles.body, { fontWeight: '700', flexShrink: 1 }]}
                        numberOfLines={1}
                      >
                        {player.seat === match.mySeat ? 'You' : player.displayName}
                      </Text>
                      {/* A player should always be able to tell who is a person. */}
                      {player.isBot && (
                        <Text
                          style={{
                            color: colors.textMuted,
                            fontSize: 9,
                            fontWeight: '800',
                            letterSpacing: 0.6,
                            borderWidth: 1,
                            borderColor: colors.border,
                            borderRadius: 3,
                            paddingHorizontal: 4,
                            paddingVertical: 1,
                          }}
                        >
                          BOT
                        </Text>
                      )}
                    </View>
                    <Text style={styles.faint}>
                      {player.color} · {left} left
                      {player.isBot ? ` · ${player.botSkill ?? 'medium'}` : ''}
                    </Text>
                  </View>
                );
              })}

              <View style={{ paddingHorizontal: 10, alignItems: 'center' }}>
                <Text
                  style={{
                    fontSize: 22,
                    fontWeight: '800',
                    color: urgent ? colors.danger : colors.text,
                  }}
                >
                  {match.secondsLeft}
                </Text>
                <Text style={styles.faint}>sec</Text>
              </View>
            </View>

            {board.queenPending ? (
              <Text style={[styles.faint, { color: '#fca5a5', marginTop: 6 }]}>
                Queen taken — cover it this turn
              </Text>
            ) : null}
          </View>

          <View style={styles.center}>
            <Board
              state={board}
              viewSeat={match.mySeat ?? 0}
              interactive={match.myTurn}
              size={boardSize}
              pockets={match.pockets}
              trail={match.trail}
              onShoot={onShoot}
            />
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44 }}>
            <View style={[styles.row, { gap: 8, paddingHorizontal: 2 }]}>
              {QUICK_MESSAGES.slice(0, 6).map((quick) => (
                <Pressable
                  key={quick.id}
                  style={styles.chip}
                  onPress={() => match.sendQuick(quick.id)}
                >
                  <Text style={styles.chipText}>
                    {quick.emoji} {quick.text}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          {match.message ? (
            <View style={styles.panelTight}>
              <Text style={styles.muted}>{match.message}</Text>
            </View>
          ) : null}

          <Pressable style={[styles.button, styles.buttonDanger]} onPress={match.leave}>
            <Text style={styles.buttonDangerText}>Leave match</Text>
          </Pressable>
        </View>

        <Modal visible={Boolean(match.result)} transparent animationType="fade">
          <View style={[styles.center, { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', padding: 24 }]}>
            <View style={[styles.panel, { width: '100%' }]}>
              <Text style={[styles.title, { textAlign: 'center' }]}>
                {match.result?.winner === null
                  ? 'Drawn board'
                  : match.mySeat !== null &&
                      match.room?.players.find((p) => p.seat === match.mySeat)?.color ===
                        match.result?.winner
                    ? 'You win'
                    : 'Good game'}
              </Text>

              {match.result &&
                Object.values(match.result.rewards)
                  .filter((reward) =>
                    match.room?.players.some(
                      (p) => p.seat === match.mySeat && p.userId === reward.userId,
                    ),
                  )
                  .map((reward) => (
                    <View key={reward.userId} style={{ gap: 8, marginTop: 16 }}>
                      <Row label="Coins" value={reward.coins > 0 ? `+${formatCoins(reward.coins)}` : '—'} />
                      <Row label="XP" value={`+${reward.xp}`} />
                      {reward.trophies !== 0 ? (
                        <Row label="Trophies" value={`${reward.trophies > 0 ? '+' : ''}${reward.trophies}`} />
                      ) : null}
                      {reward.crateKind ? <Row label="Crate" value={reward.crateKind} /> : null}
                    </View>
                  ))}

              <Pressable
                style={[styles.button, styles.buttonPrimary, { marginTop: 20 }]}
                onPress={() => {
                  match.dismissResult();
                  void refresh();
                }}
              >
                <Text style={styles.buttonPrimaryText}>Play again</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  /* ---------------------------------- queued -------------------------------- */

  if (match.phase === 'queued') {
    return (
      <View style={[styles.screen, styles.center, { padding: 24 }]}>
        <Text style={{ fontSize: 56 }}>{'\u{1F3AF}'}</Text>
        <Text style={[styles.title, { marginTop: 16 }]}>Finding an opponent</Text>
        <Text style={[styles.muted, { marginTop: 6 }]}>
          {match.queueWaiting} in the {tier.name} queue
        </Text>
        <Pressable
          style={[styles.button, styles.buttonGhost, { marginTop: 24, minWidth: 160 }]}
          onPress={match.cancelQueue}
        >
          <Text style={styles.buttonGhostText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  /* ---------------------------------- lobby --------------------------------- */

  if (match.phase === 'lobby' && match.room && !match.room.started) {
    const room = match.room;
    return (
      <View style={[styles.screen, { padding: 16 }]}>
        <View style={[styles.panel, styles.center]}>
          <Text style={styles.faint}>ROOM CODE</Text>
          <Text style={{ fontSize: 42, fontWeight: '900', color: colors.brass, letterSpacing: 8 }}>
            {room.code}
          </Text>

          <View style={{ width: '100%', gap: 8, marginTop: 20 }}>
            {Array.from({ length: room.capacity }).map((_, seat) => {
              const player = room.players.find((p) => p.seat === seat);
              return (
                <View key={seat} style={styles.panelTight}>
                  <Text style={styles.body}>
                    {player ? `${player.displayName}${player.ready ? ' · ready' : ''}` : 'Waiting…'}
                  </Text>
                </View>
              );
            })}
          </View>

          <Pressable
            style={[styles.button, styles.buttonPrimary, { marginTop: 20, alignSelf: 'stretch' }]}
            onPress={() => match.setReady(true)}
          >
            <Text style={styles.buttonPrimaryText}>I am ready</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.buttonGhost, { marginTop: 8, alignSelf: 'stretch' }]}
            onPress={match.leave}
          >
            <Text style={styles.buttonGhostText}>Leave</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  /* --------------------------------- chooser -------------------------------- */

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Play</Text>
      <Text style={styles.muted}>
        {match.connected ? 'Connected' : 'Connecting…'} · Coins are virtual.
      </Text>

      {match.error ? (
        <View style={[styles.panelTight, { borderColor: 'rgba(239,68,68,0.35)' }]}>
          <Text style={{ color: '#fca5a5', fontSize: 13 }}>{match.error}</Text>
        </View>
      ) : null}

      <View style={styles.panel}>
        <Text style={styles.heading}>Mode</Text>
        <View style={{ gap: 8, marginTop: 12 }}>
          {GAME_MODE_LIST.filter((m) => m.matchmaking !== 'code' || m.id === 'private').map((option) => {
            const active = option.id === modeId;
            const locked = (profile?.level ?? 1) < option.minLevel;
            return (
              <Pressable
                key={option.id}
                disabled={locked}
                onPress={() => setModeId(option.id)}
                style={[
                  styles.panelTight,
                  {
                    borderColor: active ? colors.brass : colors.border,
                    backgroundColor: active ? 'rgba(242,201,76,0.10)' : colors.surfaceAlt,
                    opacity: locked ? 0.4 : 1,
                  },
                ]}
              >
                <Text style={[styles.body, { fontWeight: '700' }]}>{option.name}</Text>
                <Text style={styles.faint}>{option.description}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {mode.staked ? (
        <View style={styles.panel}>
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Text style={styles.heading}>Table</Text>
            <Text style={styles.faint}>{formatCoins(coins)} coins</Text>
          </View>

          <View style={{ gap: 8, marginTop: 12 }}>
            {MATCH_TIERS.map((option) => {
              const active = option.id === tierId;
              const affordable = coins >= option.minBalance;
              const unlocked = (profile?.level ?? 1) >= option.minLevel;
              return (
                <Pressable
                  key={option.id}
                  disabled={!affordable || !unlocked}
                  onPress={() => setTierId(option.id)}
                  style={[
                    styles.panelTight,
                    {
                      borderColor: active ? colors.brass : colors.border,
                      backgroundColor: active ? 'rgba(242,201,76,0.10)' : colors.surfaceAlt,
                      opacity: affordable && unlocked ? 1 : 0.4,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    },
                  ]}
                >
                  <View>
                    <Text style={[styles.body, { fontWeight: '700' }]}>{option.name}</Text>
                    <Text style={styles.faint}>
                      {unlocked ? `Entry ${formatCoins(option.entry)}` : `Level ${option.minLevel}`}
                    </Text>
                  </View>
                  <Text style={{ color: colors.brass, fontWeight: '800', fontSize: 16 }}>
                    {formatCoins(option.entry)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <Pressable
        style={[styles.button, styles.buttonPrimary]}
        disabled={!match.connected || !canAfford}
        onPress={() => {
          if (mode.matchmaking === 'queue') match.quickMatch(mode.id, tier.id);
          else match.createRoom({ modeId: mode.id, tierId: tier.id, solo: mode.matchmaking === 'solo' });
        }}
      >
        <Text style={styles.buttonPrimaryText}>
          {mode.matchmaking === 'queue'
            ? 'Find a match'
            : mode.matchmaking === 'solo'
              ? 'Start practice'
              : 'Create room'}
        </Text>
      </Pressable>

      {/* Practice opponents. Always available, whatever mode is selected. */}
      <View style={styles.panel}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Play a bot</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2, marginBottom: 10 }}>
          A computer opponent, right now. No entry fee, no stake — it plays by exactly the same
          rules you do.
        </Text>

        <View style={{ gap: 8 }}>
          {BOT_LEVELS.map((level) => (
            <Pressable
              key={level.id}
              disabled={!match.connected}
              onPress={() => match.playBot(level.id)}
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surfaceAlt,
                borderRadius: 14,
                padding: 12,
                opacity: match.connected ? 1 : 0.4,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 16 }}>{level.icon}</Text>
                <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
                  {level.name}
                </Text>
              </View>
              <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 3 }}>
                {level.blurb}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.row, { gap: 8 }]}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder="Room code"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="characters"
          maxLength={5}
          value={code}
          onChangeText={(text) => setCode(text.toUpperCase())}
        />
        <Pressable
          style={[styles.button, styles.buttonGhost]}
          disabled={code.length < 4}
          onPress={() => match.joinRoom(code)}
        >
          <Text style={styles.buttonGhostText}>Join</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.row, { justifyContent: 'space-between' }]}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.body, { fontWeight: '700' }]}>{value}</Text>
    </View>
  );
}
