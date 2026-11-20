// Loose objects aboard ship interiors, as pure data (no three.js): the single source both the props physics
// (src/world/props.ts) and the props renderer (src/render/space/props.ts) are built from.
//
// Ship-local axes: forward -Z, up +Y, right (starboard) +X; metres, kilograms, newtons. Every shape is centred
// on the object's centre of mass, in the object's own axes:
//   sphere   radius r
//   capsule  radius r around a segment along local +Y from -halfLen to +halfLen (total length 2·halfLen + 2r)
//   box      half extents (x, y, z)
// `rot` maps the object's axes into ship axes. Start poses rest 2 mm above the surface they sit on.
//
// Stowage: 'loose' objects are free from the start. 'clip', 'magnet' and 'strap' hold an object fixed to the
// ship with `holdN` newtons; the moment the inertial force on it (mass × felt acceleration at its position)
// exceeds that, it breaks free and is an ordinary rigid body from then on.

import type { Quat, ShipVisualId, V3 } from '../core/types';
import type { SolidKind } from './interiors';
import { MAT, type MaterialCode } from '../world/events';

export type PropType =
  | 'mug'
  | 'bottle'
  | 'tablet'
  | 'book'
  | 'pen'
  | 'foodpack'
  | 'toolbox'
  | 'spanner'
  | 'torch'
  | 'pillow'
  | 'crateSmall'
  | 'crateLarge'
  | 'helmet'
  | 'plantpot';

export type PropShape =
  | { kind: 'sphere'; r: number }
  | { kind: 'capsule'; r: number; halfLen: number }
  | { kind: 'box'; half: V3 };

export type Stowage = 'loose' | 'clip' | 'magnet' | 'strap';

/** What every object of a type shares: collision shape, mass and surface material. */
export interface PropTypeDef {
  shape: PropShape;
  /** kg (the mug and the bottle are full). */
  mass: number;
  /** Coefficient of restitution against the ship's composite panels, and Coulomb friction coefficient. */
  restitution: number;
  friction: number;
  /**
   * Drag area C_d·A, m² (SIMULATION.md W1-C 6: cabin-air drag F = −½ρ·C_dA·|u|·u). The plan's reference objects
   * (pillow 0.19, pen 0.002, mug 0.006 m²) are given; the others take C_d ≈ 1 on their mean projected area
   * (a tumbling convex body: S/4).
   */
  cdA: number;
  /** Surface material that touches things (event ring matA / matB, src/world/events.ts MAT). */
  mat: MaterialCode;
}

/**
 * Material constants, indexed by MAT code (src/world/events.ts): Young's modulus E (Pa), density ρ (kg/m³), Poisson's
 * ratio ν and loss factor η. Handbook values at room temperature. The single source for the audio's modal models
 * (src/audio/materials.ts keeps an identical table until W1-D points it here).
 */
export interface MaterialConstants { E: number; rho: number; nu: number; eta: number }
export const MATERIAL_CONSTANTS: readonly MaterialConstants[] = [
  /* aluminium */ { E: 69e9, rho: 2700, nu: 0.33, eta: 1e-3 },
  /* composite */ { E: 20e9, rho: 1900, nu: 0.3, eta: 0.01 },
  /* glass     */ { E: 70e9, rho: 2500, nu: 0.22, eta: 1e-3 },
  /* foam      */ { E: 2e5, rho: 40, nu: 0.3, eta: 0.3 },
  /* steel     */ { E: 200e9, rho: 7850, nu: 0.29, eta: 3e-4 },
  /* ceramic   */ { E: 60e9, rho: 2400, nu: 0.22, eta: 1e-3 },
  /* polymer   */ { E: 2.3e9, rho: 1050, nu: 0.35, eta: 0.02 },
  /* card      */ { E: 4e9, rho: 800, nu: 0.3, eta: 0.07 },
  /* tissue    */ { E: 1e6, rho: 1000, nu: 0.45, eta: 0.3 },
];

/** The surface a solid fitting presents: cushions foam, everything else the composite lining over the frame. */
export const solidMaterial = (kind: SolidKind): MaterialCode => (kind === 'seat' || kind === 'sofa' || kind === 'bunk' ? MAT.foam : MAT.composite);
/** Room faces: decks are aluminium panels, walls and overheads the composite lining. */
export const DECK_MATERIAL: MaterialCode = MAT.aluminium;
export const LINING_MATERIAL: MaterialCode = MAT.composite;

/** C_d ≈ 1 on the mean projected area of a convex shape (S/4), m². */
function cdaOfShape(sh: PropShape): number {
  if (sh.kind === 'sphere') return Math.PI * sh.r * sh.r;
  if (sh.kind === 'capsule') return 0.25 * (4 * Math.PI * sh.r * sh.r + 2 * Math.PI * sh.r * 2 * sh.halfLen);
  const h = sh.half;
  return 0.25 * 8 * (h.x * h.y + h.y * h.z + h.x * h.z);
}

export interface PropDef {
  id: string;
  type: PropType;
  /** Room it starts in (src/data/interiors.ts). */
  room: string;
  pos: V3;
  rot: Quat;
  stow: Stowage;
  /** Holding force of the clip / magnet / strap, N (0 when loose). */
  holdN: number;
}

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const box = (x: number, y: number, z: number): PropShape => ({ kind: 'box', half: v(x, y, z) });

export const PROP_TYPES: Record<PropType, PropTypeDef> = {
  // insulated travel mug with a lid, 0.3 L of coffee: 8.4 cm across, 11 cm tall
  mug: { shape: box(0.042, 0.055, 0.042), mass: 0.4, restitution: 0.35, friction: 0.5, cdA: 0.006, mat: MAT.steel },
  // 0.75 L water bottle, 25.6 cm long
  bottle: { shape: { kind: 'capsule', r: 0.038, halfLen: 0.09 }, mass: 1.0, restitution: 0.45, friction: 0.35, cdA: cdaOfShape({ kind: 'capsule', r: 0.038, halfLen: 0.09 }), mat: MAT.polymer },
  // 25 × 17 cm tablet, 9 mm thick
  tablet: { shape: box(0.125, 0.0045, 0.085), mass: 0.5, restitution: 0.3, friction: 0.35, cdA: cdaOfShape(box(0.125, 0.0045, 0.085)), mat: MAT.aluminium },
  // hardback, 15 × 22 cm, 3 cm thick
  book: { shape: box(0.075, 0.015, 0.11), mass: 0.6, restitution: 0.15, friction: 0.55, cdA: cdaOfShape(box(0.075, 0.015, 0.11)), mat: MAT.card },
  // stylus pen, 14 cm
  pen: { shape: { kind: 'capsule', r: 0.0055, halfLen: 0.065 }, mass: 0.012, restitution: 0.5, friction: 0.3, cdA: 0.002, mat: MAT.polymer },
  // ration pouch, 14 × 10 cm
  foodpack: { shape: box(0.07, 0.022, 0.05), mass: 0.4, restitution: 0.1, friction: 0.6, cdA: cdaOfShape(box(0.07, 0.022, 0.05)), mat: MAT.card },
  // steel toolbox, 44 × 22 × 22 cm, full
  toolbox: { shape: box(0.22, 0.11, 0.11), mass: 6.5, restitution: 0.25, friction: 0.4, cdA: cdaOfShape(box(0.22, 0.11, 0.11)), mat: MAT.steel },
  // 22 cm combination spanner
  spanner: { shape: box(0.11, 0.006, 0.017), mass: 0.3, restitution: 0.4, friction: 0.25, cdA: cdaOfShape(box(0.11, 0.006, 0.017)), mat: MAT.steel },
  // hand torch, 19 cm
  torch: { shape: { kind: 'capsule', r: 0.019, halfLen: 0.075 }, mass: 0.3, restitution: 0.4, friction: 0.3, cdA: cdaOfShape({ kind: 'capsule', r: 0.019, halfLen: 0.075 }), mat: MAT.aluminium },
  // cushion, 40 × 30 × 12 cm
  pillow: { shape: box(0.2, 0.06, 0.15), mass: 0.45, restitution: 0.05, friction: 0.8, cdA: 0.19, mat: MAT.foam },
  // composite cargo crates, 60 × 40 × 40 cm and 1.0 × 0.6 × 0.6 m, loaded
  crateSmall: { shape: box(0.3, 0.2, 0.2), mass: 25, restitution: 0.15, friction: 0.5, cdA: cdaOfShape(box(0.3, 0.2, 0.2)), mat: MAT.composite },
  crateLarge: { shape: box(0.5, 0.3, 0.3), mass: 80, restitution: 0.15, friction: 0.5, cdA: cdaOfShape(box(0.5, 0.3, 0.3)), mat: MAT.composite },
  // pressure-suit helmet, 31 cm across
  helmet: { shape: { kind: 'sphere', r: 0.155 }, mass: 1.6, restitution: 0.4, friction: 0.35, cdA: cdaOfShape({ kind: 'sphere', r: 0.155 }), mat: MAT.polymer },
  // potted herb, 18 cm square pot with soil, 24 cm tall
  plantpot: { shape: box(0.09, 0.12, 0.09), mass: 2.5, restitution: 0.2, friction: 0.5, cdA: cdaOfShape(box(0.09, 0.12, 0.09)), mat: MAT.ceramic },
};

const Q0: Quat = { x: 0, y: 0, z: 0, w: 1 };
const S = Math.SQRT1_2;
/** Rotation about +Y by `deg` degrees (yaw). */
const yaw = (deg: number): Quat => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) });
/** Capsule lying along ship Z (local +Y turned onto +Z) and along ship X. */
const ALONG_Z: Quat = { x: S, y: 0, z: 0, w: S };
const ALONG_X: Quat = { x: 0, y: 0, z: -S, w: S };

const p = (id: string, type: PropType, room: string, pos: V3, rot: Quat, stow: Stowage, holdN = 0): PropDef => ({
  id, type, room, pos, rot, stow, holdN: stow === 'loose' ? 0 : holdN,
});

/**
 * Corvane Wren (src/data/interiors.ts): where the crew would leave things. Surface heights used below:
 * galley counter top -0.08, lounge table top -0.30, sofa seat -0.55, cabin desks -0.25, bunks -0.45,
 * suit bench -0.55, workbench -0.05, deck -1.0.
 */
const WREN_PROPS: PropDef[] = [
  // galley: two mugs in magnetic holders, ration pouches in a clip rack, a water bottle in a bracket
  p('mug-galley-1', 'mug', 'lounge', v(-2.85, -0.023, -8.9), Q0, 'magnet', 4),
  p('mug-galley-2', 'mug', 'lounge', v(-2.85, -0.023, -8.65), Q0, 'magnet', 4),
  p('food-1', 'foodpack', 'lounge', v(-2.9, -0.056, -6.6), Q0, 'clip', 3),
  p('food-2', 'foodpack', 'lounge', v(-2.9, -0.056, -6.4), yaw(8), 'clip', 3),
  p('food-3', 'foodpack', 'lounge', v(-2.9, -0.056, -6.2), yaw(-5), 'clip', 3),
  p('bottle-galley', 'bottle', 'lounge', v(-2.8, -0.04, -7.4), ALONG_Z, 'clip', 20),
  // lounge table: a mug in its holder, one left loose, a book, the herb pot on its magnetic pad
  p('mug-table-1', 'mug', 'lounge', v(0.8, -0.243, -7.9), Q0, 'magnet', 4),
  p('mug-table-2', 'mug', 'lounge', v(1.15, -0.243, -7.2), yaw(30), 'loose'),
  p('book-lounge', 'book', 'lounge', v(0.9, -0.283, -6.9), yaw(20), 'loose'),
  p('plant', 'plantpot', 'lounge', v(1.3, -0.178, -8.2), Q0, 'magnet', 60),
  // sofa cushions
  p('pillow-1', 'pillow', 'lounge', v(2.4, -0.488, -8.9), yaw(80), 'loose'),
  p('pillow-2', 'pillow', 'lounge', v(2.4, -0.488, -6.1), yaw(100), 'loose'),
  // cabins: a tablet on each desk's magnetic pad, a book on each bunk, a pen on the starboard desk
  p('tablet-port', 'tablet', 'cabin-port', v(-1.45, -0.2435, -4.3), yaw(-10), 'magnet', 4),
  p('book-port', 'book', 'cabin-port', v(-2.4, -0.433, -3.0), yaw(35), 'loose'),
  p('tablet-stbd', 'tablet', 'cabin-stbd', v(1.45, -0.2435, -4.3), yaw(12), 'magnet', 4),
  p('book-stbd', 'book', 'cabin-stbd', v(2.4, -0.433, -3.0), yaw(-25), 'loose'),
  p('pen', 'pen', 'cabin-stbd', v(1.25, -0.2425, -4.2), ALONG_X, 'loose'),
  // suit room: the helmet clipped to the bench
  p('helmet', 'helmet', 'suitroom', v(1.7, -0.393, 1.375), Q0, 'clip', 40),
  // engineering workbench: toolbox strapped down, a spanner on the magnetic tool board, one left out, a torch
  p('toolbox', 'toolbox', 'engineering', v(2.1, 0.062, 11.4), yaw(90), 'strap', 400),
  p('spanner-1', 'spanner', 'engineering', v(2.1, -0.042, 10.65), Q0, 'magnet', 8),
  p('spanner-2', 'spanner', 'engineering', v(1.97, -0.042, 10.95), yaw(30), 'loose'),
  p('torch', 'torch', 'engineering', v(2.25, -0.029, 11.0), ALONG_Z, 'clip', 6),
  // cargo bay: crates strapped to the deck rings (one small crate stacked and strapped), one left unsecured
  p('crate-L1', 'crateLarge', 'cargo', v(-1.45, -0.698, 4.5), Q0, 'strap', 2000),
  p('crate-L2', 'crateLarge', 'cargo', v(-1.45, -0.698, 5.3), Q0, 'strap', 2000),
  p('crate-S1', 'crateSmall', 'cargo', v(-1.45, -0.198, 4.5), Q0, 'strap', 1000),
  p('crate-S2', 'crateSmall', 'cargo', v(1.4, -0.798, 4.4), Q0, 'strap', 1000),
  p('crate-S3', 'crateSmall', 'cargo', v(1.2, -0.798, 6.2), yaw(12), 'loose'),
];

export const PROPS: Partial<Record<ShipVisualId, PropDef[]>> = { wren: WREN_PROPS };
