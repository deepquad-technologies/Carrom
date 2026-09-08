/**
 * All geometry is expressed in "board units": the playing surface is a
 * BOARD_SIZE x BOARD_SIZE square with the origin at its top-left corner.
 * Real carrom proportions (29" surface, 3.18cm men, 4.13cm striker) are
 * preserved so the board looks and plays like the real thing at any scale.
 */
export const BOARD_SIZE = 800;
export const CENTER = BOARD_SIZE / 2;

export const PIECE_RADIUS = 17;
export const STRIKER_RADIUS = 22;
export const POCKET_RADIUS = 27;
export const POCKET_INSET = 44;

export const PIECE_MASS = 1;
export const STRIKER_MASS = 2.4;

/** Base line: where the striker is placed before a shot. */
export const BASE_OFFSET = 97;
export const BASE_HALF_LENGTH = 226;
export const BASE_CIRCLE_RADIUS = 22;
export const BASE_LINE_GAP = 26;

export const CENTER_CIRCLE_RADIUS = 92;
export const INNER_RING_RADIUS = PIECE_RADIUS * 2;
export const OUTER_RING_RADIUS = PIECE_RADIUS * 4;

/** Fixed physics timestep. Shared by server and clients so replays match. */
export const DT = 1 / 120;
export const LINEAR_FRICTION = 250;
export const DRAG = 0.35;
export const REST_SPEED = 6;
export const WALL_RESTITUTION = 0.7;
export const PIECE_RESTITUTION = 0.94;
export const COLLISION_EPS = 0.5;
export const MAX_SIM_STEPS = 120 * 15;

export const MIN_SHOT_SPEED = 320;
export const MAX_SHOT_SPEED = 2700;

export const POCKETS = [
  { x: POCKET_INSET, y: POCKET_INSET },
  { x: BOARD_SIZE - POCKET_INSET, y: POCKET_INSET },
  { x: BOARD_SIZE - POCKET_INSET, y: BOARD_SIZE - POCKET_INSET },
  { x: POCKET_INSET, y: BOARD_SIZE - POCKET_INSET },
] as const;

/** Points awarded for holding the queen at the end of a board. */
export const QUEEN_POINTS = 5;
export const PIECES_PER_SIDE = 9;

/**
 * Hard cap on turns per board. Foul penalties return men to the table, so two
 * evenly matched players could in principle rally forever; at the cap the board
 * is decided on men remaining.
 */
export const MAX_TURNS_PER_BOARD = 150;
