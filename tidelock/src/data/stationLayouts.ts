// Physical layouts of the six station archetypes: docking ports, coarse colliders, bounding radius and
// traffic-control zone. Pure data shared by the simulation (docking, collisions, traffic) and the renderer
// (render/space/stations.ts builds its geometry from the same numbers) — no three.js, no DOM.
//
// Station-local frame: metres, right-handed, +Y is the main (spin) axis. In the world, physics.stationAttitude
// puts +Y along the orbit normal and +X toward the orbit's periapsis. Azimuths in this file are measured
// from +X toward -Z (counter-clockwise seen from +Y): dir(az) = (cos az, 0, -sin az).
//
// Docking: a ship mates its own collar (ShipLayout.dockingPort) with a port's `pos`, collar axes opposed, and
// arrives along -dir. Every port stands on a berth: a deck plate `standoff` metres behind the mating point at
// the root of a docking arm, an approach frame around it and two guide booms (see BERTHS). The colliders stay
// behind the deck plates, so a cylinder of radius PAD_CLEARANCE[size] around the approach axis is free from
// the mating plane outward for well over 300 m, and a docked hull never touches a collider.
//
// Rotating sections (the habitat ring, the spindle drums) are visual only; their colliders describe the
// swept volume where that is rotation-symmetric (ring, drums) and the rest position otherwise (spokes).

import type { DockingPortDef, PadSize, StationCollider, StationLayout, StationVisualId, V3 } from '../core/types';

const DEG = Math.PI / 180;
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
/** Unit radial direction at azimuth `az` (rad). */
const radial = (az: number): V3 => v(Math.cos(az), 0, -Math.sin(az));
const clean = (n: number): number => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6);
const cleanV = (a: V3): V3 => v(clean(a.x), clean(a.y), clean(a.z));

/** Pad sizes in ascending order. A ship fits a pad of its own size or larger. */
export const PAD_ORDER: readonly PadSize[] = ['S', 'M', 'L'];
export const padFits = (ship: PadSize, pad: PadSize): boolean => PAD_ORDER.indexOf(ship) <= PAD_ORDER.indexOf(pad);

/** Radius, m, of the obstacle-free cylinder around a port's approach axis (covers the largest hull of that pad size). */
export const PAD_CLEARANCE: Record<PadSize, number> = { S: 10, M: 20, L: 37 };

/** Guaranteed length of the straight approach corridor along a port's `dir`, m. */
export const APPROACH_LENGTH = 320;

/** Geometry of a berth by pad size (all metres). */
export interface BerthDims {
  /** distance from the deck plate to the mating point along the port axis */
  standoff: number;
  /** half-size of the square deck plate behind the collar */
  plate: number;
  /** half-size of the square lit approach frame around the mating plane */
  frame: number;
  /** how far the frame stands beyond the mating plane along `dir` */
  frameOut: number;
  /** docking-arm radius */
  arm: number;
  /** length of the two guide-light booms beyond the frame */
  boom: number;
}
export const BERTHS: Record<PadSize, BerthDims> = {
  S: { standoff: 10, plate: 12, frame: 14, frameOut: 2.5, arm: 1.5, boom: 14 },
  M: { standoff: 20, plate: 22, frame: 26, frameOut: 5, arm: 2.3, boom: 26 },
  L: { standoff: 22, plate: 30, frame: 43, frameOut: 9, arm: 3.2, boom: 44 },
};

// ------------------------------------------------------------------------------------------------ dimensions
//
// The handful of numbers both the layout and the visual depend on. Everything else about a station's look is
// free (and seed-dependent) as long as it stays inside the colliders' rough envelope and out of the corridors.

export const RING_HABITAT = {
  /** ring cross-section: inner / outer radius and half-width along Y */
  ringInner: 395,
  ringOuter: 441,
  ringHalfWidth: 38,
  spokes: 6,
  /** azimuth of the first spoke at rest, rad */
  spokeAz0: 30 * DEG,
  /** rotor spin about +Y, rad/s (about 0.35 g at the rim) */
  spin: 0.09,
  /** de-spun docking drums on the hub: radius, |y| range and berth height */
  drumR: 64,
  drumY0: 110,
  drumY1: 190,
  portY: 150,
  /** |y| of the polar deck plates */
  poleDeckY: 240,
  /** rotor sleeve round the axle */
  sleeveR: 62,
  /** radiator vanes on the south drum: azimuths, radial reach */
  vaneAz: [0, 120 * DEG, 240 * DEG],
  vaneR1: 204,
} as const;

export const SPINDLE = {
  spineR: 22,
  /** counter-rotating drums: radius, |y| range, spin rad/s (the south drum turns the other way) */
  drumR: 95,
  drumY0: 15,
  drumY1: 105,
  spin: 0.12,
  /** docking tiers: [y, half-extent toward the ports, half-extent across, half-height] */
  tierL: [150, 46, 34, 35],
  tierM: [215, 36, 28, 25],
  tierS: [262, 26, 20, 16],
  /** container farm: |y| range (south), rack count and reach */
  farmY0: 125,
  farmY1: 285,
  racks: 6,
  rackR: 112,
} as const;

export const REFINERY = {
  /** deck: half-length (X), half-width (Z), half-thickness (Y) */
  deckX: 330,
  deckZ: 108,
  deckT: 8,
  /** radiator wings along both long edges: x extent, slope length, droop angle below the deck plane */
  wingX: 250,
  wingLen: 150,
  wingDroop: 35 * DEG,
  /** logistics pier at the +X end: centre and half-extents */
  pier: [284, 38, 0, 34, 30, 60],
  /** smelter stacks: x positions, z, top y */
  stackX: [-215, -170, -125],
  stackZ: -30,
  stackTop: 172,
  /** spherical tanks: [x, z] centres, radius, centre height */
  spheres: [
    [-52, 52],
    [-52, -52],
    [22, 52],
    [22, -52],
    [96, 52],
    [96, -52],
  ],
  sphereR: 32,
  sphereY: 46,
} as const;

export const OUTPOST = {
  trussHalf: 72,
  /** half-length of the pressurised cross along X */
  habHalf: 30,
  wingY: 54,
  wingReach: 66,
  radiatorY: -45,
  tankY: -30,
} as const;

export const DRYDOCK = {
  /** gantry half-extents: X, Y (long axis), Z */
  halfX: 130,
  halfY: 490,
  halfZ: 100,
  /** portal frames along Y */
  portals: [-480, -360, -240, -120, 0, 120, 240, 360, 480],
  /** hull under construction: y range and radius of its envelope */
  hullY0: -290,
  hullY1: 200,
  hullR: 40,
  /** yard office on the +X flank: centre x, y range, half-extent in x and z */
  officeX: 172,
  officeY0: 300,
  officeY1: 480,
  officeHalfX: 38,
  officeHalfZ: 40,
  /** travelling cranes: y positions of the bridges across the +Z side */
  cranes: [-210, -30, 140],
} as const;

export const CITADEL = {
  /** octagonal keep: apothem, half-height of the prism, tip of the end frusta, mast tip */
  keepR: 110,
  keepY: 120,
  capY: 188,
  mastY: 292,
  /** four bastion arms along +X, -Z, -X, +Z: root radius, tip radius */
  armR0: 96,
  armR1: 400,
} as const;

// ------------------------------------------------------------------------------------------------ builders

function port(id: string, size: PadSize, pos: V3, dir: V3, up: V3): DockingPortDef {
  return { id, pos: cleanV(pos), dir: cleanV(dir), up: cleanV(up), size };
}

/** Radial port standing `standoff` beyond a deck plate at radius `deckR`, height `y`, azimuth `az`. */
function radialPort(id: string, size: PadSize, deckR: number, y: number, az: number): DockingPortDef {
  const d = radial(az);
  const r = deckR + BERTHS[size].standoff;
  return port(id, size, v(d.x * r, y, d.z * r), d, v(0, 1, 0));
}

/** Port on an axis-aligned face: the deck plate passes through `deck`, the port stands off along `dir`. */
function facePort(id: string, size: PadSize, deck: V3, dir: V3, up: V3): DockingPortDef {
  const s = BERTHS[size].standoff;
  return port(id, size, v(deck.x + dir.x * s, deck.y + dir.y * s, deck.z + dir.z * s), dir, up);
}

const sphere = (x: number, y: number, z: number, radius: number): StationCollider => ({ kind: 'sphere', a: v(clean(x), clean(y), clean(z)), radius });
const capsule = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number): StationCollider => ({
  kind: 'capsule',
  a: v(clean(ax), clean(ay), clean(az)),
  b: v(clean(bx), clean(by), clean(bz)),
  radius,
});

/** Closed loop of `n` capsules approximating a torus of radius R round the Y axis at height y. */
function torus(out: StationCollider[], R: number, y: number, tube: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push(capsule(Math.cos(a0) * R, y, -Math.sin(a0) * R, Math.cos(a1) * R, y, -Math.sin(a1) * R, tube));
  }
}

function ringHabitat(): StationLayout {
  const D = RING_HABITAT;
  const deckR = D.drumR + 2;
  const ports: DockingPortDef[] = [
    facePort('N1', 'L', v(0, D.poleDeckY, 0), v(0, 1, 0), v(1, 0, 0)),
    radialPort('N2', 'M', deckR, D.portY, 0),
    radialPort('N3', 'M', deckR, D.portY, 120 * DEG),
    radialPort('N4', 'S', deckR, D.portY, 240 * DEG),
    facePort('S1', 'L', v(0, -D.poleDeckY, 0), v(0, -1, 0), v(1, 0, 0)),
    radialPort('S2', 'M', deckR, -D.portY, 60 * DEG),
    radialPort('S3', 'M', deckR, -D.portY, 180 * DEG),
    radialPort('S4', 'S', deckR, -D.portY, 300 * DEG),
  ];
  const c: StationCollider[] = [];
  // hub: axle, rotor sleeve, the two docking drums and the polar stacks under the axial decks
  c.push(capsule(0, -128, 0, 0, 128, 0, 46));
  c.push(sphere(0, 0, 0, 68));
  for (const s of [1, -1]) {
    c.push(capsule(0, s * 128, 0, 0, s * 172, 0, D.drumR + 2));
    c.push(capsule(0, s * 196, 0, 0, s * 212, 0, 27));
  }
  // antenna farm on the north shoulder
  for (const az of [60, 180, 300]) {
    const d = radial(az * DEG);
    c.push(sphere(d.x * 50, 212, d.z * 50, 18));
  }
  // radiator vanes on the south drum
  for (const az of D.vaneAz) {
    const d = radial(az);
    for (const y of [-174, -150, -126]) c.push(capsule(d.x * 72, y, d.z * 72, d.x * (D.vaneR1 - 6), y, d.z * (D.vaneR1 - 6), 13));
  }
  // the ring (swept volume) and the spokes at rest
  torus(c, (D.ringInner + D.ringOuter) / 2, 0, 46, 24);
  for (let k = 0; k < D.spokes; k++) {
    const d = radial(D.spokeAz0 + (k * Math.PI * 2) / D.spokes);
    c.push(capsule(d.x * 66, 0, d.z * 66, d.x * (D.ringInner - 4), 0, d.z * (D.ringInner - 4), 9));
  }
  return { visualId: 'ringHabitat', radius: 465, ports, colliders: c, controlZone: 6000 };
}

function spindle(): StationLayout {
  const D = SPINDLE;
  const X = v(1, 0, 0);
  const Y = v(0, 1, 0);
  const ports: DockingPortDef[] = [
    facePort('A1', 'L', v(D.tierL[1] + 2, D.tierL[0], 0), X, Y),
    facePort('A2', 'L', v(-D.tierL[1] - 2, D.tierL[0], 0), v(-1, 0, 0), Y),
    facePort('B1', 'M', v(0, D.tierM[0], -D.tierM[1] - 2), v(0, 0, -1), Y),
    facePort('B2', 'M', v(0, D.tierM[0], D.tierM[1] + 2), v(0, 0, 1), Y),
    facePort('C1', 'S', v(D.tierS[1] + 2, D.tierS[0], 0), X, Y),
    facePort('C2', 'S', v(-D.tierS[1] - 2, D.tierS[0], 0), v(-1, 0, 0), Y),
  ];
  const c: StationCollider[] = [];
  c.push(capsule(0, -270, 0, 0, 274, 0, 26)); // spine, engine block and mast
  c.push(capsule(-16, D.tierL[0], 0, 16, D.tierL[0], 0, 33));
  c.push(capsule(0, D.tierM[0], -14, 0, D.tierM[0], 14, 25));
  c.push(capsule(-10, D.tierS[0], 0, 10, D.tierS[0], 0, 17));
  // drums: swept volume as two hexagonal loops of fat capsules
  torus(c, 55, (D.drumY0 + D.drumY1) / 2, 45, 6);
  torus(c, 55, -(D.drumY0 + D.drumY1) / 2, 45, 6);
  // container racks
  for (let k = 0; k < D.racks; k++) {
    const d = radial((k * Math.PI * 2) / D.racks);
    for (const y of [-150, -205, -260]) c.push(capsule(d.x * 30, y, d.z * 30, d.x * (D.rackR - 8), y, d.z * (D.rackR - 8), 28));
  }
  return { visualId: 'spindle', radius: 315, ports, colliders: c, controlZone: 5000 };
}

function refinery(): StationLayout {
  const D = REFINERY;
  const [px, py, pz, hx, hy, hz] = D.pier;
  const ports: DockingPortDef[] = [
    facePort('D1', 'L', v(px + hx + 2, py, pz), v(1, 0, 0), v(0, 1, 0)),
    facePort('D2', 'L', v(px, py + hy + 2, pz), v(0, 1, 0), v(1, 0, 0)),
    facePort('D3', 'M', v(px, py + 6, pz + hz + 2), v(0, 0, 1), v(0, 1, 0)),
    facePort('D4', 'M', v(px, py + 6, pz - hz - 2), v(0, 0, -1), v(0, 1, 0)),
  ];
  const c: StationCollider[] = [];
  // deck: six parallel beams
  for (const z of [-90, -54, -18, 18, 54, 90]) c.push(capsule(-D.deckX + 16, 0, z, D.deckX - 16, 0, z, 18));
  // pier block
  c.push(capsule(px, py, pz - 30, px, py, pz + 30, 31));
  // spherical tanks
  for (const [x, z] of D.spheres) c.push(sphere(x, D.sphereY, z, D.sphereR + 2));
  // smelter hall and its stacks
  c.push(capsule(-235, 36, -30, -105, 36, -30, 38));
  for (const x of D.stackX) c.push(capsule(x, 70, D.stackZ, x, D.stackTop - 10, D.stackZ, 11));
  // bullet tanks and fractionating columns
  c.push(capsule(140, 36, 42, 236, 36, 42, 30));
  c.push(capsule(140, 36, -42, 236, 36, -42, 30));
  for (const x of [150, 188, 226]) c.push(capsule(x, 20, 0, x, 128, 0, 9));
  // ore reception: bins and the conveyor gallery to the smelter
  c.push(sphere(-296, 34, 46, 30));
  c.push(sphere(-296, 34, -46, 30));
  c.push(capsule(-290, 30, 20, -236, 62, -24, 9));
  // radiator wings: three beams down each slope
  const cs = Math.cos(D.wingDroop);
  const sn = Math.sin(D.wingDroop);
  for (const s of [1, -1]) {
    for (const t of [24, 72, 122]) c.push(capsule(-D.wingX + 14, -4 - sn * t, s * (D.deckZ + 4 + cs * t), D.wingX - 14, -4 - sn * t, s * (D.deckZ + 4 + cs * t), 22));
  }
  return { visualId: 'refinery', radius: 415, ports, colliders: c, controlZone: 5000 };
}

function outpost(): StationLayout {
  const D = OUTPOST;
  const ports: DockingPortDef[] = [
    facePort('P1', 'M', v(0, 0, 10), v(0, 0, 1), v(0, 1, 0)),
    facePort('P2', 'S', v(0, 0, -10), v(0, 0, -1), v(0, 1, 0)),
  ];
  const c: StationCollider[] = [
    capsule(0, -D.trussHalf + 6, 0, 0, D.trussHalf - 6, 0, 6),
    capsule(-D.habHalf, 0, 0, D.habHalf, 0, 0, 8),
    capsule(10, D.wingY, 0, D.wingReach - 8, D.wingY, 0, 9),
    capsule(-10, D.wingY, 0, -D.wingReach + 8, D.wingY, 0, 9),
    capsule(8, D.radiatorY, 0, 32, D.radiatorY, 0, 7),
    capsule(-8, D.radiatorY, 0, -32, D.radiatorY, 0, 7),
    sphere(0, D.tankY, 0, 17),
    sphere(0, D.trussHalf - 2, 0, 13),
  ];
  return { visualId: 'outpost', radius: 95, ports, colliders: c, controlZone: 2000 };
}

function drydock(): StationLayout {
  const D = DRYDOCK;
  const X = v(1, 0, 0);
  const Y = v(0, 1, 0);
  const faceX = D.officeX + D.officeHalfX + 2;
  const faceZ = D.officeHalfZ + 2;
  const ports: DockingPortDef[] = [
    facePort('Y1', 'L', v(faceX, 435, 0), X, Y),
    facePort('Y2', 'L', v(faceX, 345, 0), X, Y),
    facePort('Y3', 'M', v(D.officeX, 440, faceZ), v(0, 0, 1), Y),
    facePort('Y4', 'M', v(D.officeX, 440, -faceZ), v(0, 0, -1), Y),
    facePort('Y5', 'S', v(D.officeX, 340, faceZ), v(0, 0, 1), Y),
  ];
  const c: StationCollider[] = [];
  // four longerons
  for (const sx of [1, -1]) for (const sz of [1, -1]) c.push(capsule(sx * D.halfX, -D.halfY, sz * D.halfZ, sx * D.halfX, D.halfY, sz * D.halfZ, 12));
  // portal frames
  for (const y of D.portals) {
    for (const sz of [1, -1]) c.push(capsule(-D.halfX, y, sz * D.halfZ, D.halfX, y, sz * D.halfZ, 9));
    for (const sx of [1, -1]) c.push(capsule(sx * D.halfX, y, -D.halfZ, sx * D.halfX, y, D.halfZ, 9));
  }
  // hull on the slip, yard office, travelling cranes
  c.push(capsule(0, D.hullY0 + D.hullR, 0, 0, D.hullY1 - D.hullR, 0, D.hullR));
  c.push(capsule(D.officeX, D.officeY0 + 36, 0, D.officeX, D.officeY1 - 36, 0, 38));
  for (const y of D.cranes) c.push(capsule(-D.halfX, y, D.halfZ + 6, D.halfX, y, D.halfZ + 6, 11));
  return { visualId: 'drydock', radius: 545, ports, colliders: c, controlZone: 6000 };
}

function citadel(): StationLayout {
  const D = CITADEL;
  const deckR = D.keepR + 2;
  const ports: DockingPortDef[] = [
    radialPort('H1', 'L', deckR, 0, 45 * DEG),
    radialPort('H2', 'M', deckR, 0, 135 * DEG),
    radialPort('H3', 'L', deckR, 0, 225 * DEG),
    radialPort('H4', 'M', deckR, 0, 315 * DEG),
  ];
  const c: StationCollider[] = [];
  c.push(capsule(0, -70, 0, 0, 70, 0, D.keepR + 2));
  for (const s of [1, -1]) c.push(capsule(0, s * 176, 0, 0, s * (D.mastY - 10), 0, 10));
  for (let k = 0; k < 4; k++) {
    const d = radial((k * Math.PI) / 2);
    c.push(capsule(d.x * 100, 0, d.z * 100, d.x * 236, 0, d.z * 236, 44));
    c.push(capsule(d.x * 236, 0, d.z * 236, d.x * (D.armR1 - 30), 0, d.z * (D.armR1 - 30), 30));
  }
  return { visualId: 'citadel', radius: 420, ports, colliders: c, controlZone: 8000 };
}

export const STATION_LAYOUTS: Record<StationVisualId, StationLayout> = {
  ringHabitat: ringHabitat(),
  spindle: spindle(),
  refinery: refinery(),
  outpost: outpost(),
  drydock: drydock(),
  citadel: citadel(),
};
