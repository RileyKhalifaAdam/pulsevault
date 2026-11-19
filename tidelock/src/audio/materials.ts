// Material constants and the vibrating construction of every prop type and every surface, for the modal
// impact sounds. Pure data and closed-form mechanics: no DOM, runs in node.
//
// Until W1-C adds E, ρ, ν, η and dimensions to src/data/props.ts (§W1-C "material constants for audio"),
// this table is the source; when it lands, `PROP_CONSTRUCTION` reads from there and this file keeps only the
// formulas. Values are handbook figures (room temperature); material loss factors η follow docs/SIMULATION.md
// W1-D (aluminium 1e-4–1e-3, ceramic 1e-3, ABS 0.02, card 0.05–0.1). A contained liquid or soil adds mass and
// damping; that is written per prop. The modal bake adds each body's radiation loss (modal.ts).
//
// Installed panels are not bare alloy: a deck panel bolted to the frames loses energy at its joints (fretting
// at the fasteners, the floor fittings), which for built-up riveted/bolted structures is η ≈ 1e-2 (Cremer–Heckl;
// Beranek & Vér give 1e-2–1e-1 for joined structures) against 1e-4–1e-3 for the bare plate. With the plan's
// bare-alloy 1e-3 the deck rang 2–15 s and every hit's decay was the buffer's fade. FLAGGED for the plan owner:
// W1-D's "deck panels are aluminium … η 1e-4–1e-3" is the material value; the panel uses ETA_INSTALLED.

import { PROP_TYPES, type PropType } from '../data/props';
import { MAT } from '../world/events';

export interface Material {
  /** Young's modulus, Pa; density, kg/m³; Poisson's ratio; loss factor. */
  E: number;
  rho: number;
  nu: number;
  eta: number;
}

/** Indexed by the MAT codes of src/world/events.ts. */
export const MATERIALS: readonly Material[] = [
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

/** Longitudinal plate wave speed c_L = √(E / (ρ(1 − ν²))), m/s. */
export const plateWaveSpeed = (m: Material): number => Math.sqrt(m.E / (m.rho * (1 - m.nu * m.nu)));

/**
 * Simply supported rectangular plate, mode (m, n): f = 0.453·c_L·h·((m/Lx)² + (n/Ly)²), Hz.
 * (0.453 = π/(2√12), from √(D/ρh) with D = E h³ / 12(1 − ν²).)
 */
export const plateModeHz = (mat: Material, h: number, Lx: number, Ly: number, m: number, n: number): number =>
  0.453 * plateWaveSpeed(mat) * h * ((m / Lx) * (m / Lx) + (n / Ly) * (n / Ly));

/** Free–free Euler–Bernoulli bar: β_n·L roots of cos βL · cosh βL = 1. */
export const FREE_FREE_BETA_L = [4.73004074, 7.85320462, 10.99560784, 14.13716549, 17.27875966, 20.42035225];

/** Bar mode n (0-based): f_n = (β_n² / 2π)·√(EI / (ρ A L⁴)), Hz. */
export const barModeHz = (mat: Material, I: number, A: number, L: number, n: number): number => {
  const bl = FREE_FREE_BETA_L[n];
  return ((bl * bl) / (2 * Math.PI)) * Math.sqrt((mat.E * I) / (mat.rho * A * L * L * L * L));
};

/**
 * Thin ring / short cylindrical shell, in-plane bending mode n ≥ 2 (Rayleigh):
 * f_n = (1/2π)·(h/R²)·√(E / (12ρ(1 − ν²)))·n(n² − 1)/√(n² + 1), Hz.
 */
export const ringModeHz = (mat: Material, h: number, R: number, n: number): number =>
  (1 / (2 * Math.PI)) * (h / (R * R)) * Math.sqrt(mat.E / (12 * mat.rho * (1 - mat.nu * mat.nu))) * ((n * (n * n - 1)) / Math.sqrt(n * n + 1));

/** How a body vibrates: the geometry the mode formulas take. */
export type Construction =
  | { kind: 'plate'; mat: number; h: number; Lx: number; Ly: number }
  | { kind: 'bar'; mat: number; I: number; A: number; L: number }
  | { kind: 'ring'; mat: number; h: number; R: number };

export interface PropAcoustics {
  /** The prop's own vibrating structure. */
  body: Construction;
  /** Loss factor of the assembled object (its material plus contents, lids, joints). */
  eta: number;
  /** Added (non-structural) mass over structural mass: a liquid or soil load lowers f by 1/√(1 + ratio). */
  addedMass: number;
  /** Mass of the vibrating structure, kg (the rest of the prop's mass is contents). */
  structMass: number;
  /** Material of the contacting surface (Hertz E*), and the radius of curvature that touches, m. */
  contactMat: number;
  contactR: number;
  /** Size of the radiator, m (radiation efficiency (ka)² below ka = 1). */
  size: number;
  /** Extra loose parts inside (a toolbox's tools): count of small steel bars that rattle. */
  rattle: number;
}

const tube = (ro: number, wall: number): { I: number; A: number } => {
  const ri = ro - wall;
  return { I: (Math.PI / 4) * (ro ** 4 - ri ** 4), A: Math.PI * (ro * ro - ri * ri) };
};

/**
 * Acoustic construction of each prop type (dimensions from src/data/props.ts shapes). 'body' is a pseudo-type
 * for the crew body (80 kg, soft tissue in clothes): it thumps the deck and has no ring of its own.
 */
export type AcousticPropType = PropType | 'body';
export const ACOUSTIC_TYPES: readonly AcousticPropType[] = [
  'mug', 'bottle', 'tablet', 'book', 'pen', 'foodpack', 'toolbox', 'spanner', 'torch', 'pillow', 'crateSmall',
  'crateLarge', 'helmet', 'plantpot', 'body',
];

export const PROP_ACOUSTICS: Record<AcousticPropType, PropAcoustics> = {
  // double-wall stainless travel mug (0.8 mm walls, R 42 mm) holding 0.3 L of coffee
  mug: { body: { kind: 'ring', mat: MAT.steel, h: 0.0008, R: 0.042 }, eta: 0.012, addedMass: 1.5, structMass: 0.1, contactMat: MAT.steel, contactR: 0.003, size: 0.084, rattle: 0 },
  // copolyester bottle, 1.5 mm wall, full of water
  bottle: { body: { kind: 'ring', mat: MAT.polymer, h: 0.0015, R: 0.038 }, eta: 0.04, addedMass: 6, structMass: 0.1, contactMat: MAT.polymer, contactR: 0.038, size: 0.25, rattle: 0 },
  // aluminium-and-glass tablet: a stiff 25 × 17 cm plate (6 mm effective bending thickness, glued stack)
  tablet: { body: { kind: 'plate', mat: MAT.aluminium, h: 0.006, Lx: 0.25, Ly: 0.17 }, eta: 0.012, addedMass: 0.3, structMass: 0.4, contactMat: MAT.aluminium, contactR: 0.004, size: 0.25, rattle: 0 },
  // hardback: 3 mm board covers over a paper block
  book: { body: { kind: 'plate', mat: MAT.card, h: 0.003, Lx: 0.22, Ly: 0.15 }, eta: 0.08, addedMass: 3, structMass: 0.15, contactMat: MAT.card, contactR: 0.002, size: 0.22, rattle: 0 },
  // ABS stylus, 11 mm solid rod, 15 cm
  pen: { body: { kind: 'bar', mat: MAT.polymer, I: (Math.PI / 4) * 0.0055 ** 4, A: Math.PI * 0.0055 ** 2, L: 0.141 }, eta: 0.02, addedMass: 0, structMass: 0.012, contactMat: MAT.polymer, contactR: 0.0055, size: 0.14, rattle: 0 },
  // laminated foil pouch of food: almost all damping
  foodpack: { body: { kind: 'plate', mat: MAT.card, h: 0.001, Lx: 0.14, Ly: 0.1 }, eta: 0.2, addedMass: 20, structMass: 0.02, contactMat: MAT.card, contactR: 0.02, size: 0.14, rattle: 0 },
  // 1 mm steel box, 44 × 22 cm side panel, full of tools that rattle
  toolbox: { body: { kind: 'plate', mat: MAT.steel, h: 0.001, Lx: 0.44, Ly: 0.22 }, eta: 0.006, addedMass: 0.2, structMass: 2.5, contactMat: MAT.steel, contactR: 0.003, size: 0.44, rattle: 5 },
  // drop-forged steel combination spanner, 17 × 6 mm section, 22 cm
  spanner: { body: { kind: 'bar', mat: MAT.steel, I: (0.017 * 0.006 ** 3) / 12, A: 0.017 * 0.006, L: 0.22 }, eta: 3e-4, addedMass: 0, structMass: 0.3, contactMat: MAT.steel, contactR: 0.003, size: 0.22, rattle: 0 },
  // aluminium torch tube, 38 mm, 1.5 mm wall, 19 cm, with cells inside (damping)
  torch: { body: { kind: 'bar', mat: MAT.aluminium, ...tube(0.019, 0.0015), L: 0.188 }, eta: 0.004, addedMass: 2, structMass: 0.08, contactMat: MAT.aluminium, contactR: 0.019, size: 0.19, rattle: 0 },
  // foam cushion: no ring, a muffled push
  pillow: { body: { kind: 'plate', mat: MAT.foam, h: 0.12, Lx: 0.4, Ly: 0.3 }, eta: 0.3, addedMass: 0, structMass: 0.45, contactMat: MAT.foam, contactR: 0.06, size: 0.4, rattle: 0 },
  // composite crates (4 mm and 6 mm panels), loaded: contents damp the panels
  crateSmall: { body: { kind: 'plate', mat: MAT.composite, h: 0.004, Lx: 0.6, Ly: 0.4 }, eta: 0.03, addedMass: 2, structMass: 6, contactMat: MAT.composite, contactR: 0.005, size: 0.6, rattle: 0 },
  crateLarge: { body: { kind: 'plate', mat: MAT.composite, h: 0.006, Lx: 1.0, Ly: 0.6 }, eta: 0.03, addedMass: 2, structMass: 20, contactMat: MAT.composite, contactR: 0.005, size: 1.0, rattle: 0 },
  // polycarbonate suit helmet shell, 3 mm, R 155 mm (ring approximation of the shell's bending modes)
  helmet: { body: { kind: 'ring', mat: MAT.polymer, h: 0.003, R: 0.155 }, eta: 0.03, addedMass: 0.5, structMass: 1.0, contactMat: MAT.polymer, contactR: 0.155, size: 0.31, rattle: 0 },
  // glazed ceramic pot, 8 mm wall, R 90 mm, full of damp soil
  plantpot: { body: { kind: 'ring', mat: MAT.ceramic, h: 0.008, R: 0.09 }, eta: 0.06, addedMass: 1.5, structMass: 1.0, contactMat: MAT.ceramic, contactR: 0.01, size: 0.18, rattle: 0 },
  // the crew body: soft tissue in clothes, no ring
  body: { body: { kind: 'plate', mat: MAT.tissue, h: 0.2, Lx: 0.5, Ly: 0.3 }, eta: 0.3, addedMass: 0, structMass: 80, contactMat: MAT.tissue, contactR: 0.08, size: 0.5, rattle: 0 },
};

/** Structural loss factor of a panel bolted into the ship's frames (joint damping; radiation loss is added in the bake). */
export const ETA_INSTALLED = 0.01;

/** Surfaces a prop can strike: the deck (aluminium 2 mm, 0.6 × 0.6 m, per the plan) and the interior lining. */
export type SurfaceId = 'deck' | 'lining';
export const SURFACES: readonly SurfaceId[] = ['deck', 'lining'];
export const SURFACE_PANEL: Record<SurfaceId, { mat: number; h: number; Lx: number; Ly: number; eta: number }> = {
  deck: { mat: MAT.aluminium, h: 0.002, Lx: 0.6, Ly: 0.6, eta: ETA_INSTALLED },
  // glass-fibre lining panel, 3 mm, 0.8 × 0.6 m on soft (elastomer) mounts: the resin's 0.01 plus the mounts'
  lining: { mat: MAT.composite, h: 0.003, Lx: 0.8, Ly: 0.6, eta: 0.02 },
};

/** Which surface buffer a struck material uses (glass, foam and fittings ride on the lining panels). */
export function surfaceFor(matCode: number): SurfaceId {
  return matCode === MAT.aluminium || matCode === MAT.steel ? 'deck' : 'lining';
}

/**
 * Radiating area of a type, m²: half the surface of its collision shape in src/data/props.ts (a vibrating body
 * pushes air with the faces moving outward; for a mode that is about half its surface). The crew body: 0.9 m²
 * (half of 1.8 m² of skin). Used both for the radiated pressure √(σS) and the radiation loss ρ₀cσS/(ωM).
 */
export function radiatingArea(type: AcousticPropType): number {
  if (type === 'body') return 0.9;
  const sh = PROP_TYPES[type].shape;
  if (sh.kind === 'sphere') return 2 * Math.PI * sh.r * sh.r;
  if (sh.kind === 'capsule') return Math.PI * sh.r * (2 * sh.halfLen) + 2 * Math.PI * sh.r * sh.r;
  const h = sh.half;
  return 4 * (h.x * h.y + h.y * h.z + h.x * h.z);
}

/** Coulomb friction coefficient of a type (src/data/props.ts); the crew body in clothes on a deck: 0.6 (no data yet). */
export function frictionOf(type: AcousticPropType): number {
  return type === 'body' ? 0.6 : PROP_TYPES[type].friction;
}

/** Hertz contact: E* = 1 / ((1 − ν₁²)/E₁ + (1 − ν₂²)/E₂). */
export function contactModulus(a: Material, b: Material): number {
  return 1 / ((1 - a.nu * a.nu) / a.E + (1 - b.nu * b.nu) / b.E);
}

/**
 * Hertz contact time τ_c = 2.87·(m*² / (R*·E*²·v))^(1/5), s. m* reduced mass (kg), R* radius (m), E* (Pa),
 * v normal approach speed (m/s). The force pulse has no energy much above 1/τ_c, so impacts are low-passed there.
 */
export function hertzContactTime(mStar: number, rStar: number, eStar: number, v: number): number {
  const vv = v > 1e-4 ? v : 1e-4;
  return 2.87 * Math.pow((mStar * mStar) / (rStar * eStar * eStar * vv), 0.2);
}
