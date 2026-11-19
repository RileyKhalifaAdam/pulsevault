#!/usr/bin/env node
// End-to-end check of flying the Wren by hand, in iPhone 15 emulation (software GL, low quality). Every input
// is a real touch (CDP touch events -> the page's pointer handlers -> a ray into the 3D cockpit); the state
// is read back through window.__tidelock.session only to assert on it.
// tap to begin -> standing behind the left seat, walk stick up -> tap the harness -> seated, walk stick gone,
// nothing drawn over the view -> every console device has its own patch of glass -> PRO lamp -> the ship
// turns prograde -> DRIVE ARM -> throttle lever up: thrust, apoapsis rises -> lever back, disarm -> rotation
// controller: the ship turns, the stick centres -> NAV pages -> pinch on a screen leans in -> unstrap -> walk
// aft to the bunk -> lie down, sleep, time runs -> a touch wakes -> three fingers: system menu -> landscape.
// Touch roles (src/app/input.ts): walk + look together never zooms, a touch that starts in the walk zone never
// turns the head, a pinch is two head fingers; FLT ASSIST lights and names its reference on the FLIGHT screen.
//   node e2e/cockpit.cjs [--no-build] [--deck-shots]      screenshots: shots/fix-*.png (4); with --deck-shots also shots/deck-*.png
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { tap, pump, settle, sleep, BTN } = require('./artifact.cjs');

const CONSOLE = ['screen-flight', 'screen-nav', 'hold-off', 'hold-stab', 'hold-pro', 'hold-retro', 'hold-tgt', 'hold-nml', 'hold-anml', 'hold-rout', 'hold-rin', 'hold-dock',
  'target-next', 'thc', 'thc-z', 'rhc', 'roll', 'throttle', 'drive-arm', 'undock', 'flt-assist'];
const DECK_SHOTS = process.argv.includes('--deck-shots');
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const LOOK_RATE = 0.0042;
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
const km = (m) => `${(m / 1000).toFixed(1)} km`;

/** Everything the checks read, in one round trip. */
const st = (f) => f.evaluate(() => {
  const t = window.__tidelock, g = t.session, c = g.crew(), p = g.player(), fl = g.flight();
  const dev = {};
  for (const d of g.devices()) dev[d.id] = { x: +d.x.toFixed(3), y: +d.y.toFixed(3), lit: d.lit, held: d.held, reach: d.reachable, page: d.page };
  const cr = g.craft().find((k) => k.id === p.craftId);
  const ins = t.frame.instruments;
  const ring = document.querySelector('.walk-stick');
  const menu = document.querySelector('.tls-pause');
  return { screen: t.screen, mode: g.mode(), posture: c.posture, asleep: c.asleep, room: c.roomId, x: c.pos.x, y: c.pos.y, z: c.pos.z, eye: { x: c.eye.x, y: c.eye.y, z: c.eye.z },
    yaw: c.yaw, pitch: c.pitch, speed: Math.hypot(c.vel.x, c.vel.y, c.vel.z), time: g.time(), hold: p.hold, throttle: p.throttle, destroyed: p.destroyed, docked: p.dockedTo,
    apo: fl.apoapsisAlt, peri: fl.periapsisAlt, accel: fl.accel, q: cr ? { x: cr.q.x, y: cr.q.y, z: cr.q.z, w: cr.q.w } : null, dev, zoom: t.input.zoom, lights: g.cabinLights(),
    warp: g.warp().achieved, cam: t.frame.camera.mode, assist: p.assist, assistRef: p.assistRef,
    scr: ins ? { assist: ins.flight.assist, ref: ins.flight.assistRef, rel: ins.flight.assistSpeed, cmd: ins.flight.assistCmd } : null,
    fl: ins ? { armed: ins.flight.armed, throttle: ins.flight.throttle, hold: ins.flight.hold, accelG: ins.flight.accelG, spin: ins.flight.spin, apo: ins.flight.apoapsisAlt,
      markers: ins.flight.markers.map((m) => ({ kind: m.kind, x: +m.x.toFixed(3), y: +m.y.toFixed(3), z: +m.z.toFixed(3) })) } : null,
    stick: !!ring && ring.style.display !== 'none' && ring.getClientRects().length > 0, menu: !!menu && !menu.hidden && menu.getClientRects().length > 0,
    err: !!document.getElementById('tl-error') };
});

/** Which patch of the glass belongs to which device: a grid of rays through the real picker. */
const pickMap = (f, step = 4) => f.evaluate((k) => {
  const s = window.__tidelock.scene, W = window.innerWidth, H = window.innerHeight, acc = {};
  for (let y = 2; y < H; y += k) for (let x = 2; x < W; x += k) {
    const p = s.pickDevice(x, y);
    if (!p) continue;
    const a = acc[p.id] || (acc[p.id] = { n: 0, sx: 0, sy: 0, pts: [], x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 });
    a.n++; a.sx += x; a.sy += y; a.pts.push([x, y]);
    a.x0 = Math.min(a.x0, x); a.x1 = Math.max(a.x1, x); a.y0 = Math.min(a.y0, y); a.y1 = Math.max(a.y1, y);
  }
  const out = {};
  for (const id of Object.keys(acc)) {
    const a = acc[id], cx = a.sx / a.n, cy = a.sy / a.n;
    let best = a.pts[0], bd = Infinity;
    for (const q of a.pts) { const d = Math.hypot(q[0] - cx, q[1] - cy); if (d < bd) { bd = d; best = q; } }
    out[id] = { x: best[0], y: best[1], n: a.n, w: a.x1 - a.x0 + k, h: a.y1 - a.y0 + k };
  }
  return out;
}, step);

/** What is painted over the canvas: every visible element with text, a background, a border or a button. */
const painted = (f) => f.evaluate(() => {
  const out = [];
  for (const e of document.body.querySelectorAll('*')) {
    if (['CANVAS', 'SCRIPT', 'STYLE'].includes(e.tagName)) continue;
    if (!e.getClientRects().length) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden') continue;
    let op = 1;
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
    if (op < 0.02) continue;
    const text = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const bg = cs.backgroundColor && !/^rgba\(.*,\s*0\)$|^transparent$/.test(cs.backgroundColor);
    const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    if (text || bg || border || cs.backgroundImage !== 'none' || e.tagName === 'BUTTON' || e.tagName === 'svg') out.push(`${e.tagName.toLowerCase()}.${String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)}`);
  }
  return out;
});

async function fingers(page, f = page.mainFrame()) {
  const cdp = await page.context().newCDPSession(page);
  const pts = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, timestamp: Date.now() / 1000, touchPoints: [...pts.entries()].map(([id, p]) => ({ x: Math.round(p.x), y: Math.round(p.y), id })) });
  const down = async (id, x, y) => { pts.set(id, { x, y }); await send('touchStart'); };
  const move = async (id, x, y) => { pts.set(id, { x, y }); await send('touchMove'); };
  const up = async (id) => { pts.delete(id); await send('touchEnd'); };
  /** A fingertip tap. */
  // (down and up are queued together: waiting for the page to acknowledge the down would hold the finger on
  // the glass for a whole software-rendered frame, which is longer than a tap)
  const tapAt = async (x, y) => { const a = down(1, x, y); const b = up(1); await Promise.all([a, b]); await settle(f); };
  /** Finger `id` slides from where it is to (x, y). */
  const slide = async (id, x, y, steps = 6) => { const a = pts.get(id); for (let i = 1; i <= steps; i++) await move(id, a.x + ((x - a.x) * i) / steps, a.y + ((y - a.y) * i) / steps); };
  let look = { x: 300, y: 150 };
  const setLook = (p) => { look = p; };
  /** One drag of the looking finger (slow enough not to be a flick). */
  const drag = async (dx, dy) => { await down(2, look.x, look.y); await slide(2, look.x + dx, look.y + dy, 4); await sleep(330); await up(2); };
  const lookTo = async (yaw, pitch) => {
    for (let i = 0; i < 30; i++) {
      const c = await st(f);
      const dy = wrap(yaw - c.yaw), dp = pitch - c.pitch;
      if (Math.abs(dy) < 0.03 && Math.abs(dp) < 0.03) return true;
      await drag(Math.max(-85, Math.min(85, -dy / LOOK_RATE)), Math.max(-85, Math.min(85, -dp / LOOK_RATE)));
    }
    return false;
  };
  /** Turn the head toward a ship-local point. */
  const aimAt = async (p, pitchOffset = 0) => {
    const s = await st(f), dx = p.x - s.eye.x, dy = p.y - s.eye.y, dz = p.z - s.eye.z;
    return lookTo(Math.atan2(-dx, -dz), Math.max(-1.3, Math.atan2(dy, Math.hypot(dx, dz)) + pitchOffset));
  };
  /** Walk to a ship-local point with the left thumb. */
  const walkTo = async (stick, tx, tz, tol = 0.14) => {
    let d = Infinity;
    if ((await st(f)).mode !== 'onFoot') return Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      await down(1, stick.x, stick.y);
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        const c = await st(f);
        const dx = tx - c.x, dz = tz - c.z;
        d = Math.hypot(dx, dz);
        if (d < tol * 0.7) break;
        const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw), rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
        const m = Math.min(1, Math.max(0.1, d / 1.6)) / d;
        await move(1, stick.x + (dx * rx + dz * rz) * m * 58, stick.y - (dx * fx + dz * fz) * m * 58);
        await settle(f);
        if (d > 1.6) await pump(f, 5);
      }
      await up(1);
      for (let i = 0; i < 40; i++) { await settle(f); if ((await st(f)).speed < 0.02) break; }
      const c = await st(f);
      d = Math.hypot(tx - c.x, tz - c.z);
      if (d < tol) break;
    }
    return d;
  };
  return { down, move, up, tapAt, slide, drag, lookTo, aimAt, walkTo, setLook };
}

async function run() {
  if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { baseUrl, close } = await serveDist();
  const url = `${baseUrl}/index.html?q=low&fresh=1`;
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

  /** Title -> standing -> strapped in. Returns the device map from the seat. */
  async function boardAndSit(page, f, h, tag, shot) {
    await page.goto(url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
    await f.evaluate(() => {
      // a record of what the touches did to the devices (the session's own methods, wrapped)
      const g = window.__tidelock.session;
      window.__trace = [];
      for (const k of ['tapDevice', 'grabDevice']) { const o = g[k].bind(g); g[k] = (...a) => { const r = o(...a); window.__trace.push(`${k}(${a[0]})=${r}`); return r; }; }
      window.addEventListener('pointerdown', (e) => window.__trace.push(`down@${Math.round(e.clientX)},${Math.round(e.clientY)} t=${Math.round(e.timeStamp)} on ${e.target.tagName}.${e.target.className}`), true);
      window.addEventListener('pointerup', (e) => window.__trace.push(`up t=${Math.round(e.timeStamp)}`), true);
      window.addEventListener('pointercancel', (e) => window.__trace.push(`cancel t=${Math.round(e.timeStamp)}`), true);
    });
    let s = await st(f);
    check(s.screen === 'title', `${tag}title screen is up`);
    const vw = page.viewportSize();
    await h.tapAt(vw.width / 2, vw.height * 0.45);
    await sleep(1200);
    await settle(f);
    // the title fades through black into the pilot's eyes: wait for the eyes to open (slow frames in software GL)
    await f.waitForFunction(() => [...document.body.children].every((e) => e.tagName === 'CANVAS' || parseFloat(getComputedStyle(e).opacity) < 0.02 || getComputedStyle(e).backgroundColor !== 'rgb(0, 0, 0)'), null, { timeout: 30000 }).catch(() => undefined);
    s = await st(f);
    check(s.screen === 'flight' && s.mode === 'onFoot' && s.posture === 'walking' && s.room === 'cockpit' && s.cam === 'interior',
      `${tag}tap to begin: standing in the cockpit (mode=${s.mode}, posture=${s.posture}, room=${s.room}, at ${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
    check(s.stick, `${tag}walk stick is shown while on foot`);
    let ui = await painted(f);
    check(ui.every((e) => /walk-stick/.test(e)), `${tag}on foot, the only thing over the view is the walk stick: [${ui.join(', ')}]`);
    // look down at the buckle in the seat and tap it
    const cockpit = await f.evaluate(() => window.__tidelock.session.cockpit().devices.map((d) => ({ id: d.id, pos: d.pos })));
    const buckle = cockpit.find((d) => d.id === 'harness').pos;
    await h.aimAt(buckle, 0.15);
    await settle(f);
    if (shot) await shot('01-standing');
    let map = await pickMap(f);
    check(!!map.harness && s.dev.harness.reach, `${tag}harness buckle is under a finger from beside the seat (${map.harness ? `${map.harness.n} cells at ${map.harness.x}, ${map.harness.y}` : 'not pickable'}; reachable=${s.dev.harness.reach})`);
    if (map.harness) await h.tapAt(map.harness.x, map.harness.y);
    await pump(f, 20);
    await sleep(400);
    await settle(f);
    s = await st(f);
    if (s.mode !== 'helm') console.log(`     trace: ${(await f.evaluate(() => window.__trace.slice(-14))).join(' | ')}`);
    check(s.mode === 'helm' && s.posture === 'seated' && s.dev.harness.lit, `${tag}tapped the harness: strapped in (mode=${s.mode}, posture=${s.posture}, yaw ${s.yaw.toFixed(2)}, pitch ${(s.pitch * 57.3).toFixed(0)} deg)`);
    check(!s.stick, `${tag}walk stick is gone in the seat`);
    ui = await painted(f);
    check(ui.length === 0, `${tag}seated: nothing is drawn over the view (no HUD, no buttons): [${ui.join(', ')}]`);
    map = await pickMap(f);
    const missing = CONSOLE.filter((id) => !map[id]);
    const small = CONSOLE.filter((id) => map[id] && (map[id].n * 16 < 500));
    const cost = await f.evaluate(() => { const k = window.__tidelock.scene.stats(); return `${k.drawCalls} draw calls, ${k.triangles} triangles`; });
    console.log(`     ${tag}frame cost from the seat: ${cost}`);
    check(missing.length === 0, `${tag}every console device can be touched from the seat without moving the head${missing.length ? ` — hidden: ${missing.join(', ')}` : ''}`);
    console.log(`     ${tag}touch patches (CSS px): ${CONSOLE.filter((id) => map[id]).map((id) => `${id} ${map[id].w}x${map[id].h}@${map[id].x},${map[id].y}`).join('  ')}`);
    check(small.length === 0, `${tag}every device has at least 500 px² of glass to itself${small.length ? ` — small: ${small.map((id) => `${id} ${map[id].n * 16}`).join(', ')}` : ''}`);
    return map;
  }

  // ------------------------------------------------------------------ portrait
  if (only !== 'landscape') {
    const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    const shot = async (name) => {
      const fix = name.startsWith('fix-');
      if (!fix && !DECK_SHOTS) return;
      await settle(f); await sleep(350); await settle(f);
      await page.screenshot({ timeout: 180000, path: path.join(shots, fix ? `${name}.png` : `deck-${name}.png`) });
    };
    const free = (pts) => f.evaluate((q) => q.every(([x, y]) => !window.__tidelock.scene.pickDevice(x, y)), pts);
    try {
      const h = await fingers(page);
      let map = await boardAndSit(page, f, h, '', shot);
      let s = await st(f);
      await shot('02-seated');

      // ---- FLT ASSIST: a latching lamp button on the desk; lit = on, the FLIGHT screen names the reference
      check(s.assist === 'off' && !s.dev['flt-assist'].lit && !!s.scr && s.scr.assist === 'OFF', `Flight Assist is off to begin with (lamp dark, screen says ${s.scr ? s.scr.assist : '?'})`);
      await h.tapAt(map['flt-assist'].x, map['flt-assist'].y);
      await pump(f, 12);
      await settle(f);
      s = await st(f);
      check(s.dev['flt-assist'].lit && s.assist === 'on' && !!s.scr && s.scr.assist === 'ON' && /chandler/i.test(s.scr.ref) && s.scr.rel < 3 && s.scr.cmd === 0 && s.throttle === 0,
        `tapped FLT ASSIST: lamp lit, FLIGHT screen shows ASSIST ${s.scr ? s.scr.assist : '?'}, reference "${s.scr ? s.scr.ref : '?'}", ${s.scr ? s.scr.rel.toFixed(2) : '?'} -> ${s.scr ? s.scr.cmd.toFixed(1) : '?'} m/s`);
      await shot('fix-2-console-assist');
      {
        // lever at zero: the computer brings the ship to rest relative to the station with the RCS
        const rel0 = s.scr.rel;
        for (let i = 0; i < 40 && s.scr.rel >= 0.08; i++) { await pump(f, 30); await settle(f); s = await st(f); }
        check(s.scr.rel < 0.1 && s.throttle === 0, `Flight Assist nulled the drift relative to the station: ${rel0.toFixed(2)} -> ${s.scr.rel.toFixed(2)} m/s`);
      }
      {
        // lean in on the FLIGHT screen to read the ASSIST line (the zoom is set directly: this is only a picture)
        const scr = await f.evaluate(() => window.__tidelock.session.cockpit().devices.find((d) => d.id === 'screen-flight').pos);
        const look = { yaw: s.yaw, pitch: s.pitch };
        await h.aimAt(scr);
        await f.evaluate(() => { window.__tidelock.input.zoom = 2.6; });
        await shot('fix-3-flight-screen');
        await f.evaluate(() => { window.__tidelock.input.zoom = 1; });
        await h.lookTo(look.yaw, look.pitch);
        await settle(f);
        map = await pickMap(f);
      }
      await h.tapAt(map['flt-assist'].x, map['flt-assist'].y);
      await pump(f, 12);
      s = await st(f);
      check(!s.dev['flt-assist'].lit && s.assist === 'off', 'tapped FLT ASSIST again: off, lamp dark');

      // ---- attitude hold: PRO
      const q0 = s.q;
      await h.tapAt(map['hold-pro'].x, map['hold-pro'].y);
      await pump(f, 10);
      s = await st(f);
      check(s.dev['hold-pro'].lit && s.hold === 'prograde' && Object.keys(s.dev).filter((id) => id.startsWith('hold-') && s.dev[id].lit).length === 1, `tapped PRO: its lamp alone is lit, hold = ${s.hold}`);
      let pro = null;
      for (let i = 0; i < 90; i++) {
        await pump(f, 30);
        await settle(f);
        s = await st(f);
        pro = s.fl && s.fl.markers.find((m) => m.kind === 'prograde');
        if (pro && pro.z < -0.999 && s.fl.spin < 0.003) break;
      }
      check(!!pro && pro.z < -0.995, `the ship turned prograde: nose to prograde ${pro ? (Math.acos(Math.min(1, -pro.z)) * 57.3).toFixed(1) : '?'} deg, turned ${(qAngle(q0, s.q) * 57.3).toFixed(0)} deg in all, spin ${s.fl ? s.fl.spin.toFixed(4) : '?'} rad/s`);

      // ---- burn: arm, lever forward, lever back, safe
      const apo0 = s.apo, peri0 = s.peri;
      await h.tapAt(map['drive-arm'].x, map['drive-arm'].y);
      await pump(f, 10);
      await settle(f);
      s = await st(f);
      check(s.dev['drive-arm'].lit && s.dev['drive-arm'].x === 1, 'flipped DRIVE ARM: armed, lamp on');
      const th = map.throttle;
      await h.down(1, th.x, th.y);
      await h.slide(1, th.x, th.y - 160, 8);
      await settle(f);
      const look0 = { yaw: s.yaw, pitch: s.pitch };
      await pump(f, 75);
      await sleep(500);
      await settle(f);
      s = await st(f);
      check(s.dev.throttle.held && s.dev.throttle.x > 0.85 && s.throttle > 0.8 && s.accel > 1, `dragged the DRIVE lever forward: lever ${s.dev.throttle.x}, thrust ${s.throttle.toFixed(2)}, ${s.accel.toFixed(1)} m/s² felt`);
      check(Math.abs(s.yaw - look0.yaw) < 1e-6 && Math.abs(s.pitch - look0.pitch) < 1e-6, 'the head did not move while the hand was on the lever');
      check(!!s.fl && s.fl.armed && s.fl.throttle > 0.8 && s.fl.accelG > 0.1 && s.fl.apo > apo0, `FLIGHT screen data: ARMED, thrust ${s.fl ? (s.fl.throttle * 100).toFixed(0) : '?'} %, ${s.fl ? s.fl.accelG.toFixed(2) : '?'} g, apoapsis ${km(apo0)} -> ${s.fl ? km(s.fl.apo) : '?'}`);
      await shot('03-burn');
      await h.up(1);
      await pump(f, 15);
      s = await st(f);
      check(s.dev.throttle.x > 0.85 && !s.dev.throttle.held && s.throttle > 0.8, `let go: the lever stays where it was put (${s.dev.throttle.x})`);
      await settle(f);
      map = await pickMap(f);
      check(!!map.throttle, 'the lever can be taken again');
      await h.down(1, map.throttle.x, map.throttle.y);
      await h.slide(1, map.throttle.x, map.throttle.y + 175, 8);
      await pump(f, 30);
      await h.up(1);
      await pump(f, 15);
      s = await st(f);
      check(s.dev.throttle.x < 0.03 && s.throttle === 0, `dragged the lever back: lever ${s.dev.throttle.x}, thrust ${s.throttle}`);
      check(s.apo > apo0 + 1000, `the burn raised the apoapsis: ${km(apo0)} -> ${km(s.apo)} (periapsis ${km(peri0)} -> ${km(s.peri)})`);
      await settle(f);
      map = await pickMap(f);
      await h.tapAt(map['drive-arm'].x, map['drive-arm'].y);
      await pump(f, 10);
      s = await st(f);
      check(!s.dev['drive-arm'].lit && s.dev['drive-arm'].x === 0, 'flipped DRIVE ARM again: safe');

      // ---- rotation hand controller
      const q1 = s.q;
      await h.down(1, map.rhc.x, map.rhc.y);
      await h.slide(1, map.rhc.x + 56, map.rhc.y, 6);
      await pump(f, 60);
      await sleep(400);
      await settle(f);
      s = await st(f);
      const turned = qAngle(q1, s.q);
      check(s.dev.rhc.held && s.dev.rhc.x > 0.7 && turned > 0.03, `dragged ROTATE to the right: stick ${s.dev.rhc.x}, the ship turned ${(turned * 57.3).toFixed(1)} deg in 2 s (spin ${s.fl ? s.fl.spin.toFixed(3) : '?'} rad/s)`);
      await shot('04-rotate');
      await h.up(1);
      await pump(f, 30);
      s = await st(f);
      check(!s.dev.rhc.held && Math.abs(s.dev.rhc.x) < 0.03 && Math.abs(s.dev.rhc.y) < 0.03, `let go: the stick centred (${s.dev.rhc.x}, ${s.dev.rhc.y})`);

      // ---- NAV pages
      const nav = map['screen-nav'];
      const pages = [s.dev['screen-nav'].page];
      for (let i = 0; i < 3; i++) {
        await h.tapAt(nav.x, nav.y);
        await pump(f, 6);
        await sleep(500);
        await settle(f);
        s = await st(f);
        pages.push(s.dev['screen-nav'].page);
        if (s.dev['screen-nav'].page === 'docking') await shot('05-nav-docking');
      }
      check(pages.join(' > ') === 'orbit > docking > systems > orbit', `tapping NAV pages it: ${pages.join(' > ')}`);
      await h.tapAt(nav.x, nav.y);
      await h.tapAt(nav.x, nav.y);
      await pump(f, 6);
      // ---- two fingers that start on a screen are two hands on a control: no zoom, no look, no page turn
      s = await st(f);
      const before = { yaw: s.yaw, pitch: s.pitch, page: s.dev['screen-nav'].page };
      await h.down(1, nav.x - 22, nav.y);
      await h.down(2, nav.x + 22, nav.y);
      for (let i = 1; i <= 6; i++) { await h.move(1, nav.x - 22 - 6 * i, nav.y); await h.move(2, nav.x + 22 + 6 * i, nav.y); }
      await h.up(2);
      await h.up(1);
      await settle(f);
      s = await st(f);
      check(s.zoom === 1 && s.yaw === before.yaw && s.pitch === before.pitch && s.dev['screen-nav'].page === before.page, `two fingers spread on the NAV screen (hands, not the head): zoom x${s.zoom}, head still, page ${s.dev['screen-nav'].page}`);
      // ---- pinch on the glass above the console: lean in
      const py = nav.y - 200;
      check(await free([[nav.x - 70, py], [nav.x + 70, py], [nav.x - 22, py], [nav.x + 22, py]]), 'the glass above the console is free of devices');
      await h.down(1, nav.x - 22, py);
      await h.down(2, nav.x + 22, py);
      for (let i = 1; i <= 6; i++) { await h.move(1, nav.x - 22 - 6 * i, py); await h.move(2, nav.x + 22 + 6 * i, py); }
      await h.up(2);
      await h.up(1);
      await sleep(600);
      await settle(f);
      s = await st(f);
      check(s.zoom > 2 && s.dev['screen-nav'].page === before.page, `pinched out with two head fingers: leaned in x${s.zoom.toFixed(2)}`);
      await shot('06-lean-systems');
      await h.down(1, nav.x - 70, nav.y - 200);
      await h.down(2, nav.x + 70, nav.y - 200);
      for (let i = 1; i <= 6; i++) { await h.move(1, nav.x - 70 + 9 * i, nav.y - 200); await h.move(2, nav.x + 70 - 9 * i, nav.y - 200); }
      await h.up(2);
      await h.up(1);
      await settle(f);
      s = await st(f);
      check(s.zoom < 1.05, `pinched in: sat back (x${s.zoom.toFixed(2)})`);

      // ---- unstrap, walk aft, sleep
      map = await pickMap(f);
      if (!map.harness) { await h.lookTo(0, -1.0); await settle(f); map = await pickMap(f); }
      check(!!map.harness, `the buckle can be touched from the seat (${map.harness ? `${map.harness.w}x${map.harness.h} px at ${map.harness.x}, ${map.harness.y}` : 'not found'})`);
      if (map.harness) await h.tapAt(map.harness.x, map.harness.y);
      await pump(f, 20);
      await settle(f);
      s = await st(f);
      check(s.mode === 'onFoot' && s.stick, `tapped the harness again: on foot (posture=${s.posture}), walk stick back`);
      await h.lookTo(0, 0);
      const stick = { x: 100, y: 640 };
      await h.walkTo(stick, 0, -12.2); // behind the seats, facing the console

      // ---- touch roles on foot: the left thumb walks, the right finger looks, and nothing zooms
      await h.lookTo(0, 0);
      s = await st(f);
      const a0 = s;
      await h.down(1, 100, 640);
      await h.slide(1, 100, 700, 4); // back, toward the companionway door
      await h.down(2, 300, 250);
      await h.slide(2, 230, 250, 6);
      await pump(f, 24);
      await settle(f);
      s = await st(f);
      const walked = Math.hypot(s.x - a0.x, s.z - a0.z);
      check(walked > 0.15 && Math.abs(wrap(s.yaw - a0.yaw)) > 0.2 && s.zoom === 1 && s.stick,
        `walk (left thumb) + look (right finger) together: moved ${walked.toFixed(2)} m, head turned ${(wrap(s.yaw - a0.yaw) * 57.3).toFixed(1)} deg, zoom x${s.zoom}`);
      await shot('fix-4-walk-and-look');
      await h.up(2);
      await h.up(1);
      for (let i = 0; i < 20; i++) { await settle(f); if ((await st(f)).speed < 0.02) break; }
      // a touch that starts in the walk zone never turns the head, even when it wanders out; a second one there does nothing
      s = await st(f);
      const b0 = s;
      await h.down(1, 150, 600);
      await h.slide(1, 360, 180, 8);
      await h.down(2, 60, 760);
      await h.slide(2, 190, 500, 6);
      await pump(f, 6);
      s = await st(f);
      check(s.yaw === b0.yaw && s.pitch === b0.pitch && s.zoom === 1 && Math.hypot(s.x - b0.x, s.z - b0.z) > 0.02,
        `two touches that began in the walk zone, dragged across the screen: head ${((s.yaw - b0.yaw) * 57.3).toFixed(2)}, ${((s.pitch - b0.pitch) * 57.3).toFixed(2)} deg, zoom x${s.zoom}, walked ${Math.hypot(s.x - b0.x, s.z - b0.z).toFixed(2)} m`);
      await h.up(2);
      await h.up(1);
      await pump(f, 4);
      s = await st(f);
      check(s.stick && Math.abs(s.yaw - b0.yaw) < 1e-9, 'lifted: the stick is back at rest, the head still has not moved');
      // two fingers on the right pinch: zoom changes; walking still works with the view narrowed; pinch back
      check(await free([[250, 170], [330, 170], [210, 170], [370, 170]]), 'the right-hand glass is free of devices');
      await h.down(1, 250, 170);
      await h.down(2, 330, 170);
      for (let i = 1; i <= 5; i++) { await h.move(1, 250 - 8 * i, 170); await h.move(2, 330 + 8 * i, 170); }
      await settle(f);
      s = await st(f);
      const z1 = s.zoom;
      await h.up(1);
      await h.slide(2, 372, 172, 2); // the finger that stays does not jump the view
      await settle(f);
      const c1 = await st(f);
      await h.up(2);
      check(z1 > 1.6 && Math.abs(wrap(c1.yaw - s.yaw)) < 0.01 && Math.abs(c1.pitch - s.pitch) < 0.01 && Math.abs(c1.zoom - z1) < 0.05, `two right-side fingers pinched out: zoom x${z1.toFixed(2)}; one lifts, the other stays: view moved ${(wrap(c1.yaw - s.yaw) * 57.3).toFixed(2)} deg`);
      s = await st(f);
      const c0 = s;
      await h.down(1, 100, 640);
      await h.slide(1, 100, 590, 4);
      await pump(f, 16);
      s = await st(f);
      await h.up(1);
      check(Math.hypot(s.x - c0.x, s.z - c0.z) > 0.08 && s.zoom === c0.zoom && s.zoom > 1.6 && s.yaw === c0.yaw, `walking still works after the pinch: ${Math.hypot(s.x - c0.x, s.z - c0.z).toFixed(2)} m, zoom still x${s.zoom.toFixed(2)}`);
      await h.down(1, 210, 170);
      await h.down(2, 370, 170);
      for (let i = 1; i <= 6; i++) { await h.move(1, 210 + 10 * i, 170); await h.move(2, 370 - 10 * i, 170); }
      await h.up(2);
      await h.up(1);
      await settle(f);
      s = await st(f);
      check(s.zoom === 1, `pinched back in: zoom x${s.zoom}`);
      for (let i = 0; i < 20; i++) { await settle(f); if ((await st(f)).speed < 0.02) break; }

      // ---- through the companionway: the lounge's forward bulkhead with the LIGHTS switch beside the door
      await h.lookTo(0, 0);
      await h.walkTo(stick, 0, -12.2);
      await h.walkTo(stick, 0, -11.0);
      await h.walkTo(stick, 0, -9.6);
      await h.walkTo(stick, -0.9, -9.4);
      await h.aimAt({ x: -1.1, y: 0.2, z: -10.4 });
      await shot('fix-1-bulkhead');
      // ---- aft down the lounge and the corridor into the port cabin, beside the bed
      await h.lookTo(0, 0);
      await h.walkTo(stick, 0, -9.0);
      await h.walkTo(stick, 0, -5.4);
      await h.walkTo(stick, 0, -3.0);
      await h.walkTo(stick, 0, -1.6);
      await h.walkTo(stick, -1.65, -1.6);
      const d = await h.walkTo(stick, -1.7, -3.4, 0.1);
      s = await st(f);
      check(d < 0.2 && s.room === 'cabin-port', `walked aft with the left thumb to the port cabin (${s.room}, ${d.toFixed(2)} m from the bedside)`);
      await h.aimAt({ x: -2.6, y: -0.45, z: -3.4 });
      await settle(f);
      map = await pickMap(f);
      check(!!map.bunk, `the bunk is under a finger (${map.bunk ? `${map.bunk.w}x${map.bunk.h} px` : 'not found'})`);
      await shot('07-bunk');
      if (map.bunk) await h.tapAt(map.bunk.x, map.bunk.y);
      await pump(f, 30);
      s = await st(f);
      check(s.posture === 'lying', `tapped the bunk: ${s.posture}`);
      for (let i = 0; i < 20 && !s.asleep; i++) { await pump(f, 30); await settle(f); s = await st(f); }
      const t0 = s.time;
      await sleep(4000);
      await settle(f);
      s = await st(f);
      check(s.asleep && s.time - t0 > 600 && s.warp > 100, `lay still: asleep, and ${(s.time - t0).toFixed(0)} s of sim time passed in 4 s (rate x${s.warp.toFixed(0)})`);
      check(!s.stick, 'no walk stick while asleep');
      await h.tapAt(300, 300);
      await sleep(300);
      await settle(f);
      s = await st(f);
      const t1 = s.time;
      await sleep(1000);
      await settle(f);
      s = await st(f);
      check(!s.asleep && s.warp <= 1.01 && s.time - t1 < 30, `a touch wakes the pilot: awake, time back to x${s.warp.toFixed(0)}`);

      // ---- three fingers: the system menu
      await Promise.all([h.down(1, 120, 300), h.down(2, 200, 280), h.down(3, 280, 300), h.up(3), h.up(2), h.up(1)]);
      await sleep(500);
      s = await st(f);
      check(s.menu, 'three-finger tap opens the system menu');
      check(await tap(page, f, BTN, /how it works/), 'opened "How it works"');
      await sleep(400);
      const help = await f.evaluate(() => (document.querySelector('.tls-help') || { textContent: '' }).textContent);
      check(/A burn, in order/.test(help) && /harness/i.test(help) && /DRIVE ARM/.test(help), 'the how-to explains the controls and the order of a burn');
      await shot('08-menu-help');
      check(await tap(page, f, BTN, /back/), 'back');
      await sleep(300);
      check(await tap(page, f, BTN, /resume/), 'tapped Resume');
      await sleep(500);
      for (let i = 0; i < 6; i++) await settle(f);
      s = await st(f);
      const ui = await painted(f);
      check(!s.menu && ui.every((e) => /walk-stick/.test(e)), `menu closed; only the walk stick is on screen again: [${ui.join(', ')}]`);
      check(!s.err && !s.destroyed, 'no error panel, ship intact');
    } catch (err) {
      fail.push(String((err && err.stack) || err));
      console.log(String((err && err.stack) || err));
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors (portrait)');
    await browser.close();
  }

  // ------------------------------------------------------------------ landscape
  if (only !== 'portrait') {
    const { browser, page, errors } = await launch('iphone15l', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    const shot = async (name) => { if (!DECK_SHOTS) return; await settle(f); await sleep(350); await settle(f); await page.screenshot({ timeout: 180000, path: path.join(shots, `deck-${name}.png`) }); };
    try {
      const h = await fingers(page);
      h.setLook({ x: 640, y: 90 });
      const map = await boardAndSit(page, f, h, '[landscape] ', null);
      await h.tapAt(map['hold-retro'].x, map['hold-retro'].y);
      await pump(f, 10);
      let s = await st(f);
      check(s.dev['hold-retro'].lit && s.hold === 'retrograde', `[landscape] tapped RETRO: lamp lit, hold = ${s.hold}`);
      await h.down(1, map.thc.x, map.thc.y);
      await h.slide(1, map.thc.x - 50, map.thc.y, 5);
      await pump(f, 30);
      await sleep(400);
      s = await st(f);
      check(s.dev.thc.held && s.dev.thc.x < -0.6, `[landscape] dragged TRANSLATE left: stick ${s.dev.thc.x}`);
      await shot('09-landscape');
      await h.up(1);
      await pump(f, 20);
      s = await st(f);
      check(Math.abs(s.dev.thc.x) < 0.03 && !s.err, '[landscape] let go: centred');
    } catch (err) {
      fail.push(String((err && err.stack) || err));
      console.log(String((err && err.stack) || err));
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors (landscape)');
    await browser.close();
  }

  await close();
  if (fail.length) { console.error(`COCKPIT CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('COCKPIT CHECK PASSED');
}

module.exports = { fingers, pickMap, painted, st };
if (require.main === module) run();
