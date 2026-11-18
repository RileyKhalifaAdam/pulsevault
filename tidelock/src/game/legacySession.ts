// TEMPORARY adapter: implements the Session contract (api.ts) on top of the old patched-conic GameSim so the
// client can be finished before the physical world (src/world) exists. Delete this file when the real session
// lands. Nothing here is physics worth keeping; things the old game cannot do return neutral values.
import { EventBus } from '../core/events';
import type { Quat, ShipVisualId, SystemDef, V3 } from '../core/types';
import { STATION_LAYOUTS } from '../data/stationLayouts';
import { SHIP_LAYOUTS } from '../data/shipLayouts';
import { createGame, loadGame, type GameSim } from '../sim/game';
import { newState, samplePatch } from '../sim/orbit';
import type { SasMode } from '../sim/physics';
import type {
  BodyView, CraftView, DockingView, FlightView, HoldMode, PlannedBurn, PlayerView, PredictionEvent, PredictionView, Session, SessionEvents,
  SessionOptions, StepInfo, TargetView, WarpLimit, WarpView,
} from './api';

const v3 = (): V3 => ({ x: 0, y: 0, z: 0 });
const N_PATCH = 96;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

class LegacySession implements Session {
  readonly events = new EventBus<SessionEvents>();
  system: SystemDef;
  private g: GameSim;
  private unbind: (() => void)[] = [];
  private bodyViews: BodyView[] = [];
  private craftViews: CraftView[] = [];
  private sv = newState();
  private sv2 = newState();
  private stepInfo: StepInfo = { simDt: 0, simMs: 0, steps: 0, limitedBy: '' };
  private warpView: WarpView = { requested: 1, achieved: 1, limitedBy: '' };
  private achieved = 1;
  private flightView = {} as FlightView;
  private playerView = {} as PlayerView;
  private targetView: TargetView = { id: '', name: '', kind: 'craft', distance: 0, relSpeed: 0, closing: 0, direction: v3(), relVelocity: v3() };
  private dockView: DockingView = { stationId: null, distance: Infinity, relSpeed: 0, portId: null, portOffset: v3(), portAxis: v3(), alignment: 0, lateral: 0, canLatch: false, dockedTo: null };
  private pred: PredictionView = { version: 0, frameBodyId: '', points: new Float64Array(4 * N_PATCH * 4), count: 0, targetPoints: new Float64Array(4 * N_PATCH), targetCount: 0, events: [], horizon: 0 };
  private predKey = '';
  private predFrame: string | null = null;
  private scratch = new Float64Array(3 * N_PATCH);
  private burnList: PlannedBurn[] = [];
  private lastThrottle = -1;
  private prevQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private spin = 0;

  constructor(g: GameSim) {
    this.g = g;
    this.system = g.system;
    this.bind();
  }

  private bind(): void {
    for (const off of this.unbind) off();
    const ev = this.g.events;
    const out = this.events;
    this.unbind = [
      ev.on('docked', (e) => out.emit('docked', { stationId: e.stationId, portId: e.portId })),
      ev.on('undocked', (e) => out.emit('undocked', { stationId: e.stationId })),
      ev.on('destroyed', (e) => out.emit('destroyed', { cause: e.cause })),
      ev.on('collision', (e) => out.emit('impact', { speed: e.speed, with: e.stationId })),
      ev.on('soiChanged', (e) => out.emit('primaryChanged', { from: e.fromBodyId, to: e.toBodyId })),
      ev.on('atmosphereEntered', (e) => out.emit('atmosphere', { bodyId: e.bodyId, entered: true })),
      ev.on('atmosphereExited', (e) => out.emit('atmosphere', { bodyId: e.bodyId, entered: false })),
    ];
    this.bodyViews = this.system.bodies.map((def) => ({ id: def.id, def, r: v3(), v: v3(), spinAxis: { x: 0, y: Math.cos(def.axialTilt), z: Math.sin(def.axialTilt) }, spinAngle: 0 }));
    const craft = (id: string, name: string, kind: 'ship' | 'station'): CraftView => ({
      id, name, kind, shipVisual: null, stationVisual: null, visualSeed: 0, r: v3(), v: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, throttle: 0, rcs: v3(), heat: 0, hull: 1, isPlayer: false, dockedTo: null, radius: 10,
    });
    this.craftViews = [craft('player', this.g.player().shipName, 'ship')];
    this.craftViews[0].isPlayer = true;
    this.craftViews[0].visualSeed = 7;
    for (const st of this.system.stations) {
      const c = craft(st.id, st.name, 'station');
      c.stationVisual = st.visualId;
      c.visualSeed = st.visualSeed;
      c.radius = STATION_LAYOUTS[st.visualId].radius;
      const pose = this.g.stationPose(st.id);
      if (pose) c.q = { ...pose.q };
      this.craftViews.push(c);
    }
    this.predKey = '';
    this.refresh();
  }

  /** Leave the berth and step past the release so the session starts flying free beside the station. */
  startFree(): void {
    const g = this.g;
    if (g.shipPose().docked) g.undock();
    for (let i = 0; i < 900 && (g.shipPose().docked || g.dockingState().transit !== null); i++) g.step(0.1);
    g.setWarp(1);
    this.refresh();
  }

  private refresh(): void {
    const g = this.g;
    const t = g.time();
    const sv = this.sv;
    for (const b of this.bodyViews) {
      g.model.bodyAbsState(b.id, t, sv);
      b.r.x = sv.r.x; b.r.y = sv.r.y; b.r.z = sv.r.z;
      b.v.x = sv.v.x; b.v.y = sv.v.y; b.v.z = sv.v.z;
      const period = Math.abs(b.def.rotationPeriod) > 1 ? b.def.rotationPeriod : 86400;
      b.spinAngle = (2 * Math.PI * t) / period;
    }
    const pose = g.shipPose();
    const fi = g.flightInfo();
    const d = g.dockingState();
    const p = this.craftViews[0];
    g.model.bodyAbsState(pose.soiBodyId, t, sv);
    p.r.x = sv.r.x + pose.r.x; p.r.y = sv.r.y + pose.r.y; p.r.z = sv.r.z + pose.r.z;
    p.v.x = sv.v.x + pose.v.x; p.v.y = sv.v.y + pose.v.y; p.v.z = sv.v.z + pose.v.z;
    p.q.x = pose.q.x; p.q.y = pose.q.y; p.q.z = pose.q.z; p.q.w = pose.q.w;
    p.throttle = pose.throttle;
    p.rcs.x = pose.rcs.x; p.rcs.y = pose.rcs.y; p.rcs.z = pose.rcs.z;
    p.heat = pose.heat;
    p.hull = pose.destroyed ? 0 : fi.hullFraction;
    p.dockedTo = pose.docked ? d.stationId : null;
    const shipId = g.player().shipId;
    p.shipVisual = (shipId in SHIP_LAYOUTS ? shipId : 'wren') as ShipVisualId;
    p.radius = SHIP_LAYOUTS[p.shipVisual].radius;
    for (let i = 1; i < this.craftViews.length; i++) {
      const c = this.craftViews[i];
      g.model.stationAbsState(c.id, t, sv);
      c.r.x = sv.r.x; c.r.y = sv.r.y; c.r.z = sv.r.z;
      c.v.x = sv.v.x; c.v.y = sv.v.y; c.v.z = sv.v.z;
    }
  }

  step(realDt: number): StepInfo {
    const g = this.g;
    const t0 = g.time();
    const w0 = now();
    g.step(realDt);
    const info = this.stepInfo;
    info.simMs = now() - w0;
    info.simDt = g.time() - t0;
    const w = g.warp();
    info.steps = Math.max(1, Math.round(Math.min(w.level, 100)));
    info.limitedBy = this.limit();
    if (realDt > 1e-4) this.achieved += (info.simDt / Math.min(realDt, 0.1) - this.achieved) * 0.2;
    const q = g.shipPose().q;
    const pq = this.prevQ;
    const dot = Math.min(1, Math.abs(q.x * pq.x + q.y * pq.y + q.z * pq.z + q.w * pq.w));
    if (info.simDt > 1e-6) this.spin = (2 * Math.acos(dot)) / info.simDt;
    pq.x = q.x; pq.y = q.y; pq.z = q.z; pq.w = q.w;
    this.refresh();
    return info;
  }
  time(): number {
    return this.g.time();
  }

  private limit(): WarpLimit {
    const w = this.g.warp();
    if (w.level >= w.requested || !w.limitReason) return '';
    const r = w.limitReason.toLowerCase();
    if (/dock|berth|tow/.test(r)) return 'docked';
    if (/atmos|air/.test(r)) return 'atmosphere';
    if (/thrust|burn|engine|drive|throttle/.test(r)) return 'thrust';
    if (/turn|rotat|spin/.test(r)) return 'rotation';
    return 'proximity';
  }
  warp(): WarpView {
    const w = this.g.warp();
    const v = this.warpView;
    v.requested = w.requested;
    v.achieved = Math.abs(this.achieved - w.level) < 0.05 * w.level ? w.level : this.achieved;
    v.limitedBy = this.limit();
    return v;
  }
  setWarp(m: number): void {
    this.g.setWarp(m);
  }
  warpUp(): void {
    this.g.warpUp();
  }
  warpDown(): void {
    this.g.warpDown();
  }

  setControls(c: { pitch?: number; yaw?: number; roll?: number; throttle?: number; translate?: V3 }): void {
    // The old sim treats a throttle value as player input only when it differs from the last one sent.
    if (c.throttle !== undefined) {
      if (c.throttle === this.lastThrottle) this.g.setControls({ throttle: c.throttle > 0.5 ? c.throttle - 0.002 : c.throttle + 0.002 });
      this.lastThrottle = c.throttle;
    }
    this.g.setControls(c);
  }
  setHold(mode: HoldMode): void {
    this.g.setSas((mode === 'burn' ? 'maneuver' : mode) as SasMode);
  }

  bodies(): readonly BodyView[] {
    return this.bodyViews;
  }
  craft(): readonly CraftView[] {
    return this.craftViews;
  }
  player(): PlayerView {
    const g = this.g;
    const fi = g.flightInfo();
    const pose = g.shipPose();
    const p = this.playerView;
    p.craftId = 'player';
    p.name = g.player().shipName;
    p.mass = fi.mass;
    p.propellant = fi.propellant;
    p.propellantFraction = fi.propellantFraction;
    p.deltaV = fi.deltaV;
    p.maxAccel = fi.maxAccel;
    p.throttle = fi.throttle;
    p.hold = fi.sasMode === 'maneuver' ? 'burn' : fi.sasMode === 'killRelative' ? 'stability' : fi.sasMode;
    p.heat = fi.heatFraction;
    p.hull = pose.destroyed ? 0 : fi.hullFraction;
    p.destroyed = pose.destroyed;
    p.destroyedBy = pose.destroyed ? 'impact or heat' : '';
    p.dockedTo = pose.docked ? g.dockingState().stationId : null;
    p.spin = pose.docked ? 0 : this.spin;
    return p;
  }
  flight(): FlightView {
    const fi = this.g.flightInfo();
    const f = this.flightView;
    f.primaryId = fi.soiBodyId;
    f.primaryName = fi.soiBodyName;
    f.situation = fi.situation;
    f.altitude = fi.altitude;
    f.speed = fi.orbitalSpeed;
    f.verticalSpeed = fi.verticalSpeed;
    f.surfaceSpeed = fi.surfaceSpeed;
    f.apoapsisAlt = fi.apoapsisAltitude;
    f.periapsisAlt = fi.periapsisAltitude;
    f.timeToApoapsis = fi.timeToApoapsis;
    f.timeToPeriapsis = fi.timeToPeriapsis;
    f.period = fi.period;
    f.inclination = fi.inclination;
    f.eccentricity = fi.eccentricity;
    f.accel = fi.throttle * fi.maxAccel;
    f.dynamicPressure = fi.dynamicPressure;
    const v = fi.surfaceSpeed;
    f.airDensity = v > 1 ? (2 * fi.dynamicPressure) / (v * v) : 0;
    return f;
  }

  setTarget(id: string | null): void {
    if (!id) this.g.setTarget(null);
    else if (this.system.stations.some((s) => s.id === id)) this.g.setTarget({ kind: 'station', id });
    else if (this.system.bodies.some((b) => b.id === id)) this.g.setTarget({ kind: 'body', id });
    this.predKey = '';
  }
  target(): TargetView | null {
    const ti = this.g.targetInfo();
    if (!ti) return null;
    const t = this.targetView;
    t.id = ti.ref.id;
    t.name = ti.name;
    t.kind = ti.ref.kind === 'body' ? 'body' : 'craft';
    t.distance = ti.distance;
    t.relSpeed = ti.relSpeed;
    t.closing = ti.closingSpeed;
    t.direction.x = ti.direction.x; t.direction.y = ti.direction.y; t.direction.z = ti.direction.z;
    t.relVelocity.x = ti.relVelocity.x; t.relVelocity.y = ti.relVelocity.y; t.relVelocity.z = ti.relVelocity.z;
    return t;
  }

  /** Offset (and its use) of body `id` relative to the prediction frame body at time t. */
  private offset(id: string, frameId: string, t: number, out: V3): V3 {
    if (id === frameId) {
      out.x = out.y = out.z = 0;
      return out;
    }
    const a = this.g.model.bodyAbsState(id, t, this.sv);
    const b = this.g.model.bodyAbsState(frameId, t, this.sv2);
    out.x = a.r.x - b.r.x; out.y = a.r.y - b.r.y; out.z = a.r.z - b.r.z;
    return out;
  }
  prediction(): PredictionView {
    const g = this.g;
    const tr = g.trajectory();
    const frameId = this.predFrame ?? g.shipPose().soiBodyId;
    const tgt = g.target();
    const key = `${tr.version}|${frameId}|${tgt ? tgt.id : ''}`;
    const pred = this.pred;
    if (key === this.predKey) return pred;
    this.predKey = key;
    pred.version++;
    pred.frameBodyId = frameId;
    const need = 4 * N_PATCH * Math.max(1, tr.patches.length);
    if (pred.points.length < need) pred.points = new Float64Array(need);
    const pts = pred.points;
    const events: PredictionEvent[] = [];
    const off = v3();
    let n = 0;
    const t0 = g.time();
    let tEnd = t0;
    for (const patch of tr.patches) {
      const s = samplePatch(patch, N_PATCH, this.scratch);
      const radius = g.model.body(patch.bodyId).radius;
      let iMin = 0, iMax = 0, rMin = Infinity, rMax = 0;
      const first = n;
      for (let i = 0; i < N_PATCH; i++) {
        const t = patch.tStart + ((patch.tEnd - patch.tStart) * i) / (N_PATCH - 1);
        this.offset(patch.bodyId, frameId, t, off);
        const x = s[3 * i], y = s[3 * i + 1], z = s[3 * i + 2];
        const r = Math.hypot(x, y, z);
        if (r < rMin) { rMin = r; iMin = n; }
        if (r > rMax) { rMax = r; iMax = n; }
        pts[4 * n] = x + off.x; pts[4 * n + 1] = y + off.y; pts[4 * n + 2] = z + off.z; pts[4 * n + 3] = t;
        n++;
      }
      const at = (i: number): V3 => ({ x: pts[4 * i], y: pts[4 * i + 1], z: pts[4 * i + 2] });
      if (patch.periapsisTime !== null && iMin > first && iMin < n - 1) events.push({ kind: 'periapsis', t: patch.periapsisTime, r: at(iMin), value: rMin - radius });
      if (patch.elements.e < 1 && iMax > first && iMax < n - 1) events.push({ kind: 'apoapsis', t: pts[4 * iMax + 3], r: at(iMax), value: rMax - radius });
      if (patch.endReason === 'impact' || patch.endReason === 'atmosphere') events.push({ kind: patch.endReason, t: patch.tEnd, r: at(n - 1), value: rMin - radius });
      tEnd = Math.max(tEnd, patch.tEnd);
    }
    pred.count = n;
    for (const node of tr.nodes) {
      if (!node.reached) continue;
      this.offset(node.bodyId, frameId, node.t, off);
      events.push({ kind: 'burn', t: node.t, r: { x: node.r.x + off.x, y: node.r.y + off.y, z: node.r.z + off.z }, value: node.dvMagnitude });
    }
    if (tr.closestApproach && n > 0) {
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(pts[4 * i + 3] - tr.closestApproach.t) < Math.abs(pts[4 * best + 3] - tr.closestApproach.t)) best = i;
      events.push({ kind: 'closestApproach', t: tr.closestApproach.t, r: { x: pts[4 * best], y: pts[4 * best + 1], z: pts[4 * best + 2] }, value: tr.closestApproach.distance });
    }
    pred.events = events;
    pred.horizon = tEnd - t0;
    // the target station's path over one of its orbits (or the horizon, if shorter)
    pred.targetCount = 0;
    const st = tgt && tgt.kind === 'station' ? this.system.stations.find((x) => x.id === tgt.id) : undefined;
    if (st) {
      const mu = g.model.body(st.parentBodyId).mu;
      const span = Math.max(60, Math.min(2 * Math.PI * Math.sqrt((st.orbit.a * st.orbit.a * st.orbit.a) / mu), Math.max(pred.horizon, 600) * 4));
      const tp = pred.targetPoints;
      for (let i = 0; i < N_PATCH; i++) {
        const t = t0 + (span * i) / (N_PATCH - 1);
        const a = g.model.stationAbsState(st.id, t, this.sv);
        const b = g.model.bodyAbsState(frameId, t, this.sv2);
        tp[4 * i] = a.r.x - b.r.x; tp[4 * i + 1] = a.r.y - b.r.y; tp[4 * i + 2] = a.r.z - b.r.z; tp[4 * i + 3] = t;
      }
      pred.targetCount = N_PATCH;
    }
    return pred;
  }
  setPredictionFrame(bodyId: string | null): void {
    this.predFrame = bodyId && this.system.bodies.some((b) => b.id === bodyId) ? bodyId : null;
    this.predKey = '';
  }
  burns(): readonly PlannedBurn[] {
    const nodes = this.g.nodes();
    const list = this.burnList;
    list.length = nodes.length;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      list[i] = { id: nd.id, t: nd.t, prograde: nd.dv.prograde, normal: nd.dv.normal, radial: nd.dv.radial };
    }
    return list;
  }
  addBurn(t: number, dv?: { prograde?: number; normal?: number; radial?: number }): string {
    const r = this.g.addNode(t, dv);
    return r.ok && r.id ? r.id : '';
  }
  updateBurn(id: string, patch: Partial<Omit<PlannedBurn, 'id'>>): void {
    const dv: { prograde?: number; normal?: number; radial?: number } = {};
    if (patch.prograde !== undefined) dv.prograde = patch.prograde;
    if (patch.normal !== undefined) dv.normal = patch.normal;
    if (patch.radial !== undefined) dv.radial = patch.radial;
    this.g.updateNode(id, patch.t !== undefined ? { t: patch.t, dv } : { dv });
  }
  removeBurn(id: string): void {
    this.g.removeNode(id);
  }
  clearBurns(): void {
    this.g.clearNodes();
  }

  docking(): DockingView {
    const g = this.g;
    const d = g.dockingState();
    const pose = g.shipPose();
    const o = this.dockView;
    o.stationId = d.stationId;
    o.distance = d.distance;
    o.relSpeed = d.relSpeed;
    o.dockedTo = pose.docked ? d.stationId : null;
    const guided = d.granted && !!d.portId && !pose.docked;
    o.portId = guided || pose.docked ? d.portId : null;
    if (guided) {
      o.portOffset.x = d.portRel.x; o.portOffset.y = d.portRel.y; o.portOffset.z = d.portRel.z;
      o.portAxis.x = d.portAxis.x; o.portAxis.y = d.portAxis.y; o.portAxis.z = d.portAxis.z;
      o.lateral = d.lateral;
      // ship forward (-Z) against the approach direction (-portAxis)
      const q = pose.q;
      const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      o.alignment = Math.acos(Math.max(-1, Math.min(1, -(fx * d.portAxis.x + fy * d.portAxis.y + fz * d.portAxis.z))));
      o.canLatch = d.portDistance < 30 && d.relSpeed < 3;
    } else {
      o.portOffset.x = o.portOffset.y = o.portOffset.z = 0;
      o.portAxis.x = o.portAxis.y = o.portAxis.z = 0;
      o.lateral = 0;
      o.alignment = 0;
      o.canLatch = false;
    }
    return o;
  }
  undock(): boolean {
    return this.g.undock().ok;
  }

  reset(): void {
    this.g = createGame({ seed: 1 });
    this.bind();
    this.startFree();
    this.lastThrottle = -1;
    this.achieved = 1;
    this.events.emit('reset', {});
  }
  save(): string {
    return JSON.stringify({ legacySession: 1, game: this.g.save() });
  }
}

export function createSession(opts: SessionOptions = {}): Session {
  const s = new LegacySession(createGame({ seed: opts.seed ?? 1 }));
  s.startFree();
  return s;
}

/** Null when the text is not a save of this session. */
export function loadSession(json: string, _opts: SessionOptions = {}): Session | null {
  try {
    const data = JSON.parse(json) as { legacySession?: number; game?: string };
    if (data.legacySession !== 1 || typeof data.game !== 'string') return null;
    const g = loadGame(data.game);
    return g ? new LegacySession(g) : null;
  } catch {
    return null;
  }
}
