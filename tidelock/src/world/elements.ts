// Osculating orbit read-outs derived from the state relative to the primary body. Information for the pilot:
// nothing in here is ever fed back into the motion.

import { airDensity } from './atmosphere';
import { findCraft, type World } from './state';

export interface Elements {
  /** Semi-major axis, m (negative on a hyperbola). */
  a: number;
  e: number;
  /** Inclination to the reference plane (XZ), rad. */
  i: number;
  /** Periapsis and apoapsis radius, m (apoapsis Infinity when unbound). */
  periapsis: number;
  apoapsis: number;
  /** Period, s (Infinity when unbound). */
  period: number;
  /** Seconds to the next periapsis / apoapsis (Infinity when it will not come). */
  timeToPeriapsis: number;
  timeToApoapsis: number;
}

export const newElements = (): Elements => ({ a: 0, e: 0, i: 0, periapsis: 0, apoapsis: 0, period: 0, timeToPeriapsis: 0, timeToApoapsis: 0 });

const TAU = 2 * Math.PI;

/** Osculating elements of a state (position, velocity relative to a body of gravitational parameter mu). */
export function osculating(mu: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, out: Elements): Elements {
  const r = Math.sqrt(x * x + y * y + z * z), v2 = vx * vx + vy * vy + vz * vz, rv = x * vx + y * vy + z * vz;
  const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
  const k = v2 - mu / r;
  const ex = (k * x - rv * vx) / mu, ey = (k * y - rv * vy) / mu, ez = (k * z - rv * vz) / mu;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const energy = v2 / 2 - mu / r;
  const a = Math.abs(energy) > 1e-12 ? -mu / (2 * energy) : Infinity;
  out.a = a;
  out.e = e;
  out.i = h > 0 ? Math.acos(Math.max(-1, Math.min(1, hy / h))) : 0;
  out.periapsis = Number.isFinite(a) ? a * (1 - e) : (h * h) / (2 * mu);
  if (e < 1 && a > 0) {
    const n = Math.sqrt(mu / (a * a * a));
    out.apoapsis = a * (1 + e);
    out.period = TAU / n;
    let M = 0;
    if (e > 1e-10) {
      let E = Math.acos(Math.max(-1, Math.min(1, (1 - r / a) / e)));
      if (rv < 0) E = TAU - E;
      M = E - e * Math.sin(E);
    }
    out.timeToPeriapsis = M > 0 ? (TAU - M) / n : 0;
    out.timeToApoapsis = (M <= Math.PI ? Math.PI - M : 3 * Math.PI - M) / n;
  } else {
    out.apoapsis = Infinity;
    out.period = Infinity;
    out.timeToApoapsis = Infinity;
    if (rv < 0 && Number.isFinite(a) && e > 1) {
      const H = Math.acosh(Math.max(1, (1 - r / a) / e));
      out.timeToPeriapsis = (e * Math.sinh(H) - H) / Math.sqrt(mu / (-a * a * a));
    } else {
      out.timeToPeriapsis = Infinity;
    }
  }
  return out;
}

export type Situation = 'docked' | 'landed' | 'orbit' | 'suborbital' | 'escape' | 'atmosphere' | 'destroyed';

export interface FlightReadout {
  /** Index and id of the primary body. */
  primary: number;
  primaryId: string;
  situation: Situation;
  altitude: number;
  /** Speed relative to the primary, m/s; rate of change of altitude; speed relative to the rotating surface / air. */
  speed: number;
  verticalSpeed: number;
  surfaceSpeed: number;
  apoapsisAlt: number;
  periapsisAlt: number;
  timeToApoapsis: number;
  timeToPeriapsis: number;
  period: number;
  inclination: number;
  eccentricity: number;
  /** Proper acceleration felt on board, m/s². */
  accel: number;
  airDensity: number;
  dynamicPressure: number;
}

const EL = newElements();
const READ: FlightReadout = {
  primary: 0, primaryId: '', situation: 'orbit', altitude: 0, speed: 0, verticalSpeed: 0, surfaceSpeed: 0, apoapsisAlt: 0, periapsisAlt: 0,
  timeToApoapsis: 0, timeToPeriapsis: 0, period: 0, inclination: 0, eccentricity: 0, accel: 0, airDensity: 0, dynamicPressure: 0,
};

/** Flight read-outs of a craft relative to its primary. The returned object is reused: do not keep it. */
export function flightReadout(world: World, craftId: string, out: FlightReadout = READ): FlightReadout {
  const c = findCraft(world, craftId);
  if (!c) return out;
  const b = world.bodies[c.primary];
  const x = c.rel.x, y = c.rel.y, z = c.rel.z, vx = c.relV.x, vy = c.relV.y, vz = c.relV.z;
  const r = Math.sqrt(x * x + y * y + z * z);
  osculating(b.mu, x, y, z, vx, vy, vz, EL);
  const w = b.spinRate, n = b.spinAxis;
  const ux = vx - w * (n.y * z - n.z * y), uy = vy - w * (n.z * x - n.x * z), uz = vz - w * (n.x * y - n.y * x);
  const top = b.radius + (b.atmosphere ? b.atmosphere.height : 0);
  out.primary = c.primary;
  out.primaryId = b.id;
  out.altitude = r - b.radius;
  out.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  out.verticalSpeed = (x * vx + y * vy + z * vz) / r;
  out.surfaceSpeed = Math.sqrt(ux * ux + uy * uy + uz * uz);
  out.apoapsisAlt = EL.apoapsis - b.radius;
  out.periapsisAlt = EL.periapsis - b.radius;
  out.timeToApoapsis = EL.timeToApoapsis;
  out.timeToPeriapsis = EL.timeToPeriapsis;
  out.period = EL.period;
  out.inclination = EL.i;
  out.eccentricity = EL.e;
  out.accel = c.load;
  out.airDensity = b.atmosphere ? airDensity(b.atmosphere, out.altitude) : 0;
  out.dynamicPressure = 0.5 * out.airDensity * out.surfaceSpeed * out.surfaceSpeed;
  out.situation = c.destroyed ? 'destroyed'
    : c.dockedTo !== null ? 'docked'
    : c.landedOn !== null ? 'landed'
    : r < top ? 'atmosphere'
    : EL.e >= 1 || EL.apoapsis > b.hill ? 'escape'
    : EL.periapsis < top ? 'suborbital'
    : 'orbit';
  return out;
}
