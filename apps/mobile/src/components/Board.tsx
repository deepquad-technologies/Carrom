import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Svg from 'react-native-svg';
import { STRIKER_RADIUS } from '@carrom/config';
import { clampAimAngle, normalOfSide, sideOfSeat, strikerSpot } from '@carrom/game-engine';
import type { GameState, Shot } from '@carrom/types';
import { SCENE_SIZE, drawScene, screenToBoard, viewRotation, type AimState, type TrailPoint } from '@carrom/ui';
import { SvgPainter } from './SvgPainter';
import { colors, styles as theme } from '../theme';

/**
 * The board on mobile.
 *
 * Same two-gesture model as the web build, kept strictly apart:
 *
 *   - **Drag the striker** to slide it along your base line. Never fires.
 *   - **Drag anywhere else** to aim; the line points from the striker at your
 *     finger. Lift to shoot.
 *
 * Power is a separate control, so aiming at a nearby man does not force a weak
 * shot. SVG is redrawn on a timer rather than every frame — at 30fps it still
 * reads as smooth while leaving the battery alone.
 */
interface BoardProps {
  state: GameState;
  viewSeat: number;
  interactive: boolean;
  size: number;
  pockets: Array<{ id: string; kind: string; pocketIndex: number; at: number }>;
  trail: TrailPoint[];
  onShoot(shot: Shot): void;
  /** Ambient particles cost frames; off by default on mobile. */
  ambience?: boolean;
}

type Gesture = 'none' | 'moving' | 'aiming';

const GRAB_RADIUS = STRIKER_RADIUS * 3.2;
const FRAME_MS = 1000 / 30;

export default function Board({
  state,
  viewSeat,
  interactive,
  size,
  pockets,
  trail,
  onShoot,
  ambience = false,
}: BoardProps) {
  const [aim, setAim] = useState<AimState>({
    pos: 0.5,
    angle: -Math.PI / 2,
    power: 0.7,
    active: false,
  });
  const [, tick] = useState(0);

  const startedAt = useRef(Date.now());
  const gesture = useRef<Gesture>('none');
  const aimRef = useRef(aim);
  aimRef.current = aim;

  /** Where the current gesture began, for telling a tap from a drag. */
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const movedFar = useRef(false);

  const side = sideOfSeat(state.turnSeat, state.size);
  const normal = useMemo(() => normalOfSide(side), [side]);

  // SVG has no render loop of its own.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // A fresh turn starts from a sensible default, not the last player's aim.
  useEffect(() => {
    setAim((prev) => ({
      ...prev,
      // 0.5 is exactly where the engine parks the striker between turns.
      pos: 0.5,
      angle: Math.atan2(normal.ny, normal.nx),
      active: false,
    }));
  }, [state.turnSeat, normal.nx, normal.ny]);

  const rotation = viewRotation(state, viewSeat);

  const toBoard = useCallback(
    (localX: number, localY: number) => screenToBoard(localX, localY, size, rotation),
    [size, rotation],
  );

  const posFromPoint = useCallback(
    (point: { x: number; y: number }) => {
      const a = strikerSpot(side, 0);
      const b = strikerSpot(side, 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy || 1;
      return Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    },
    [side],
  );

  const aimAt = useCallback(
    (point: { x: number; y: number }, pos: number) => {
      const spot = strikerSpot(side, pos);
      const dx = point.x - spot.x;
      const dy = point.y - spot.y;
      if (Math.hypot(dx, dy) < STRIKER_RADIUS * 0.5) return null;
      return clampAimAngle(Math.atan2(dy, dx), normal.nx, normal.ny);
    },
    [side, normal.nx, normal.ny],
  );

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactive,
        onMoveShouldSetPanResponder: () => interactive,

        onPanResponderGrant: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          const point = toBoard(locationX, locationY);
          startPoint.current = point;
          movedFar.current = false;
          const spot = strikerSpot(side, aimRef.current.pos);

          if (Math.hypot(point.x - spot.x, point.y - spot.y) < GRAB_RADIUS) {
            gesture.current = 'moving';
            setAim((prev) => ({ ...prev, active: false }));
          } else {
            gesture.current = 'aiming';
            const angle = aimAt(point, aimRef.current.pos);
            setAim((prev) => ({ ...prev, angle: angle ?? prev.angle, active: true }));
          }
          void Haptics.selectionAsync().catch(() => undefined);
        },

        onPanResponderMove: (event) => {
          if (gesture.current === 'none') return;
          const { locationX, locationY } = event.nativeEvent;
          const point = toBoard(locationX, locationY);

          const from = startPoint.current;
          if (from && Math.hypot(point.x - from.x, point.y - from.y) > STRIKER_RADIUS) {
            movedFar.current = true;
          }

          if (gesture.current === 'moving') {
            setAim((prev) => ({ ...prev, pos: posFromPoint(point) }));
            return;
          }

          const angle = aimAt(point, aimRef.current.pos);
          if (angle !== null) setAim((prev) => ({ ...prev, angle, active: true }));
        },

        onPanResponderRelease: () => {
          const finished = gesture.current;
          const dragged = movedFar.current;
          gesture.current = 'none';
          startPoint.current = null;
          movedFar.current = false;
          const current = aimRef.current;
          setAim((prev) => ({ ...prev, active: false }));

          // Repositioning never shoots, and neither does a tap — that only
          // points the aim, so a shot can be lined up and adjusted before it
          // is taken. A deliberate drag is the shot.
          if (finished !== 'aiming' || !dragged) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
          onShoot({ pos: current.pos, angle: current.angle, power: current.power });
        },

        onPanResponderTerminate: () => {
          gesture.current = 'none';
          startPoint.current = null;
          movedFar.current = false;
          setAim((prev) => ({ ...prev, active: false }));
        },
      }),
    [interactive, toBoard, posFromPoint, aimAt, side, onShoot],
  );

  const painter = new SvgPainter();
  const now = Date.now();

  drawScene(painter, {
    state,
    viewSeat,
    time: (now - startedAt.current) / 1000,
    aim: interactive ? aim : undefined,
    trail,
    flashes: pockets.map((p) => ({
      pocketIndex: p.pocketIndex,
      progress: Math.min(1, (now - p.at) / 700),
      color: p.kind === 'queen' ? '#ff5252' : '#ffffff',
    })),
    ambience,
    showGuide: interactive,
  });

  const step = (delta: number) =>
    setAim((prev) => ({ ...prev, power: Math.max(0.05, Math.min(1, prev.power + delta)) }));

  return (
    <View style={{ width: size }}>
      <View style={[localStyles.board, { width: size, height: size }]} {...responder.panHandlers}>
        <Svg width={size} height={size} viewBox={`0 0 ${SCENE_SIZE} ${SCENE_SIZE}`}>
          {painter.render()}
        </Svg>
      </View>

      {interactive ? (
        <View style={localStyles.controls}>
          <Text style={localStyles.hint}>
            Drag the striker to slide it · tap to aim · drag and release to shoot
          </Text>

          <View style={[theme.row, { gap: 10, marginTop: 10 }]}>
            <Pressable style={localStyles.stepper} onPress={() => step(-0.1)}>
              <Text style={localStyles.stepperText}>-</Text>
            </Pressable>

            <View style={localStyles.track}>
              <View
                style={[
                  localStyles.fill,
                  { width: `${Math.round(aim.power * 100)}%` },
                ]}
              />
            </View>

            <Pressable style={localStyles.stepper} onPress={() => step(0.1)}>
              <Text style={localStyles.stepperText}>+</Text>
            </Pressable>

            <Text style={localStyles.power}>{Math.round(aim.power * 100)}%</Text>
          </View>

          <Pressable
            style={[theme.button, theme.buttonPrimary, { marginTop: 10 }]}
            onPress={() => onShoot({ pos: aim.pos, angle: aim.angle, power: aim.power })}
          >
            <Text style={theme.buttonPrimaryText}>Shoot</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const localStyles = StyleSheet.create({
  board: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  controls: {
    marginTop: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  hint: {
    color: colors.textFaint,
    fontSize: 11,
    textAlign: 'center',
  },
  track: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: colors.brass,
  },
  stepper: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
  power: {
    width: 46,
    textAlign: 'right',
    color: colors.brass,
    fontWeight: '800',
    fontSize: 14,
  },
});
