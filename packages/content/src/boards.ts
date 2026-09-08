import type { Rarity } from './rarity';
import type { Unlock } from './items';

/**
 * 20 boards. Every one changes the frame, bed, pockets, markings and backdrop,
 * plus an optional ambient animation. Contrast between the bed and the men is
 * kept high on every board so play is never harder to read on a fancy table.
 */
export type BoardPattern =
  | 'grain'
  | 'inlay'
  | 'marble'
  | 'lacquer'
  | 'neon'
  | 'starfield'
  | 'gold'
  | 'ice'
  | 'ember'
  | 'sand'
  | 'leaf'
  | 'petal'
  | 'circuit'
  | 'stone'
  | 'wave'
  | 'silk';

/** Slow background motion behind and around the board. */
export type BoardAmbience =
  | 'none'
  | 'dust'
  | 'stars'
  | 'bubbles'
  | 'petals'
  | 'embers'
  | 'snow'
  | 'fireflies'
  | 'scanlines'
  | 'confetti'
  | 'shimmer';

/** Which sample pack the client loads for this board. */
export type SoundPack =
  | 'wood'
  | 'marble'
  | 'metal'
  | 'glass'
  | 'digital'
  | 'stone'
  | 'festive';

export interface BoardTheme {
  id: string;
  name: string;
  rarity: Rarity;
  unlock: Unlock;

  /** Outer frame. */
  frame: string;
  frameDark: string;
  /** Decorative inlay line just inside the frame. */
  frameInlay: string;

  /** Playing bed. */
  surface: string;
  surfaceEdge: string;

  /** Base lines, base circles and the centre rosette. */
  line: string;
  circle: string;

  pocket: string;
  pocketRim: string;
  /** Rendering treatment for the four pockets. */
  pocketStyle: 'plain' | 'ringed' | 'gilded' | 'glow' | 'carved';

  /** Accent used for highlights, turn markers and the ambient glow. */
  accent: string;
  glow: string;

  pattern: BoardPattern;
  ambience: BoardAmbience;
  sound: SoundPack;

  /** Backdrop behind the board. */
  backdrop: string;
  backdropAlt: string;
}

export const BOARDS: BoardTheme[] = [
  {
    id: 'classic_wood', name: 'Classic Wood', rarity: 'common', unlock: { kind: 'starter' },
    frame: '#6d4526', frameDark: '#4a2d17', frameInlay: '#c98a3c',
    surface: '#e8c88f', surfaceEdge: '#d3ab68',
    line: '#7a4a22', circle: '#a8703a',
    pocket: '#1c120a', pocketRim: '#3d2614', pocketStyle: 'plain',
    accent: '#c98a3c', glow: 'rgba(201,138,60,0.35)',
    pattern: 'grain', ambience: 'dust', sound: 'wood',
    backdrop: '#241708', backdropAlt: '#3a2611',
  },
  {
    id: 'ocean', name: 'Ocean', rarity: 'common', unlock: { kind: 'starter' },
    frame: '#1f4f6b', frameDark: '#123246', frameInlay: '#6fc8e0',
    surface: '#dff0f4', surfaceEdge: '#b4d8e2',
    line: '#2f6a86', circle: '#69b3d0',
    pocket: '#08181f', pocketRim: '#1e3c4a', pocketStyle: 'ringed',
    accent: '#4fc4e8', glow: 'rgba(79,196,232,0.4)',
    pattern: 'wave', ambience: 'bubbles', sound: 'glass',
    backdrop: '#07202b', backdropAlt: '#0f3a4a',
  },
  {
    id: 'desert', name: 'Desert', rarity: 'common', unlock: { kind: 'level', level: 2 },
    frame: '#8a6033', frameDark: '#5c3f1f', frameInlay: '#e0b870',
    surface: '#f2dfb4', surfaceEdge: '#d8c088',
    line: '#8a6033', circle: '#b8934f',
    pocket: '#20160a', pocketRim: '#4a3418', pocketStyle: 'plain',
    accent: '#e0a850', glow: 'rgba(224,168,80,0.4)',
    pattern: 'sand', ambience: 'dust', sound: 'stone',
    backdrop: '#2a1c0a', backdropAlt: '#453014',
  },
  {
    id: 'jungle', name: 'Jungle', rarity: 'common', unlock: { kind: 'level', level: 3 },
    frame: '#2c4a26', frameDark: '#1a2e17', frameInlay: '#7fc45c',
    surface: '#e2e4c0', surfaceEdge: '#c2c898',
    line: '#3a6030', circle: '#6a9a52',
    pocket: '#0c1608', pocketRim: '#243a1c', pocketStyle: 'carved',
    accent: '#7fc45c', glow: 'rgba(127,196,92,0.4)',
    pattern: 'leaf', ambience: 'fireflies', sound: 'wood',
    backdrop: '#0d1a0a', backdropAlt: '#1a2e14',
  },
  {
    id: 'marble', name: 'Marble', rarity: 'common', unlock: { kind: 'level', level: 4 },
    frame: '#4a5364', frameDark: '#2e3542', frameInlay: '#dfe4ec',
    surface: '#f0f2f6', surfaceEdge: '#ccd2dc',
    line: '#5a6478', circle: '#8b96a8',
    pocket: '#131720', pocketRim: '#39414f', pocketStyle: 'ringed',
    accent: '#b8c4d6', glow: 'rgba(184,196,214,0.4)',
    pattern: 'marble', ambience: 'shimmer', sound: 'marble',
    backdrop: '#161a22', backdropAlt: '#262d3a',
  },
  {
    id: 'shadow', name: 'Shadow', rarity: 'common', unlock: { kind: 'level', level: 5 },
    frame: '#22252c', frameDark: '#13151a', frameInlay: '#4a5060',
    surface: '#c8ccd4', surfaceEdge: '#a2a8b4',
    line: '#3a4050', circle: '#6a7284',
    pocket: '#05060a', pocketRim: '#1e222c', pocketStyle: 'plain',
    accent: '#8a93a6', glow: 'rgba(138,147,166,0.35)',
    pattern: 'stone', ambience: 'none', sound: 'stone',
    backdrop: '#0a0b0f', backdropAlt: '#15171d',
  },

  {
    id: 'emerald', name: 'Emerald', rarity: 'rare', unlock: { kind: 'tier', tierId: 'pro' },
    frame: '#1f5540', frameDark: '#123326', frameInlay: '#4fd6a0',
    surface: '#e4f0e0', surfaceEdge: '#c0d8bc',
    line: '#2f6a50', circle: '#4d9a76',
    pocket: '#06170f', pocketRim: '#1a3c2c', pocketStyle: 'gilded',
    accent: '#3fd08a', glow: 'rgba(63,208,138,0.45)',
    pattern: 'inlay', ambience: 'shimmer', sound: 'marble',
    backdrop: '#08211a', backdropAlt: '#0f3a2c',
  },
  {
    id: 'sakura', name: 'Sakura', rarity: 'rare', unlock: { kind: 'crate' },
    frame: '#7a4050', frameDark: '#4f2632', frameInlay: '#ffc0d4',
    surface: '#fbeef2', surfaceEdge: '#e8ccd6',
    line: '#a05a70', circle: '#d08aa0',
    pocket: '#1f0d14', pocketRim: '#452230', pocketStyle: 'carved',
    accent: '#ff9ec0', glow: 'rgba(255,158,192,0.45)',
    pattern: 'petal', ambience: 'petals', sound: 'wood',
    backdrop: '#22101a', backdropAlt: '#3c1c2a',
  },
  {
    id: 'ice', name: 'Ice', rarity: 'rare', unlock: { kind: 'crate' },
    frame: '#2b4a5c', frameDark: '#1a2f3c', frameInlay: '#a8e8f8',
    surface: '#eaf7fc', surfaceEdge: '#c2e2ee',
    line: '#3a7a96', circle: '#7fc4dc',
    pocket: '#08161e', pocketRim: '#1e3c4a', pocketStyle: 'glow',
    accent: '#7fdbf0', glow: 'rgba(127,219,240,0.5)',
    pattern: 'ice', ambience: 'snow', sound: 'glass',
    backdrop: '#08161e', backdropAlt: '#12303e',
  },
  {
    id: 'tropical', name: 'Tropical', rarity: 'rare', unlock: { kind: 'crate' },
    frame: '#186a5a', frameDark: '#0e4038', frameInlay: '#ffd166',
    surface: '#f4f0d0', surfaceEdge: '#dcd4a4',
    line: '#2a7a64', circle: '#58b096',
    pocket: '#06201a', pocketRim: '#134034', pocketStyle: 'ringed',
    accent: '#ffd166', glow: 'rgba(255,209,102,0.45)',
    pattern: 'leaf', ambience: 'bubbles', sound: 'wood',
    backdrop: '#08241e', backdropAlt: '#0f4034',
  },
  {
    id: 'ancient', name: 'Ancient', rarity: 'rare', unlock: { kind: 'crate' },
    frame: '#5c5240', frameDark: '#3a3428', frameInlay: '#c9b98c',
    surface: '#ded4b8', surfaceEdge: '#bcb094',
    line: '#6a5c42', circle: '#948466',
    pocket: '#181408', pocketRim: '#3a3220', pocketStyle: 'carved',
    accent: '#c9a86c', glow: 'rgba(201,168,108,0.4)',
    pattern: 'stone', ambience: 'dust', sound: 'stone',
    backdrop: '#1c180e', backdropAlt: '#332c1c',
  },

  {
    id: 'royal_gold', name: 'Royal Gold', rarity: 'epic', unlock: { kind: 'tier', tierId: 'master' },
    frame: '#7a5c14', frameDark: '#523d0c', frameInlay: '#ffe58a',
    surface: '#f7e6b4', surfaceEdge: '#e0c780',
    line: '#8a6a1f', circle: '#c9a63c',
    pocket: '#1d1704', pocketRim: '#5c4614', pocketStyle: 'gilded',
    accent: '#f2c94c', glow: 'rgba(242,201,76,0.5)',
    pattern: 'gold', ambience: 'shimmer', sound: 'metal',
    backdrop: '#1f1806', backdropAlt: '#3a2d0d',
  },
  {
    id: 'midnight', name: 'Midnight', rarity: 'epic', unlock: { kind: 'crate' },
    frame: '#1a1f36', frameDark: '#0e1120', frameInlay: '#6a7ad0',
    surface: '#c8cfe8', surfaceEdge: '#a0a8c8',
    line: '#3a4470', circle: '#6a76b0',
    pocket: '#04050c', pocketRim: '#1c2242', pocketStyle: 'glow',
    accent: '#8a9aff', glow: 'rgba(138,154,255,0.5)',
    pattern: 'starfield', ambience: 'stars', sound: 'glass',
    backdrop: '#05070f', backdropAlt: '#0d1224',
  },
  {
    id: 'neon', name: 'Neon', rarity: 'epic', unlock: { kind: 'crate' },
    frame: '#12141c', frameDark: '#070810', frameInlay: '#39ffb0',
    surface: '#1c2230', surfaceEdge: '#2a3244',
    line: '#39ffb0', circle: '#ff4dd8',
    pocket: '#000000', pocketRim: '#39ffb0', pocketStyle: 'glow',
    accent: '#39ffb0', glow: 'rgba(57,255,176,0.55)',
    pattern: 'neon', ambience: 'scanlines', sound: 'digital',
    backdrop: '#05070c', backdropAlt: '#0d1119',
  },
  {
    id: 'festival', name: 'Festival', rarity: 'epic', unlock: { kind: 'crate' },
    frame: '#6a1f4a', frameDark: '#42122e', frameInlay: '#ffd166',
    surface: '#fbf0d8', surfaceEdge: '#e8d4b0',
    line: '#8a2f60', circle: '#c05a90',
    pocket: '#1c0714', pocketRim: '#451634', pocketStyle: 'gilded',
    accent: '#ffd166', glow: 'rgba(255,209,102,0.5)',
    pattern: 'silk', ambience: 'confetti', sound: 'festive',
    backdrop: '#1c0714', backdropAlt: '#360f28',
  },
  {
    id: 'palace', name: 'Palace', rarity: 'epic', unlock: { kind: 'crate' },
    frame: '#5c1d2e', frameDark: '#3a1220', frameInlay: '#f2c94c',
    surface: '#f3dcc6', surfaceEdge: '#dcbb9c',
    line: '#7a2740', circle: '#b04a63',
    pocket: '#1c0a11', pocketRim: '#441826', pocketStyle: 'gilded',
    accent: '#e0567a', glow: 'rgba(224,86,122,0.45)',
    pattern: 'silk', ambience: 'shimmer', sound: 'marble',
    backdrop: '#1c0910', backdropAlt: '#38141f',
  },

  {
    id: 'galaxy', name: 'Galaxy', rarity: 'mythic', unlock: { kind: 'tier', tierId: 'champion' },
    frame: '#241a4a', frameDark: '#140f2c', frameInlay: '#a88aff',
    surface: '#e8e4ff', surfaceEdge: '#c4bcf0',
    line: '#4b3f8a', circle: '#8577d6',
    pocket: '#0a0618', pocketRim: '#3a2a70', pocketStyle: 'glow',
    accent: '#a78bfa', glow: 'rgba(167,139,250,0.55)',
    pattern: 'starfield', ambience: 'stars', sound: 'digital',
    backdrop: '#08061a', backdropAlt: '#160f36',
  },
  {
    id: 'fire', name: 'Fire', rarity: 'mythic', unlock: { kind: 'crate' },
    frame: '#4a1408', frameDark: '#2a0b04', frameInlay: '#ff8a3c',
    surface: '#f7dcc0', surfaceEdge: '#e0b894',
    line: '#8a3a14', circle: '#c06030',
    pocket: '#1a0602', pocketRim: '#5c1c08', pocketStyle: 'glow',
    accent: '#ff7a2b', glow: 'rgba(255,122,43,0.55)',
    pattern: 'ember', ambience: 'embers', sound: 'metal',
    backdrop: '#1a0804', backdropAlt: '#33110a',
  },
  {
    id: 'cyber', name: 'Cyber', rarity: 'mythic', unlock: { kind: 'crate' },
    frame: '#0d1a16', frameDark: '#050d0b', frameInlay: '#4dff9e',
    surface: '#16241e', surfaceEdge: '#20342c',
    line: '#4dff9e', circle: '#2ad0ff',
    pocket: '#000000', pocketRim: '#4dff9e', pocketStyle: 'glow',
    accent: '#4dff9e', glow: 'rgba(77,255,158,0.6)',
    pattern: 'circuit', ambience: 'scanlines', sound: 'digital',
    backdrop: '#030806', backdropAlt: '#081411',
  },

  {
    id: 'diamond', name: 'Diamond', rarity: 'legendary', unlock: { kind: 'tier', tierId: 'grandmaster' },
    frame: '#14161f', frameDark: '#080a10', frameInlay: '#8ae0ff',
    surface: '#eef7ff', surfaceEdge: '#c8dcf0',
    line: '#3a6a8a', circle: '#7fc4e8',
    pocket: '#000000', pocketRim: '#8ae0ff', pocketStyle: 'glow',
    accent: '#8ae0ff', glow: 'rgba(138,224,255,0.65)',
    pattern: 'ice', ambience: 'shimmer', sound: 'glass',
    backdrop: '#05070c', backdropAlt: '#0d1420',
  },
];

export const DEFAULT_BOARD_ID = 'classic_wood';

export const STARTER_BOARDS = BOARDS.filter((b) => b.unlock.kind === 'starter').map((b) => b.id);

const BY_ID = new Map(BOARDS.map((b) => [b.id, b]));

export function boardById(id: string | undefined | null): BoardTheme {
  return (id ? BY_ID.get(id) : undefined) ?? BY_ID.get(DEFAULT_BOARD_ID)!;
}
