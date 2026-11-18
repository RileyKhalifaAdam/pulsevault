// Orbital map: a top-down 2D chart of the current system drawn on a canvas, with kit controls on top.
// Screen x = system +X, screen y = system +Z (looking down from +Y, so prograde runs counter-clockwise).
import { h, icon, onTap, onHoldRepeat, Button, Chips, Stepper, type IconName } from '../kit';
import { fmtDate, fmtDistance, fmtDuration, fmtSpeed } from '../../core/units';
import { newState, orbitNormalFromElements, propagateStateTo, sampleOrbit, samplePatch, type SystemModel } from '../../sim/orbit';
import type { OrbitElements } from '../../core/types';
import type { TargetRef } from '../../sim/game';
import type { UiHost, UiScreen } from '../host';
import { bodyClassLabel, put, screenRoot, stationKindLabel } from './shared';

type Focus = 'ship' | 'home' | 'target' | 'system';
type Sel = { kind: 'station' | 'body' | 'node'; id: string } | null;

interface Ell { parentId: string; a: number; b: number; e: number; px: number; pz: number; qx: number; qz: number }
interface PatchGeo { bodyId: string; pts: Float64Array; n: number; tp: Float64Array; tn: number; t0: number; dt: number; planned: boolean }
interface Marker { bodyId: string; x: number; z: number; label: string; ap: boolean }
interface Hit { kind: 'station' | 'body' | 'node'; id: string; x: number; y: number; r: number }

const C = { ion: '#6FE3FF', ember: '#FFB454', green: '#63E6A1', red: '#FF5A4D', text: '#E8EEF5', dim: '#8FA3B8' };
const BODY_COLORS: Record<string, [string, string]> = {
  star: ['#FFB27A', '#E0603A'], lava: ['#E8774A', '#3A0E08'], barren: ['#A39C94', '#1B1A19'], desert: ['#D9A866', '#2A1A0C'],
  eyeball: ['#7CC4D6', '#0A1C26'], gasGiant: ['#D8B48A', '#2A1D12'], ice: ['#CFE4F0', '#16222B'], rocky: ['#B58A6A', '#20140D'],
};
const FONT = '600 11px "DIN Alternate", "Avenir Next", -apple-system, system-ui, sans-serif';
const MAX_LOG = Math.log2(1 / 400); // closest zoom: 1 px = 400 m
const TAU = Math.PI * 2;

function ellOf(el: OrbitElements, parentId: string): Ell {
  const s = sampleOrbit(el, 8); // first point is periapsis
  const l = Math.hypot(s[0], s[1], s[2]) || 1;
  const px = s[0] / l, py = s[1] / l, pz = s[2] / l;
  const n = orbitNormalFromElements(el);
  return { parentId, a: el.a, b: el.a * Math.sqrt(Math.max(0, 1 - el.e * el.e)), e: el.e, px, pz, qx: n.y * pz - n.z * py, qz: n.x * py - n.y * px };
}

export function createMapScreen(host: UiHost): UiScreen {
  const el = screenRoot(host, 'tls-map');
  const canvas = h('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  // ---- chrome
  const backBtn = h('button.tls-sq.tls-sq--frame', { attrs: { type: 'button', 'aria-label': 'Back' } }, icon('back', 22));
  const titleB = h('b');
  const titleS = h('span');
  const warpV = h('div.tls-warp__v.tl-num');
  const sq = (name: IconName, label: string, frame = false): HTMLElement => h('button.tls-sq', { class: frame && 'tls-sq--frame', attrs: { type: 'button', 'aria-label': label } }, icon(name, 20));
  const warpDown = sq('minus', 'Slower');
  const warpUp = sq('plus', 'Faster');
  const limit = h('div.tls-map__limit');
  const chipsWrap = h('div.tls-map__chips');
  const top = h('div.tls-map__top', null,
    h('div.tls-map__bar', null, backBtn, h('div.tls-map__title', null, titleB, titleS), h('div.tls-warp', null, warpDown, warpV, warpUp)),
    chipsWrap, limit);
  const zoomIn = sq('plus', 'Zoom in', true);
  const zoomOut = sq('minus', 'Zoom out', true);
  const zoom = h('div.tls-map__zoom', null, zoomIn, zoomOut);
  const statusB = h('b');
  const statusS = h('span');
  const cardWrap = h('div');
  const plotBtn = Button({ label: 'Plot course', variant: 'ion', onTap: doPlot });
  const flyBtn = Button({ label: 'Go to target', variant: 'primary', onTap: doFly });
  const clearBtn = Button({ icon: 'close', ariaLabel: 'Clear plan', variant: 'ghost', onTap: () => { host.game.clearNodes(); planMsg = ''; select(null); } });
  clearBtn.el.classList.add('tls-narrow');
  const dock = h('div.tls-map__dock', null, h('div.tls-map__status', null, statusB, statusS), cardWrap, h('div.tls-map__actions', null, plotBtn.el, flyBtn.el, clearBtn.el));
  el.append(canvas, top, zoom, dock);

  // ---- state
  let focus: Focus = 'home';
  let logS = -14, logT = -14;
  let panX = 0, panZ = 0;
  let anim = false;
  let needFit = true;
  let W = 0, H = 0, dpr = 1;
  let insetTop = 0, insetBottom = 0, insetRight = 0;
  let layoutAge = 99;
  let planMsg = '';
  let planBad = false;
  let sel: Sel = null;
  let actKey = '';
  let chipsKey = '';
  let chips: ReturnType<typeof Chips<Focus>> | null = null;
  let cardTick: (() => void) | null = null;

  // geometry caches (per model / per trajectory version)
  let model: SystemModel | null = null;
  let bodyEll = new Map<string, Ell>();
  let stEll = new Map<string, Ell>();
  let bIndex = new Map<string, number>();
  let bX = new Float64Array(0), bZ = new Float64Array(0);
  let maxA = 1;
  let trajVersion = -1;
  let trajGame: unknown = null;
  let geo: PatchGeo[] = [];
  let markers: Marker[] = [];
  const hits: Hit[] = [];
  const tmpV = { x: 0, y: 0, z: 0 };
  const tmpS = newState();
  let shipX = 0, shipZ = 0, camX = 0, camZ = 0, S = 1, vcx = 0, vcy = 0;

  function ensureModel(): SystemModel {
    const m = host.game.model;
    if (m === model) return m;
    model = m;
    bodyEll = new Map();
    stEll = new Map();
    bIndex = new Map();
    maxA = 1;
    m.bodies.forEach((b, i) => {
      bIndex.set(b.id, i);
      if (b.orbit && b.parentId) {
        bodyEll.set(b.id, ellOf(b.orbit, b.parentId));
        if (b.parentId === m.primary.id) maxA = Math.max(maxA, b.orbit.a * (1 + b.orbit.e));
      }
    });
    for (const s of m.def.stations) stEll.set(s.id, ellOf(s.orbit, s.parentBodyId));
    bX = new Float64Array(m.bodies.length);
    bZ = new Float64Array(m.bodies.length);
    trajVersion = -1;
    needFit = true;
    return m;
  }

  const bx = (id: string): number => bX[bIndex.get(id) ?? 0];
  const bz = (id: string): number => bZ[bIndex.get(id) ?? 0];

  function targetPos(t: TargetRef | null, time: number): { x: number; z: number } | null {
    const m = ensureModel();
    if (!t) return null;
    if (t.kind === 'body' && bIndex.has(t.id)) return { x: bx(t.id), z: bz(t.id) };
    if (t.kind === 'station' && stEll.has(t.id)) {
      const r = m.stationAbsState(t.id, time, tmpS).r;
      return { x: r.x, z: r.z };
    }
    return null;
  }

  // ---- trajectory geometry
  function rebuildTrajectory(): void {
    const g = host.game;
    const m = ensureModel();
    const tv = g.trajectory();
    trajVersion = tv.version;
    trajGame = g;
    geo = [];
    markers = [];
    const firstNodeT = tv.nodes.length ? tv.nodes[0].t : Infinity;
    const out = newState();
    tv.patches.forEach((p, i) => {
      const n = 192;
      const pts = samplePatch(p, n);
      const dur = Math.min(p.tEnd - p.tStart, Number.isFinite(p.period) ? p.period : Infinity);
      const tn = 72;
      const tp = new Float64Array(tn * 2);
      const dt = dur / (tn - 1);
      for (let k = 0; k < tn; k++) {
        propagateStateTo(out, p.svStart, p.mu, k * dt);
        tp[2 * k] = out.r.x;
        tp[2 * k + 1] = out.r.z;
      }
      geo.push({ bodyId: p.bodyId, pts, n, tp, tn, t0: p.tStart, dt, planned: p.tStart >= firstNodeT - 1e-3 });
      if (i === 0 || i === tv.patches.length - 1) {
        const body = m.body(p.bodyId);
        const mark = (t: number | null, radius: number, ap: boolean): void => {
          if (t === null || !Number.isFinite(radius) || !Number.isFinite(t)) return;
          propagateStateTo(out, p.svStart, p.mu, t - p.tStart);
          markers.push({ bodyId: p.bodyId, x: out.r.x, z: out.r.z, ap, label: `${ap ? 'Ap' : 'Pe'} ${fmtDistance(radius - body.radius)}` });
        };
        if (p.period === Infinity || p.apoapsisRadius - p.periapsisRadius > 0.004 * p.periapsisRadius) {
          mark(p.apoapsisTime, p.apoapsisRadius, true);
          mark(p.periapsisTime, p.periapsisRadius, false);
        }
      }
    });
  }

  // ---- camera
  function fitRadius(f: Focus): number {
    const g = host.game;
    const m = ensureModel();
    const pose = g.shipPose();
    const fi = g.flightInfo();
    const r = Math.hypot(pose.r.x, pose.r.z);
    if (f === 'system') return maxA * 1.12;
    if (f === 'ship') {
      if (pose.docked) return 2.5e6;
      const ra = Number.isFinite(fi.apoapsisAltitude) ? fi.apoapsisAltitude + m.body(pose.soiBodyId).radius : r * 4;
      return (r + Math.min(ra, r * 6)) * 1.1;
    }
    if (f === 'target') {
      const t = g.target();
      const ti = g.targetInfo();
      if (t && t.kind === 'body') return m.body(t.id).radius * 6;
      if (ti) return Math.max(6e4, ti.distance * 1.5);
      return fitRadius('home');
    }
    let R = Math.max(m.body(pose.soiBodyId).radius * 2.5, r);
    if (Number.isFinite(fi.apoapsisAltitude) && !pose.docked) R = Math.max(R, fi.apoapsisAltitude + m.body(pose.soiBodyId).radius);
    for (const s of m.def.stations) if (s.parentBodyId === pose.soiBodyId) R = Math.max(R, s.orbit.a * (1 + s.orbit.e));
    return R * 1.22;
  }
  const visW = (): number => Math.max(120, W - insetRight);
  const visH = (): number => Math.max(120, H - insetTop - insetBottom);
  const fitLog = (f: Focus): number => Math.log2((0.47 * Math.min(visW(), visH())) / fitRadius(f));
  const minLog = (): number => Math.log2((0.4 * Math.min(visW(), visH())) / (maxA * 1.4));
  const clampLog = (v: number): number => Math.min(MAX_LOG, Math.max(minLog(), v));

  function setFocus(f: Focus, quiet = false): void {
    if (f === 'target' && !host.game.target()) {
      if (!quiet) host.toast('No target set. Tap a station on the map.', 'info');
      chips?.update({ value: focus });
      return;
    }
    focus = f;
    // keep the picture continuous: re-express the current centre relative to the new focus, then glide to it
    const c = focusCentre(f);
    panX = camX - c.x;
    panZ = camZ - c.z;
    logT = clampLog(fitLog(f));
    anim = true;
    chips?.update({ value: f });
  }

  const fc = { x: 0, z: 0 };
  function focusCentre(f: Focus): { x: number; z: number } {
    const g = host.game;
    fc.x = 0; fc.z = 0;
    if (f === 'ship') { fc.x = shipX; fc.z = shipZ; }
    else if (f === 'home') { const id = g.shipPose().soiBodyId; fc.x = bx(id); fc.z = bz(id); }
    else if (f === 'target') { const p = targetPos(g.target(), g.time()); fc.x = p ? p.x : shipX; fc.z = p ? p.z : shipZ; }
    return fc;
  }

  // ---- gestures
  const ptrs = new Map<number, { x: number; y: number }>();
  let moved = 0, downAt = 0;
  let pinch: { d0: number; log0: number; ax: number; az: number } | null = null;
  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPinch = (): void => {
    const [a, b] = [...ptrs.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), log0: logS, ax: panX + (mx - vcx) / S, az: panZ + (my - vcy) / S };
    anim = false;
  };
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) { moved = 0; downAt = performance.now(); }
    if (ptrs.size === 2) { startPinch(); moved = 999; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const q = local(e);
    if (ptrs.size === 1) {
      const dx = q.x - p.x, dy = q.y - p.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6) { panX -= dx / S; panZ -= dy / S; anim = false; }
    }
    p.x = q.x; p.y = q.y;
    if (ptrs.size === 2 && pinch) {
      const [a, b] = [...ptrs.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      logS = logT = clampLog(pinch.log0 + Math.log2(d / pinch.d0));
      const s = Math.pow(2, logS);
      panX = pinch.ax - ((a.x + b.x) / 2 - vcx) / s;
      panZ = pinch.az - ((a.y + b.y) / 2 - vcy) / s;
    }
  });
  const up = (e: PointerEvent): void => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    ptrs.delete(e.pointerId);
    pinch = null;
    if (ptrs.size === 0 && e.type === 'pointerup' && moved <= 8 && performance.now() - downAt < 600) tap(p.x, p.y);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); logS = logT = clampLog(logS - e.deltaY * 0.002); }, { passive: false });

  function tap(x: number, y: number): void {
    let best: Hit | null = null;
    let bd = Infinity;
    for (const hit of hits) {
      const d = Math.hypot(hit.x - x, hit.y - y) - (hit.kind === 'node' ? 14 : hit.kind === 'station' ? 6 : 0);
      if (d < hit.r && d < bd) { best = hit; bd = d; }
    }
    if (best) return select({ kind: best.kind, id: best.id });
    // the trajectory: add a node at the nearest point
    const g = host.game;
    if (!g.shipPose().docked) {
      let bt = -1, btd = 26;
      for (const p of geo) {
        const ox = bx(p.bodyId), oz = bz(p.bodyId);
        for (let k = 1; k < p.tn; k++) {
          const d = Math.hypot(vcx + (ox + p.tp[2 * k] - camX) * S - x, vcy + (oz + p.tp[2 * k + 1] - camZ) * S - y);
          if (d < btd) { btd = d; bt = p.t0 + k * p.dt; }
        }
      }
      if (bt > g.time() + 5) {
        const r = g.addNode(bt);
        if (r.ok && r.id) { host.sfx('tick'); return select({ kind: 'node', id: r.id }); }
        if (!r.ok) host.toast(r.reason, 'warn');
        return;
      }
    }
    select(null);
  }

  // ---- bottom card
  function select(s: Sel): void {
    sel = s;
    cardTick = null;
    cardWrap.replaceChildren();
    if (!s) return;
    const g = host.game;
    const m = ensureModel();
    const close = sq('close', 'Close');
    onTap(close, () => select(null));
    if (s.kind === 'node') {
      const node = g.nodes().find((n) => n.id === s.id);
      if (!node) { sel = null; return; }
      const nameEl = h('div.tls-card__name');
      const subEl = h('div.tls-card__sub.tl-num');
      const tEl = h('span.tl-num');
      const mk = (label: string, key: 'prograde' | 'normal' | 'radial'): HTMLElement => h('div', null, h('div.tl-label', { text: label }),
        Stepper({ value: Math.round(node.dv[key]), min: -9000, max: 9000, step: 5, unit: 'm/s', block: true, compact: true, ariaLabel: label,
          format: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`,
          onChange: (v) => { g.updateNode(s.id, { dv: { [key]: v } }); } }).el);
      const earlier = h('button', { attrs: { type: 'button', 'aria-label': 'Earlier' } }, icon('chevronLeft', 20));
      const later = h('button', { attrs: { type: 'button', 'aria-label': 'Later' } }, icon('chevronRight', 20));
      const shift = (dir: number, n: number): void => {
        const cur = g.nodes().find((x) => x.id === s.id);
        if (cur) g.updateNode(s.id, { t: Math.max(g.time() + 5, cur.t + dir * (n > 12 ? 120 : 20)) });
      };
      onHoldRepeat(earlier, (n) => shift(-1, n));
      onHoldRepeat(later, (n) => shift(1, n));
      const del = Button({ label: 'Delete', variant: 'danger', size: 'sm', onTap: () => { g.removeNode(s.id); select(null); } });
      const card = h('div.tls-card', { style: { '--tl-c': C.ember } },
        h('div.tls-card__head', null, h('div', null, nameEl, subEl), del.el, close),
        h('div.tls-node-grid', null, mk('Prograde', 'prograde'), mk('Normal', 'normal'), mk('Radial', 'radial'),
          h('div', null, h('div.tl-label', { text: 'Burn time' }), h('div.tls-node-time', null, earlier, tEl, later))));
      cardWrap.appendChild(card);
      cardTick = () => {
        const list = g.nodes();
        const i = list.findIndex((n) => n.id === s.id);
        if (i < 0) return select(null);
        const view = g.trajectory().nodes.find((n) => n.id === s.id);
        put(nameEl, `Node ${i + 1} · Δv ${fmtSpeed(view ? view.dvMagnitude : Math.hypot(list[i].dv.prograde, list[i].dv.normal, list[i].dv.radial))}`);
        put(subEl, view ? `Burn ${fmtDuration(view.burnDuration)}${view.affordable ? '' : ' · not enough propellant'}${view.reached ? '' : ' · never reached'}` : '');
        subEl.style.color = view && (!view.affordable || !view.reached) ? C.red : '';
        put(tEl, `T− ${fmtDuration(list[i].t - g.time())}`);
      };
      cardTick();
      return;
    }
    const ref: TargetRef = { kind: s.kind, id: s.id };
    const isStation = s.kind === 'station';
    const st = isStation ? m.def.stations.find((x) => x.id === s.id) : null;
    const body = !isStation && m.hasBody(s.id) ? m.body(s.id) : null;
    if (!st && !body) { sel = null; return; }
    const distEl = h('div.tls-card__dist.tl-num');
    const btn = Button({ label: 'Set target', icon: 'target', variant: 'ion', block: true, onTap: () => {
      const cur = g.target();
      const on = !!cur && cur.kind === ref.kind && cur.id === ref.id;
      const r = g.setTarget(on ? null : ref);
      if (!r.ok) host.toast(r.reason, 'bad');
      else if (!on) host.sfx('confirm');
      planMsg = '';
    } });
    const focusBtn = Button({ label: 'Centre', icon: 'search', variant: 'secondary', onTap: () => {
      const p = targetPos(ref, g.time());
      if (!p) return;
      const c = focusCentre(focus);
      panX = p.x - c.x; panZ = p.z - c.z;
    } });
    cardWrap.appendChild(h('div.tls-card', { style: { '--tl-c': isStation ? C.ion : C.text } },
      h('div.tls-card__head', null,
        h('div', null, h('div.tls-card__name', { text: st ? st.name : body!.name }),
          h('div.tls-card__sub', { text: st ? `${stationKindLabel(st.visualId)} · orbits ${m.body(st.parentBodyId).name} at ${fmtDistance(st.orbit.a - m.body(st.parentBodyId).radius)}` : `${bodyClassLabel(body!.cls, body!.kind)} · radius ${fmtDistance(body!.radius)}` })),
        distEl, close),
      h('div.tl-row', null, btn.el, focusBtn.el)));
    let last = '';
    cardTick = () => {
      const p = targetPos(ref, g.time());
      if (p) put(distEl, fmtDistance(Math.hypot(p.x - shipX, p.z - shipZ)));
      const cur = g.target();
      const on = !!cur && cur.kind === ref.kind && cur.id === ref.id;
      const key = on ? 'on' : 'off';
      if (key !== last) { last = key; btn.update({ label: on ? 'Target set · clear' : 'Set target', icon: on ? 'check' : 'target' }); }
    };
    cardTick();
  }

  // ---- actions
  function doPlot(): void {
    const g = host.game;
    if (!g.target()) { planMsg = 'Set a target first: tap a station on the map.'; planBad = true; return; }
    const r = g.plan('toTarget');
    planBad = !r.ok;
    planMsg = r.ok ? [r.summary ?? 'Course plotted.', ...(r.warnings ?? [])].join(' · ') : r.reason;
    host.sfx(r.ok ? 'confirm' : 'deny');
    if (r.ok) { select(null); setFocus('home', true); }
  }
  function doFly(): void {
    const g = host.game;
    const ap = g.autopilot();
    if (ap.engaged) { g.disengageAutopilot(); host.toast('Flight computer disengaged. You have the ship.', 'info'); return; }
    const t = g.target();
    let r;
    if (g.nodes().length > 0) r = g.engageAutopilot({ kind: 'flyPlan' });
    else if (t && t.kind === 'station') r = g.engageAutopilot({ kind: 'goToStation', stationId: t.id });
    else { planMsg = 'Set a station as target first: tap one on the map.'; planBad = true; return; }
    planBad = !r.ok;
    planMsg = r.ok ? '' : r.reason;
    host.sfx(r.ok ? 'confirm' : 'deny');
  }
  onTap(backBtn, () => host.go(host.game.dockedStation() ? 'station' : 'flight'));
  onTap(warpDown, () => { host.game.warpDown(); });
  onTap(warpUp, () => { const r = host.game.warpUp(); if (!r.ok) host.toast(r.reason, 'warn'); });
  onHoldRepeat(zoomIn, () => { logT = clampLog(logT + 0.5); anim = true; });
  onHoldRepeat(zoomOut, () => { logT = clampLog(logT - 0.5); anim = true; });

  // ---- drawing
  const sx = (x: number): number => vcx + (x - camX) * S;
  const sy = (z: number): number => vcy + (z - camZ) * S;
  function glow(color: string, width: number, alpha = 1, dash: number[] | null = null): void {
    ctx.setLineDash(dash ?? []);
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * 0.16;
    ctx.lineWidth = width + 3.5;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  function ellPath(e: Ell, ox: number, oz: number): boolean {
    const R = e.a * S;
    if (R < 2) return false;
    let e0 = 0, e1 = TAU, n = 128;
    if (R > 2200) {
      // far larger than the screen: sample only the stretch near the view
      const vx = camX - ox, vz = camZ - oz;
      const u = vx * e.px + vz * e.pz + e.a * e.e, v = vx * e.qx + vz * e.qz;
      const viewR = Math.hypot(W, H) * 0.75;
      if (Math.abs(Math.hypot(u, v) * S - R) > viewR * 1.6 + R * e.e) return false;
      const ec = Math.atan2(v / e.b, u / e.a);
      const w = Math.min(Math.PI, (2.4 * viewR) / R);
      e0 = ec - w; e1 = ec + w; n = 96;
    }
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const E = e0 + ((e1 - e0) * k) / n;
      const c = e.a * (Math.cos(E) - e.e), s = e.b * Math.sin(E);
      const X = sx(ox + c * e.px + s * e.qx), Y = sy(oz + c * e.pz + s * e.qz);
      if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    return true;
  }
  function label(text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left'): void {
    ctx.font = FONT;
    ctx.textAlign = align;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5, 7, 11, 0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function disc(x: number, y: number, r: number, cls: string, sun: number): void {
    const [lit, dark] = BODY_COLORS[cls] ?? BODY_COLORS.rocky;
    if (cls === 'star') {
      const gr = Math.max(r * 3.2, 22);
      const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
      g.addColorStop(0, 'rgba(255, 190, 140, 0.9)');
      g.addColorStop(Math.min(0.9, r / gr), 'rgba(255, 140, 90, 0.55)');
      g.addColorStop(1, 'rgba(255, 110, 60, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
      ctx.fillStyle = '#FFE3C4';
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      return;
    }
    const cx = Math.cos(sun), cy = Math.sin(sun);
    const g = ctx.createLinearGradient(x + cx * r, y + cy * r, x - cx * r, y - cy * r);
    g.addColorStop(0, lit);
    g.addColorStop(0.46, lit);
    g.addColorStop(0.6, dark);
    g.addColorStop(1, '#04060A');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (r > 5) { // thin atmosphere / rim glow on the lit side
      ctx.strokeStyle = lit; ctx.globalAlpha = 0.35; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, sun - 1.3, sun + 1.3); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function draw(): void {
    const g = host.game;
    const m = ensureModel();
    const t = g.time();
    const pose = g.shipPose();
    const target = g.target();
    const tv = g.trajectory();
    if (tv.version !== trajVersion || trajGame !== g) rebuildTrajectory();

    m.bodies.forEach((b, i) => { const p = m.bodyAbsPosition(b.id, t, tmpV); bX[i] = p.x; bZ[i] = p.z; });
    shipX = bx(pose.soiBodyId) + pose.r.x;
    shipZ = bz(pose.soiBodyId) + pose.r.z;
    const c = focusCentre(focus);
    camX = c.x + panX; camZ = c.z + panZ;
    S = Math.pow(2, logS);
    vcx = (W - insetRight) / 2;
    vcy = insetTop + (H - insetTop - insetBottom) / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    hits.length = 0;

    // body orbits
    for (const b of m.bodies) {
      const e = bodyEll.get(b.id);
      if (!e) continue;
      const isT = !!target && target.kind === 'body' && target.id === b.id;
      if (e.a * S < 10 && !isT) continue;
      if (ellPath(e, bx(e.parentId), bz(e.parentId))) glow(isT ? C.green : '#9FB4C8', isT ? 1.4 : 1, isT ? 0.9 : b.kind === 'moon' ? 0.28 : 0.34);
    }
    // sphere of influence of the world the ship is at
    const home = m.body(pose.soiBodyId);
    if (Number.isFinite(home.soi) && home.soi * S > 30 && home.soi * S < 6000) {
      ctx.beginPath(); ctx.arc(sx(bx(home.id)), sy(bz(home.id)), home.soi * S, 0, TAU);
      ctx.setLineDash([2, 6]); ctx.strokeStyle = 'rgba(143, 163, 184, 0.35)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    // station orbits
    for (const s of m.def.stations) {
      const e = stEll.get(s.id)!;
      const isT = !!target && target.kind === 'station' && target.id === s.id;
      if (e.a * S < 12) continue;
      if (ellPath(e, bx(e.parentId), bz(e.parentId))) glow(isT ? C.green : C.ion, isT ? 1.5 : 1, isT ? 0.95 : 0.3, isT ? null : [1, 5]);
    }
    // the ship's path: this orbit solid, legs after a node dashed
    if (!pose.docked) {
      for (const p of geo) {
        const ox = bx(p.bodyId), oz = bz(p.bodyId);
        ctx.beginPath();
        for (let k = 0; k < p.n; k++) {
          const X = sx(ox + p.pts[3 * k]), Y = sy(oz + p.pts[3 * k + 2]);
          if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        glow(p.planned ? C.ember : C.ion, 1.6, p.planned ? 0.95 : 0.9, p.planned ? [7, 5] : null);
      }
      for (const k of markers) {
        const X = sx(bx(k.bodyId) + k.x), Y = sy(bz(k.bodyId) + k.z);
        ctx.fillStyle = k.ap ? C.ion : C.ember;
        ctx.beginPath();
        if (k.ap) { ctx.moveTo(X, Y - 6); ctx.lineTo(X + 5, Y + 3); ctx.lineTo(X - 5, Y + 3); } else { ctx.moveTo(X, Y + 6); ctx.lineTo(X + 5, Y - 3); ctx.lineTo(X - 5, Y - 3); }
        ctx.closePath(); ctx.fill();
        label(k.label, X + 9, Y + 4, k.ap ? C.ion : C.ember);
      }
    }
    // bodies
    for (const b of m.bodies) {
      const e = bodyEll.get(b.id);
      const isT = !!target && target.kind === 'body' && target.id === b.id;
      if (e && e.a * S < 9 && !isT) continue;
      const X = sx(bx(b.id)), Y = sy(bz(b.id));
      if (X < -4000 || X > W + 4000 || Y < -4000 || Y > H + 4000) continue;
      const r = Math.max(b.kind === 'star' ? 6 : b.kind === 'moon' ? 2.5 : 3.5, b.radius * S);
      disc(X, Y, r, b.cls, Math.atan2(-bz(b.id), -bx(b.id)));
      const showLabel = !e || e.a * S > 30 || isT || b.id === pose.soiBodyId;
      if (showLabel && r < 400) label(b.name.toUpperCase(), X, r > 40 ? Y + 4 : Y + r + 14, isT ? C.green : 'rgba(232, 238, 245, 0.85)', 'center');
      if (isT) reticle(X, Y, r + 6, C.green);
      hits.push({ kind: 'body', id: b.id, x: X, y: Y, r: Math.max(r, 20) });
    }
    // stations
    for (const s of m.def.stations) {
      const e = stEll.get(s.id)!;
      const isT = !!target && target.kind === 'station' && target.id === s.id;
      const isSel = !!sel && sel.kind === 'station' && sel.id === s.id;
      if (e.a * S < 10 && !isT) continue;
      const p = m.stationAbsState(s.id, t, tmpS).r;
      const X = sx(p.x), Y = sy(p.z);
      const col = isT ? C.green : C.ion;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.fillStyle = '#05070B';
      ctx.beginPath(); ctx.moveTo(X, Y - 5.5); ctx.lineTo(X + 5.5, Y); ctx.lineTo(X, Y + 5.5); ctx.lineTo(X - 5.5, Y); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(X - 1, Y - 1, 2, 2);
      if (isT) reticle(X, Y, 11, C.green);
      if (isSel && !isT) reticle(X, Y, 11, C.text);
      if (e.a * S > 44 || isT || isSel) label(s.name.toUpperCase(), X + 12, Y - 8, col);
      hits.push({ kind: 'station', id: s.id, x: X, y: Y, r: 22 });
    }
    // manoeuvre nodes
    tv.nodes.forEach((n, i) => {
      if (!n.reached) return;
      const X = sx(bx(n.bodyId) + n.r.x), Y = sy(bz(n.bodyId) + n.r.z);
      const on = !!sel && sel.kind === 'node' && sel.id === n.id;
      ctx.strokeStyle = n.affordable ? C.ember : C.red; ctx.lineWidth = on ? 2.2 : 1.5; ctx.fillStyle = 'rgba(5, 7, 11, 0.9)';
      ctx.beginPath(); ctx.arc(X, Y, on ? 9 : 7, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = n.affordable ? C.ember : C.red;
      ctx.font = FONT; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), X, Y + 4);
      label(`ΔV ${fmtSpeed(n.dvMagnitude).toUpperCase()}`, X + 13, Y + 16, C.ember);
      hits.push({ kind: 'node', id: n.id, x: X, y: Y, r: 26 });
    });
    // the ship
    {
      const X = sx(shipX), Y = sy(shipZ);
      if (pose.docked) {
        ctx.strokeStyle = C.text; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(X, Y, 10, 0, TAU); ctx.stroke();
        label('YOU · DOCKED', X + 14, Y + 16, C.text);
      } else {
        const a = Math.atan2(pose.v.z, pose.v.x);
        ctx.save(); ctx.translate(X, Y); ctx.rotate(a);
        ctx.fillStyle = 'rgba(111, 227, 255, 0.18)';
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, TAU); ctx.fill();
        ctx.fillStyle = '#FFFFFF'; ctx.strokeStyle = C.ion; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, 5.5); ctx.lineTo(-3, 0); ctx.lineTo(-6, -5.5); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
    // scale bar
    {
      const metres = 90 / S;
      const p10 = Math.pow(10, Math.floor(Math.log10(metres)));
      const nice = (metres / p10 >= 5 ? 5 : metres / p10 >= 2 ? 2 : 1) * p10;
      const x0 = 14 + (insetLeft || 0), y0 = H - insetBottom - 10, w = nice * S;
      ctx.strokeStyle = 'rgba(232, 238, 245, 0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + w, y0); ctx.lineTo(x0 + w, y0 - 5); ctx.stroke();
      label(fmtDistance(nice).toUpperCase(), x0 + w + 8, y0 + 1, 'rgba(232, 238, 245, 0.7)');
    }
  }
  let insetLeft = 0;
  function reticle(x: number, y: number, r: number, color: string): void {
    const k = r * 0.45;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ctx.moveTo(x + dx * r, y + dy * (r - k)); ctx.lineTo(x + dx * r, y + dy * r); ctx.lineTo(x + dx * (r - k), y + dy * r);
    }
    ctx.stroke();
  }

  // ---- per-frame chrome
  function chrome(): void {
    const g = host.game;
    const m = ensureModel();
    const pose = g.shipPose();
    const fi = g.flightInfo();
    const ap = g.autopilot();
    const w = g.warp();
    const t = g.target();
    const ti = g.targetInfo();
    const nodes = g.nodes().length;
    put(titleB, `${m.def.name} system`);
    put(titleS, fmtDate(g.time()));
    const wv = `×${w.level.toLocaleString('en-US')}`;
    if (warpV.dataset.v !== wv) { warpV.dataset.v = wv; warpV.replaceChildren(wv, h('small', { text: 'Time' })); }
    put(limit, w.limitReason && w.requested >= w.maxAllowed ? `Warp limit ×${w.maxAllowed.toLocaleString('en-US')}: ${w.limitReason}` : '');

    const homeName = m.body(pose.soiBodyId).name;
    const ck = `${homeName}|${ti ? ti.name : ''}`;
    if (ck !== chipsKey) {
      chipsKey = ck;
      chips?.destroy();
      chips = Chips<Focus>({
        items: [{ id: 'ship', label: 'Ship' }, { id: 'home', label: homeName }, { id: 'target', label: ti ? ti.name : 'Target' }, { id: 'system', label: 'System' }],
        value: focus, clearable: false, tone: 'ion', onChange: (id) => { if (id) setFocus(id); },
      });
      chipsWrap.replaceChildren(chips.el);
    }

    // status
    let line = planMsg;
    let color = planBad ? C.red : C.ember;
    if (ap.engaged) { line = ap.status || 'Flight computer engaged.'; color = C.green; }
    else if (!line && ap.failed) { line = `Flight computer: ${ap.failed}`; color = C.red; }
    else if (!line) {
      color = C.dim;
      line = pose.docked ? 'Docked. Launch from the station to fly.' : !t ? 'Tap a station to choose a target.' : nodes ? 'Course plotted. Fly it by hand, or let the flight computer.' : 'Plot a course, or hand the trip to the flight computer.';
    }
    put(statusB, line);
    statusB.style.color = color;
    let facts = pose.docked ? '' : `Ap ${fmtDistance(fi.apoapsisAltitude)} · Pe ${fmtDistance(fi.periapsisAltitude)} · Δv ${fmtSpeed(fi.deltaV)}`;
    if (ti) facts += `${facts ? ' · ' : ''}${ti.name} ${fmtDistance(ti.distance)}`;
    const ca = g.trajectory().closestApproach;
    if (ca && !pose.docked && ca.t > g.time()) facts += ` · closest ${fmtDistance(ca.distance)} in ${fmtDuration(ca.t - g.time())}`;
    put(statusS, facts);

    const key = `${ap.engaged}|${nodes > 0}|${!!t}|${pose.docked}`;
    if (key !== actKey) {
      actKey = key;
      flyBtn.update({ label: ap.engaged ? 'Disengage' : nodes > 0 ? 'Fly the plan' : 'Go to target' });
      flyBtn.el.classList.toggle('tl-btn--danger', ap.engaged);
      flyBtn.el.classList.toggle('tl-btn--primary', !ap.engaged);
      plotBtn.update({ disabled: ap.engaged });
      clearBtn.el.style.display = nodes > 0 && !ap.engaged ? '' : 'none';
    }
    cardTick?.();
  }

  function layout(): void {
    const w = el.clientWidth, hh = el.clientHeight;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== W || hh !== H || d !== dpr) {
      W = w; H = hh; dpr = d;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      layoutAge = 99;
    }
    if (++layoutAge < 12) return;
    layoutAge = 0;
    const side = dock.offsetWidth < W * 0.7;
    insetTop = top.offsetHeight;
    insetRight = side ? dock.offsetWidth : 0;
    insetBottom = side ? 0 : dock.offsetHeight;
    insetLeft = parseFloat(getComputedStyle(top).paddingLeft) - 12 || 0;
    zoom.style.top = `${insetTop + 10}px`;
    zoom.style.right = side ? `${insetRight + 4}px` : '';
  }

  return {
    el,
    show() {
      el.hidden = false;
      layoutAge = 99;
      needFit = true;
      focus = 'home';
      panX = panZ = 0;
      actKey = '';
      this.update(0);
    },
    hide() { el.hidden = true; ptrs.clear(); pinch = null; },
    update(dt: number) {
      if (el.hidden) return;
      ensureModel();
      layout();
      if (W < 2 || H < 2) return;
      chrome();
      if (needFit) { needFit = false; logS = logT = clampLog(fitLog(focus)); anim = false; chips?.update({ value: focus }); }
      if (anim && !pinch) {
        const k = 1 - Math.exp(-Math.min(dt, 0.1) * 9);
        logS += (logT - logS) * k;
        panX -= panX * k; panZ -= panZ * k;
        if (Math.abs(logT - logS) < 0.002 && Math.hypot(panX, panZ) * Math.pow(2, logS) < 0.5) { logS = logT; panX = panZ = 0; anim = false; }
      }
      draw();
    },
    dispose() { chips?.destroy(); el.remove(); },
  };
}
