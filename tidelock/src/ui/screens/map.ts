// Map: the predicted path of the ship, drawn top-down (looking along -Y, so prograde runs counter-clockwise)
// around the prediction's frame body. Everything comes from the Session: prediction() for the path, the
// target's path and the events; bodies() / craft() for where things are now; burns() for the plan.
// Drag to pan, pinch to zoom; tap a world or station to target it; tap the path to plan a burn there.
import type { UiHost, UiScreen } from '../host';
import type { PlannedBurn, PredictionEvent } from '../../game';
import { fmtDistance, fmtDuration, fmtSpeed } from '../../core/units';
import { h, icon, onHoldRepeat, onTap } from '../kit';

const CSS = `
.pm{position:absolute;inset:0;background:#05070b;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;color:var(--tl-text);font-variant-numeric:tabular-nums;
 --gx-l:max(16px,env(safe-area-inset-left,0px));--gx-r:max(16px,env(safe-area-inset-right,0px))}
.pm canvas{position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none}
.pm [hidden]{display:none!important}
.pm-plate{background:rgba(8,12,18,.82);border:1px solid rgba(111,227,255,.22);border-radius:4px}
.pm-head{position:absolute;left:var(--gx-l);right:var(--gx-r);top:calc(8px + env(safe-area-inset-top,0px));display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;pointer-events:none}
.pm-head>*{pointer-events:auto}
.pm-b{min-height:46px;min-width:46px;padding:0 12px;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--tl-text);font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.pm-b.tl-pressed{background:rgba(111,227,255,.2)}
.pm-title{flex:1 1 120px;min-width:0;padding:5px 10px;display:flex;flex-direction:column;justify-content:center}
.pm-title small{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--tl-dim)}
.pm-title b{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tl-ion)}
.pm-warp{display:flex;align-items:center}
.pm-warp span{min-width:54px;text-align:center;font-size:14px;font-weight:600}
.pm-warp span.is-fast{color:var(--tl-ember)}
.pm-foot{position:absolute;left:var(--gx-l);right:var(--gx-r);bottom:calc(10px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.pm-hint{font-size:11px;color:var(--tl-dim);letter-spacing:.04em;text-align:center;padding:4px 10px;background:rgba(5,7,11,.7);border-radius:3px}
.pm-ed{pointer-events:auto;width:100%;max-width:420px;padding:8px 10px;box-sizing:border-box}
.pm-ed-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pm-ed-head b{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--tl-ember);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-ed-head .pm-b{min-height:44px;border:1px solid var(--tl-line-2);border-radius:3px;font-size:11px}
.pm-ed-head .pm-del{color:var(--tl-red);border-color:rgba(255,90,77,.5)}
.pm-rows{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.pm-row{display:flex;align-items:center;border:1px solid var(--tl-line);border-radius:3px;min-width:0}
.pm-row button{width:44px;height:46px;flex:none;font-size:20px;color:var(--tl-ion)}
.pm-row button.tl-pressed{background:rgba(111,227,255,.2)}
.pm-row div{flex:1;min-width:0;text-align:center;line-height:1.2}
.pm-row small{display:block;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--tl-dim)}
.pm-row b{display:block;font-size:13px;font-weight:600;white-space:nowrap}
.pm-zoom{position:absolute;right:var(--gx-r);top:50%;transform:translateY(-50%);display:flex;flex-direction:column;pointer-events:auto}
.pm-zoom button{width:46px;height:46px;font-size:22px;color:var(--tl-text)}
.pm-zoom button.tl-pressed{background:rgba(111,227,255,.2)}
`;

const EVENT_LABEL: Record<PredictionEvent['kind'], string> = { periapsis: 'Pe', apoapsis: 'Ap', closestApproach: 'Closest', atmosphere: 'Atmosphere', impact: 'Impact', burn: 'Burn' };
const fmtX = (v: number): string => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v >= 10 ? String(Math.round(v)) : String(+v.toFixed(1)));

export function createMapScreen(host: UiHost): UiScreen {
  if (!document.getElementById('tl-pm-css')) {
    const s = document.createElement('style');
    s.id = 'tl-pm-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const ses = host.session;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // ---------------------------------------------------------------- chrome
  const back = h('button.pm-b.pm-plate', { attrs: { type: 'button', 'aria-label': 'Back to flight' } }, icon('back', 20), 'Flight');
  const titleSmall = h('small', { text: 'Path around' });
  const titleMain = h('b');
  const frameBtn = h('button.pm-title.pm-plate', { attrs: { type: 'button', 'aria-label': 'Change the frame body' } }, titleSmall, titleMain);
  const wDown = h('button.pm-b', { attrs: { type: 'button', 'aria-label': 'Slower time' }, text: '«' });
  const wUp = h('button.pm-b', { attrs: { type: 'button', 'aria-label': 'Faster time' }, text: '»' });
  const wX = h('span');
  const head = h('div.pm-head', null, back, frameBtn, h('div.pm-warp.pm-plate', null, wDown, wX, wUp));
  onTap(back, () => host.go('flight'));
  onTap(wDown, () => ses.warpDown());
  onTap(wUp, () => ses.warpUp());
  const zIn = h('button', { attrs: { type: 'button', 'aria-label': 'Zoom in' }, text: '+' });
  const zOut = h('button', { attrs: { type: 'button', 'aria-label': 'Zoom out' }, text: '−' });
  const zFit = h('button', { attrs: { type: 'button', 'aria-label': 'Fit the path' }, text: '◎' });
  const zoom = h('div.pm-zoom.pm-plate', null, zIn, zOut, zFit);

  const hint = h('div.pm-hint', { text: 'Tap the path to plan a burn · tap a world or station to target it' });
  const edTitle = h('b');
  const del = h('button.pm-b.pm-del', { attrs: { type: 'button' }, text: 'Delete' });
  const done = h('button.pm-b', { attrs: { type: 'button' }, text: 'Done' });
  const rows = h('div.pm-rows');
  const ed = h('div.pm-ed.pm-plate', { attrs: { 'data-burn-editor': '1' } }, h('div.pm-ed-head', null, edTitle, del, done), rows);
  ed.hidden = true;
  const foot = h('div.pm-foot', null, hint, ed);
  const el = h('div.pm', null, canvas, head, zoom, foot);
  el.style.display = 'none';

  // ---------------------------------------------------------------- view
  let w = 1;
  let hgt = 1;
  let dpr = 1;
  /** View centre relative to the frame body (world X, Z), m, and metres per CSS pixel. */
  let cx = 0;
  let cz = 0;
  let mpp = 1e4;
  let needFit = true;
  let frameChoice: string | null = null;
  let selected: string | null = null;
  const sx = (x: number): number => w / 2 + (x - cx) / mpp;
  const sy = (z: number): number => hgt / 2 + (z - cz) / mpp;

  const frameBody = (): { r: { x: number; y: number; z: number }; v: { x: number; y: number; z: number }; id: string } | null => {
    const id = ses.prediction().frameBodyId;
    const b = ses.bodies();
    for (let i = 0; i < b.length; i++) if (b[i].id === id) return b[i];
    return null;
  };
  const playerCraft = (): ReturnType<typeof ses.craft>[number] | null => {
    const c = ses.craft();
    for (let i = 0; i < c.length; i++) if (c[i].isPlayer) return c[i];
    return null;
  };

  const fit = (): void => {
    const pred = ses.prediction();
    const fb = frameBody();
    const pc = playerCraft();
    let ext = 0;
    for (let i = 0; i < pred.count; i++) ext = Math.max(ext, Math.abs(pred.points[4 * i]), Math.abs(pred.points[4 * i + 2]));
    if (fb && pc) ext = Math.max(ext, Math.abs(pc.r.x - fb.r.x), Math.abs(pc.r.z - fb.r.z));
    if (!(ext > 0)) ext = 1e7;
    cx = cz = 0;
    mpp = (ext * 1.2) / Math.max(60, Math.min(w, hgt) / 2 - 56);
    needFit = false;
  };
  const zoomBy = (k: number, px = w / 2, py = hgt / 2): void => {
    const wx = cx + (px - w / 2) * mpp;
    const wz = cz + (py - hgt / 2) * mpp;
    mpp = Math.min(1e10, Math.max(0.05, mpp * k));
    cx = wx - (px - w / 2) * mpp;
    cz = wz - (py - hgt / 2) * mpp;
  };
  onHoldRepeat(zIn, () => zoomBy(0.8));
  onHoldRepeat(zOut, () => zoomBy(1.25));
  onTap(zFit, fit);

  // frame body: the primary (default) -> the body it orbits -> the star -> back
  onTap(frameBtn, () => {
    const sys = ses.system;
    const primary = ses.flight().primaryId;
    const def = sys.bodies.find((b) => b.id === primary);
    const opts: (string | null)[] = [null];
    const parent = def && (def as { parentId?: string | null }).parentId;
    if (parent) opts.push(parent);
    const star = sys.bodies[0]?.id;
    if (star && star !== primary && !opts.includes(star)) opts.push(star);
    const tg = ses.target();
    if (tg && tg.kind === 'body' && tg.id !== primary && !opts.includes(tg.id)) opts.push(tg.id);
    frameChoice = opts[(opts.indexOf(frameChoice) + 1) % opts.length];
    ses.setPredictionFrame(frameChoice);
    needFit = true;
  });

  // ---------------------------------------------------------------- burn editor
  const burnOf = (id: string | null): PlannedBurn | null => {
    if (!id) return null;
    const list = ses.burns();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  const stepFor = (n: number, a: number, b: number, c: number): number => (n < 8 ? a : n < 22 ? b : c);
  const mkRow = (label: string, apply: (dir: -1 | 1, n: number) => void): { el: HTMLElement; set: (s: string) => void } => {
    const minus = h('button', { attrs: { type: 'button', 'aria-label': `${label} less` }, text: '−' });
    const plus = h('button', { attrs: { type: 'button', 'aria-label': `${label} more` }, text: '+' });
    const val = h('b');
    onHoldRepeat(minus, (n) => apply(-1, n));
    onHoldRepeat(plus, (n) => apply(1, n));
    return { el: h('div.pm-row', null, minus, h('div', null, h('small', { text: label }), val), plus), set: (s) => { if (val.textContent !== s) val.textContent = s; } };
  };
  const dvRow = (label: string, key: 'prograde' | 'normal' | 'radial'): { el: HTMLElement; set: (s: string) => void } =>
    mkRow(label, (dir, n) => {
      const b = burnOf(selected);
      if (b) ses.updateBurn(b.id, { [key]: b[key] + dir * stepFor(n, 1, 5, 25) });
    });
  const rPro = dvRow('Prograde', 'prograde');
  const rNor = dvRow('Normal', 'normal');
  const rRad = dvRow('Radial', 'radial');
  const rTime = mkRow('Time', (dir, n) => {
    const b = burnOf(selected);
    if (b) ses.updateBurn(b.id, { t: Math.max(ses.time() + 5, b.t + dir * stepFor(n, 10, 60, 300)) });
  });
  rows.append(rPro.el, rNor.el, rRad.el, rTime.el);
  const select = (id: string | null): void => {
    selected = id;
    ed.hidden = !id;
    hint.hidden = !!id;
  };
  onTap(del, () => {
    if (selected) ses.removeBurn(selected);
    select(null);
  });
  onTap(done, () => select(null));
  const sgn = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} m/s`;
  const updateEditor = (): void => {
    const b = burnOf(selected);
    if (!b) {
      if (selected) select(null);
      return;
    }
    edTitle.textContent = `Burn · T− ${fmtDuration(Math.max(0, b.t - ses.time()))} · Δv ${fmtSpeed(Math.hypot(b.prograde, b.normal, b.radial))}`;
    rPro.set(sgn(b.prograde));
    rNor.set(sgn(b.normal));
    rRad.set(sgn(b.radial));
    rTime.set(`T− ${fmtDuration(Math.max(0, b.t - ses.time()))}`);
  };

  // ---------------------------------------------------------------- taps, pan, pinch
  const tapAt = (px: number, py: number): void => {
    const pred = ses.prediction();
    const fb = frameBody();
    // 1. an existing burn
    const burns = ses.burns();
    for (const ev of pred.events) {
      if (ev.kind !== 'burn' || Math.hypot(sx(ev.r.x) - px, sy(ev.r.z) - py) > 26) continue;
      let best: PlannedBurn | null = null;
      for (const b of burns) if (!best || Math.abs(b.t - ev.t) < Math.abs(best.t - ev.t)) best = b;
      if (best) return select(best.id);
    }
    // 2. a station or a world: target it
    if (fb) {
      let hit: { id: string; name: string } | null = null;
      let hd = 24;
      for (const c of ses.craft()) {
        if (c.isPlayer) continue;
        const d = Math.hypot(sx(c.r.x - fb.r.x) - px, sy(c.r.z - fb.r.z) - py);
        if (d < hd) { hd = d; hit = c; }
      }
      for (const b of ses.bodies()) {
        const d = Math.hypot(sx(b.r.x - fb.r.x) - px, sy(b.r.z - fb.r.z) - py) - Math.min(b.def.radius / mpp, 40);
        if (d < Math.min(hd, 14)) { hd = d; hit = { id: b.id, name: b.def.name }; }
      }
      if (hit) {
        ses.setTarget(hit.id);
        host.toast(`Target: ${hit.name}`, 'info');
        return;
      }
    }
    // 3. the path: plan a burn at the nearest point
    const p = pred.points;
    let bestD = 30;
    let bestT = NaN;
    for (let i = 0; i + 1 < pred.count; i++) {
      const ax = sx(p[4 * i]), ay = sy(p[4 * i + 2]), bx = sx(p[4 * i + 4]), by = sy(p[4 * i + 6]);
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + dx * u - px, ay + dy * u - py);
      if (d < bestD) {
        bestD = d;
        bestT = p[4 * i + 3] + (p[4 * i + 7] - p[4 * i + 3]) * u;
      }
    }
    if (Number.isFinite(bestT)) {
      const id = ses.addBurn(Math.max(ses.time() + 10, bestT));
      if (id) select(id);
      else host.toast('A burn cannot be planned there', 'warn');
      return;
    }
    select(null);
  };
  const pts = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number; moved: boolean }>();
  let pinch = 0;
  const local = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const q = local(e);
    pts.set(e.pointerId, { x: q.x, y: q.y, x0: q.x, y0: q.y, t0: performance.now(), moved: false });
    pinch = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const q = local(e);
    if (pts.size === 1) {
      if (!p.moved && Math.hypot(q.x - p.x0, q.y - p.y0) > 8) p.moved = true;
      if (p.moved) {
        cx -= (q.x - p.x) * mpp;
        cz -= (q.y - p.y) * mpp;
      }
      p.x = q.x;
      p.y = q.y;
    } else if (pts.size === 2) {
      p.x = q.x;
      p.y = q.y;
      p.moved = true;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && d > 0) zoomBy(pinch / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = d;
    }
  });
  const up = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    pts.delete(e.pointerId);
    pinch = 0;
    for (const o of pts.values()) o.moved = true;
    if (e.type === 'pointerup' && !p.moved && performance.now() - p.t0 < 500) tapAt(p.x, p.y);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomBy(e.deltaY > 0 ? 1.15 : 0.87, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // ---------------------------------------------------------------- drawing
  const line = (c: CanvasRenderingContext2D, p: Float64Array, n: number): void => {
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = sx(p[4 * i]);
      const y = sy(p[4 * i + 2]);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  };
  const label = (c: CanvasRenderingContext2D, s: string, x: number, y: number, color: string): void => {
    c.font = '600 11px -apple-system, system-ui, sans-serif';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(5,7,11,.85)';
    c.strokeText(s, x, y);
    c.fillStyle = color;
    c.fillText(s, x, y);
  };
  const draw = (): void => {
    if (!ctx) return;
    const cw = Math.max(1, el.clientWidth);
    const ch = Math.max(1, el.clientHeight);
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (cw !== w || ch !== hgt || d !== dpr) {
      w = cw;
      hgt = ch;
      dpr = d;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      needFit = needFit || mpp === 1e4;
    }
    const pred = ses.prediction();
    const fb = frameBody();
    if (needFit) fit();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!fb) return;
    ctx.lineJoin = 'round';
    const tgt = ses.target();

    // worlds
    for (const b of ses.bodies()) {
      const x = sx(b.r.x - fb.r.x);
      const y = sy(b.r.z - fb.r.z);
      const rpx = b.def.radius / mpp;
      if (x < -rpx - 80 || x > w + rpx + 80 || y < -rpx - 40 || y > hgt + rpx + 40) continue;
      const star = b.def === ses.system.bodies[0];
      const atm = b.def.atmosphere;
      if (atm && rpx > 3) {
        ctx.beginPath();
        ctx.arc(x, y, (b.def.radius + atm.height) / mpp, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(111,227,255,.10)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2.5, rpx), 0, Math.PI * 2);
      ctx.fillStyle = star ? '#ffb46a' : '#27303c';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = tgt && tgt.id === b.id ? '#6fe3ff' : star ? '#ffd9a8' : '#5b6b7d';
      ctx.stroke();
      ctx.textAlign = 'center';
      label(ctx, b.def.name, x, rpx > 40 ? y + 4 : y + Math.max(2.5, rpx) + 14, tgt && tgt.id === b.id ? '#6fe3ff' : '#9fb0c2');
    }

    // the target's path, then ours
    if (pred.targetCount > 1) {
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = 'rgba(111,227,255,.7)';
      line(ctx, pred.targetPoints, pred.targetCount);
      ctx.setLineDash([]);
    }
    if (pred.count > 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#e9f2fb';
      line(ctx, pred.points, pred.count);
    }

    // events
    const sel = burnOf(selected);
    ctx.textAlign = 'left';
    for (const ev of pred.events) {
      const x = sx(ev.r.x);
      const y = sy(ev.r.z);
      if (x < -20 || x > w + 20 || y < -20 || y > hgt + 20) continue;
      const burn = ev.kind === 'burn';
      const bad = ev.kind === 'impact' || ev.kind === 'atmosphere';
      const color = burn ? '#ffb454' : bad ? '#ff5a4d' : ev.kind === 'closestApproach' ? '#6fe3ff' : '#8fe3a5';
      const on = burn && sel && Math.abs(sel.t - ev.t) < 1;
      ctx.beginPath();
      ctx.arc(x, y, burn ? (on ? 9 : 6) : 4, 0, Math.PI * 2);
      ctx.lineWidth = on ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (bad) {
        ctx.beginPath();
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
      }
      const val = burn ? `Δv ${fmtSpeed(ev.value)}` : ev.kind === 'impact' ? '' : fmtDistance(ev.value);
      label(ctx, `${EVENT_LABEL[ev.kind]} ${val}`.trim(), x + 10, y - 8, color);
    }

    // craft: stations as diamonds, the ship as an arrow along its velocity
    for (const c of ses.craft()) {
      const x = sx(c.r.x - fb.r.x);
      const y = sy(c.r.z - fb.r.z);
      if (x < -40 || x > w + 40 || y < -40 || y > hgt + 40) continue;
      if (c.isPlayer) {
        const a = Math.atan2(c.v.z - fb.v.z, c.v.x - fb.v.x);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(-6, 5.5);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-6, -5.5);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
      } else {
        const on = !!tgt && tgt.id === c.id;
        ctx.beginPath();
        ctx.moveTo(x, y - 5.5);
        ctx.lineTo(x + 5.5, y);
        ctx.lineTo(x, y + 5.5);
        ctx.lineTo(x - 5.5, y);
        ctx.closePath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = on ? '#6fe3ff' : '#9fb0c2';
        ctx.stroke();
        ctx.textAlign = 'left';
        label(ctx, c.name, x + 9, y + 14, on ? '#6fe3ff' : '#9fb0c2');
      }
    }

    // scale bar
    const target = mpp * 90;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = (target / pow >= 5 ? 5 : target / pow >= 2 ? 2 : 1) * pow;
    const bx = Math.max(16, parseFloat(getComputedStyle(el).getPropertyValue('--gx-l')) || 16);
    const by = Math.min(hgt / 2, 150);
    ctx.beginPath();
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + nice / mpp, by);
    ctx.lineTo(bx + nice / mpp, by - 4);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#7d8ea0';
    ctx.stroke();
    ctx.textAlign = 'left';
    label(ctx, fmtDistance(nice), bx, by + 14, '#7d8ea0');
  };

  let acc = 1;
  return {
    el,
    show() {
      if (!el.isConnected) host.root.appendChild(el);
      el.style.display = '';
      needFit = true;
      acc = 1;
    },
    hide() {
      el.style.display = 'none';
      pts.clear();
    },
    update(dt) {
      draw();
      acc += dt;
      if (acc < 0.25) return;
      acc = 0;
      const fi = ses.flight();
      const id = ses.prediction().frameBodyId;
      const name = ses.system.bodies.find((b) => b.id === id)?.name ?? id;
      const t = `${name} · ${fi.situation}`;
      if (titleMain.textContent !== t) titleMain.textContent = t;
      const wv = ses.warp();
      const x = `×${fmtX(wv.achieved)}`;
      if (wX.textContent !== x) wX.textContent = x;
      wX.classList.toggle('is-fast', wv.achieved > 1.05);
      updateEditor();
    },
    dispose() {
      el.remove();
    },
  };
}
