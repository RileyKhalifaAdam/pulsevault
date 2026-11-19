#!/usr/bin/env node
// End-to-end check of living aboard the Wren, in iPhone 15 emulation (software GL, low quality), driven by real
// touches (CDP touch events -> the page's pointer handlers):
// title -> Enter -> at the helm -> cockpit view and back -> LEAVE SEAT -> walk with the stick through the
// companionway into the lounge -> look by dragging -> walk and look with two fingers at once -> cabin lights off/on
// (switch on the lounge's forward wall) -> boots off, push off (floating), boots on -> down the corridor into the port
// cabin, lie on the bed, sleep an hour, wake, stand up -> walk back, take the helm, burn: the body is pressed aft, the seat stays locked, the orbit changes. One landscape pass.
//   node e2e/interior.cjs [--no-build]      screenshots: shots/live-*.png (at most 10)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { tap, pump, settle, snap, sleep, BTN } = require('./artifact.cjs');

const crew = (f) => f.evaluate(() => {
  const t = window.__tidelock, g = t.session, c = g.crew();
  return { mode: g.mode(), posture: c.posture, x: c.pos.x, y: c.pos.y, z: c.pos.z, yaw: c.yaw, pitch: c.pitch, boots: c.boots, gripped: c.gripped, room: c.roomId,
    speed: Math.hypot(c.vel.x, c.vel.y, c.vel.z), felt: { x: c.felt.x, y: c.felt.y, z: c.felt.z }, prompt: c.prompt ? c.prompt.kind : null, asleep: c.asleep,
    lights: g.cabinLights(), time: g.time(), cam: t.frame.camera.mode, eyeY: c.eye.y };
});
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const LOOK_RATE = 0.0048;

/** Fingers on the glass. `stick` is where the walking thumb lands, `look` where the looking finger lands. */
async function hands(page, stick, look) {
  const cdp = await page.context().newCDPSession(page);
  const f = page.mainFrame();
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id })) });
  /** Walk to a ship-local point (x, z) with the stick; returns the distance left. */
  async function walkTo(tx, tz, tol = 0.12) {
    // The stick is proportional (gentle near the goal). Headless software GL runs the page at a few frames a
    // second, so the thumb corrects once per frame and tries again if the body coasted past the spot.
    let d = Infinity;
    const dist = async () => { const c = await crew(f); return { c, dx: tx - c.x, dz: tz - c.z, d: Math.hypot(tx - c.x, tz - c.z) }; };
    for (let attempt = 0; attempt < 4; attempt++) {
      await send('touchStart', [{ ...stick, id: 1 }]);
      const until = Date.now() + 40000;
      while (Date.now() < until) {
        const q = await dist();
        d = q.d;
        if (d < tol * 0.7) break;
        const yaw = q.c.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const m = Math.min(1, Math.max(0.1, d / 1.6)) / d;
        const mz = (q.dx * fx + q.dz * fz) * m, mx = (q.dx * rx + q.dz * rz) * m;
        await send('touchMove', [{ x: stick.x + mx * 54, y: stick.y - mz * 54, id: 1 }]); // stick up the screen = forward
        await settle(f);
        if (d > 1.6) await pump(f, 5);
      }
      await send('touchEnd', []);
      for (let i = 0; i < 40; i++) { await settle(f); if ((await crew(f)).speed < 0.02) break; }
      d = (await dist()).d;
      if (d < tol) break;
    }
    return d;
  }
  /** One drag of the looking finger by (dx, dy) CSS px. */
  async function drag(dx, dy) {
    await send('touchStart', [{ ...look, id: 2 }]);
    for (let i = 1; i <= 4; i++) await send('touchMove', [{ x: look.x + (dx * i) / 4, y: look.y + (dy * i) / 4, id: 2 }]);
    await send('touchEnd', []);
  }
  /** Turn the head to (yaw, pitch) by dragging, the way a thumb would: several short drags. */
  async function lookTo(yaw, pitch = 0) {
    for (let i = 0; i < 24; i++) {
      const c = await crew(f);
      const dy = wrap(yaw - c.yaw), dp = pitch - c.pitch;
      if (Math.abs(dy) < 0.03 && Math.abs(dp) < 0.03) return true;
      await drag(Math.max(-85, Math.min(85, -dy / LOOK_RATE)), Math.max(-85, Math.min(85, -dp / LOOK_RATE)));
    }
    return false;
  }
  /** Walk forward and turn the head with two fingers down at once. */
  async function walkAndLook() {
    const a = await crew(f);
    await send('touchStart', [{ ...stick, id: 1 }]);
    await send('touchMove', [{ x: stick.x, y: stick.y - 50, id: 1 }]);
    await send('touchStart', [{ x: stick.x, y: stick.y - 50, id: 1 }, { ...look, id: 2 }]);
    for (let i = 1; i <= 4; i++) await send('touchMove', [{ x: stick.x, y: stick.y - 50, id: 1 }, { x: look.x - 10 * i, y: look.y, id: 2 }]);
    await settle(f);
    await pump(f, 12);
    const b = await crew(f);
    await send('touchEnd', []);
    await settle(f);
    await pump(f, 8);
    return { moved: Math.hypot(b.x - a.x, b.z - a.z), turned: wrap(b.yaw - a.yaw) };
  }
  return { walkTo, drag, lookTo, walkAndLook };
}

async function run() {
  if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { baseUrl, close } = await serveDist();
  const url = `${baseUrl}/index.html?q=low&fresh=1`;
  const overlaps = (f) => f.evaluate(() => {
    // visible on-foot / helm control plates must not sit on top of each other
    const els = [...document.querySelectorAll('.foot-info, .foot-menu, .foot-pad, .foot-sleep, .hud-main, .hud-col, .hud-warp')].filter((e) => e.getClientRects().length && !e.hidden && getComputedStyle(e).visibility !== 'hidden');
    const out = [];
    const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
    for (let i = 0; i < els.length; i++) {
      const a = els[i].getBoundingClientRect();
      if (a.left < -0.5 || a.top < -0.5 || a.right > W + 0.5 || a.bottom > H + 0.5) out.push(`${els[i].className} off screen`);
      for (let j = i + 1; j < els.length; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
        const b = els[j].getBoundingClientRect();
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${els[i].className} x ${els[j].className}`);
      }
    }
    return out;
  });

  // ------------------------------------------------------------------ portrait
  {
    const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    const shot = async (name) => { await settle(f); await sleep(350); await settle(f); await page.screenshot({ path: path.join(shots, `live-${name}.png`) }); };
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
      check((await snap(f)).screen === 'title', 'title screen is up');
      check(await tap(page, f, BTN, /^\s*enter/), 'tapped Enter');
      await sleep(1500);
      let s = await snap(f);
      let c = await crew(f);
      check(s.screen === 'flight' && s.hud && c.mode === 'helm' && c.posture === 'seated' && c.cam === 'chase', `at the helm, strapped in, chase view (mode=${c.mode}, posture=${c.posture}, camera=${c.cam})`);
      const lb = await f.evaluate(() => { const b = document.querySelector('.hud-btn--leave'); const r = b.getBoundingClientRect(); return { text: b.innerText.replace(/\s+/g, ' '), w: r.width, h: r.height, vis: b.getClientRects().length > 0 }; });
      check(lb.vis && lb.h >= 44 && /leave seat/i.test(lb.text), `LEAVE SEAT button on the helm HUD: "${lb.text}" ${lb.w.toFixed(0)}x${lb.h.toFixed(0)} px`);
      await shot('01-helm');

      // cockpit view and back
      check(await tap(page, f, BTN, /camera view/), 'tapped VIEW');
      await sleep(400); await settle(f);
      c = await crew(f);
      check(c.cam === 'interior', `cockpit view: camera mode ${c.cam}`);
      const st = await f.evaluate(() => { const x = window.__tidelock.scene.stats(); return { dc: x.drawCalls, tri: x.triangles, interior: x.interior }; });
      check(!!st.interior && st.interior.drawCalls > 0, `interior built: ${st.interior ? `${st.interior.drawCalls} draw calls, ${st.interior.triangles} triangles` : 'none'}; whole frame in cockpit view ${st.dc} draw calls, ${st.tri} triangles`);
      await shot('02-cockpit-view');
      check(await tap(page, f, BTN, /camera view/), 'tapped VIEW again');
      await sleep(400); await settle(f);
      check((await crew(f)).cam === 'chase', 'back to the chase view');

      // leave the seat
      check(await tap(page, f, BTN, /leave seat/), 'tapped LEAVE SEAT');
      await sleep(500); await settle(f); await pump(f, 20);
      c = await crew(f);
      check(c.mode === 'onFoot' && c.room === 'cockpit' && c.cam === 'interior', `on foot in the ${c.room} (mode=${c.mode}, posture=${c.posture}, boots ${c.boots ? 'on' : 'off'}, gripped=${c.gripped}, camera=${c.cam})`);
      check(c.posture === 'walking' && c.gripped, 'boots grip the deck after unstrapping');
      let ov = await overlaps(f);
      check(ov.length === 0, `on-foot controls do not overlap (portrait)${ov.length ? ': ' + ov.join('; ') : ''}`);
      await shot('03-left-seat');

      const h = await hands(page, { x: 105, y: 560 }, { x: 295, y: 420 });
      // walk aft through the companionway into the lounge
      let d = await h.walkTo(0, -12.2);
      d = await h.walkTo(0, -11.0);
      d = await h.walkTo(0, -9.6);
      c = await crew(f);
      check(c.room === 'lounge' && d < 0.2, `walked with the stick through the companionway: now in the ${c.room} at (${c.x.toFixed(2)}, ${c.z.toFixed(2)})`);

      // look by dragging: right = look right (yaw falls), up = look up
      const a = c;
      await h.drag(60, 0);
      let b = await crew(f);
      await h.drag(0, -50);
      const b2 = await crew(f);
      check(wrap(b.yaw - a.yaw) < -0.2 && b2.pitch - b.pitch > 0.15, `drag looks around: 60 px right -> yaw ${wrap(b.yaw - a.yaw).toFixed(2)} rad, 50 px up -> pitch +${(b2.pitch - b.pitch).toFixed(2)} rad`);
      const wl = await h.walkAndLook();
      check(wl.moved > 0.2 && Math.abs(wl.turned) > 0.1, `two fingers at once: walked ${wl.moved.toFixed(2)} m while turning ${wl.turned.toFixed(2)} rad`);

      // the light switch on the lounge's forward wall, beside the companionway door
      d = await h.walkTo(-1.1, -9.8, 0.1);
      check(await h.lookTo(0, -0.08), 'turned to face the light switch');
      c = await crew(f);
      const actText = () => f.evaluate(() => { const e = document.querySelector('.foot-act'); return e && !e.hidden ? e.innerText.replace(/\s+/g, ' ').trim() : ''; });
      let label = await actText();
      check(c.prompt === 'lights' && /lights off/i.test(label), `action button names what it will do: "${label}" (prompt ${c.prompt}, ${d.toFixed(2)} m from the spot)`);
      const wick = await f.evaluate(() => {
        const g = window.__tidelock.session, k = g.craft().find((x) => x.isPlayer), b = g.bodies().find((x) => x.id === g.flight().primaryId), q = k.q;
        const d = [b.r.x - k.r.x, b.r.y - k.r.y, b.r.z - k.r.z], m = Math.hypot(d[0], d[1], d[2]);
        // rotate by the inverse of q: ship-local direction to the primary
        const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w, x = d[0] / m, y = d[1] / m, z = d[2] / m;
        const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
        return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx].map((n) => n.toFixed(2)).join(', ');
      });
      console.log(`     (the primary is toward ship-local [${wick}]; +x is the lounge window's side)`);
      await shot('04-lounge');
      check(await tap(page, f, BTN, /lights off/), 'tapped the light switch');
      await sleep(300); await settle(f);
      c = await crew(f);
      const fl = await f.evaluate(() => window.__tidelock.frame.cabinLights);
      check(c.lights === false && fl === false, `cabin lights off (session ${c.lights}, frame ${fl})`);
      await sleep(2600); // let the toast go
      await shot('05-lights-off');
      label = await actText();
      check(/lights on/i.test(label) && (await tap(page, f, BTN, /lights on/)), `tapped "${label}"`);
      await sleep(300);
      check((await crew(f)).lights === true, 'cabin lights on again');

      // boots off: floating; push off; boots on
      await h.lookTo(Math.PI, 0.1);
      await h.walkTo(0, -8.6);
      check(await tap(page, f, BTN, /magnetic boots/), 'tapped BOOTS (off)');
      await settle(f); await pump(f, 6);
      c = await crew(f);
      check(!c.boots && c.posture === 'floating' && !c.gripped, `boots off: posture ${c.posture}`);
      check(await tap(page, f, BTN, /push off/), 'tapped PUSH OFF');
      await settle(f); await pump(f, 3);
      const p0 = await crew(f);
      await pump(f, 24);
      c = await crew(f);
      check(c.posture === 'floating' && p0.speed > 0.8 && c.z - p0.z > 0.4, `pushed off and drifting aft: ${p0.speed.toFixed(2)} m/s, ${(c.z - p0.z).toFixed(2)} m in 0.8 s, feet ${(c.y + 1.0).toFixed(2)} m off the deck`);
      await shot('06-floating');
      check(await tap(page, f, BTN, /magnetic boots/), 'tapped BOOTS (on)');
      let grip = false;
      for (let i = 0; i < 40 && !grip; i++) { await pump(f, 6); c = await crew(f); grip = c.gripped && c.posture === 'walking'; }
      check(grip && c.boots, `boots on: gripping the deck again in the ${c.room} at (${c.x.toFixed(2)}, ${c.z.toFixed(2)}), posture ${c.posture}`);

      // down the corridor to the port cabin, lie on the bed, sleep an hour
      if (c.room === 'lounge') { await h.walkTo(0, -5.4); }
      await h.walkTo(0, -3.0);
      await h.walkTo(0, -1.6);
      c = await crew(f);
      check(c.room === 'corridor', `in the ${c.room}`);
      await h.walkTo(-1.65, -1.6);
      d = await h.walkTo(-1.7, -3.4, 0.08);
      await h.lookTo(Math.PI / 2, -0.3); // to port, toward the bed
      c = await crew(f);
      label = await actText();
      check(c.room === 'cabin-port' && c.prompt === 'bunk' && /lie down/i.test(label), `in the ${c.room} (${d.toFixed(2)} m off the spot); action button: "${label}"`);
      check(await tap(page, f, BTN, /lie down/), 'tapped Lie down');
      await settle(f); await pump(f, 4); await settle(f);
      c = await crew(f);
      label = await actText();
      check(c.posture === 'lying' && /sleep/i.test(label), `lying in the bunk; action button: "${label}"`);
      await shot('07-bunk');
      const t0 = c.time;
      check(await tap(page, f, BTN, /^sleep$/), 'tapped Sleep');
      let slept = 0, wasAsleep = false;
      for (let i = 0; i < 400 && slept < 3600; i++) { await sleep(250); c = await crew(f); wasAsleep = wasAsleep || c.asleep; slept = c.time - t0; }
      const sl = await f.evaluate(() => { const e = document.querySelector('.foot-sleep'); return e && !e.hidden ? e.innerText.replace(/\s+/g, ' ') : ''; });
      check(wasAsleep && slept >= 3600, `asleep: ${slept.toFixed(0)} s of sim time passed (overlay "${sl}")`);
      await page.touchscreen.tap(120, 430);
      await sleep(400);
      c = await crew(f);
      const w = (await snap(f)).warp;
      check(!c.asleep && w < 1.5, `a touch wakes the pilot: asleep=${c.asleep}, time back to x${w.toFixed(2)}, still ${c.posture}`);
      check(await tap(page, f, BTN, /stand up/), 'tapped STAND UP');
      grip = false;
      for (let i = 0; i < 20 && !grip; i++) { await pump(f, 6); c = await crew(f); grip = c.gripped; }
      check(grip && c.posture === 'walking' && c.room === 'cabin-port', `standing beside the bed, boots gripping (${c.posture}, ${c.room})`);

      // back to the helm: corridor, lounge, companionway, cockpit
      await h.walkTo(-1.65, -1.6);
      await h.walkTo(0, -1.6);
      await h.walkTo(0, -5.4);
      await h.walkTo(0, -9.0);
      await h.walkTo(0, -11.0);
      await h.walkTo(0, -12.2);
      d = await h.walkTo(-0.55, -12.6, 0.1);
      await h.lookTo(0, 0);
      c = await crew(f);
      label = await actText();
      check(c.room === 'cockpit' && c.prompt === 'helm' && /take the helm/i.test(label), `back in the ${c.room} behind the pilot seat; action button: "${label}"`);
      check(await tap(page, f, BTN, /take the helm/), 'tapped Take the helm');
      await sleep(500); await settle(f);
      c = await crew(f);
      s = await snap(f);
      check(c.mode === 'helm' && s.hud && c.posture === 'seated', `strapped in: mode ${c.mode}, flight HUD back (camera ${c.cam})`);

      // point prograde first (the start attitude faces the station), then burn: the orbit changes, the body is
      // pressed aft, the seat is locked
      check(await tap(page, f, BTN, /sas mode/), 'opened the hold drawer');
      await sleep(250);
      check(await tap(page, f, 'button.hud-sas-cell', /^prograde$/), 'picked Prograde');
      const hp = await f.evaluate(() => {
        const g = window.__tidelock.session;
        const err = () => {
          const k = g.craft().find((x) => x.isPlayer), b = g.bodies().find((x) => x.id === g.flight().primaryId), q = k.q;
          const n = [-2 * (q.x * q.z + q.w * q.y), -2 * (q.y * q.z - q.w * q.x), -(1 - 2 * (q.x * q.x + q.y * q.y))], v = [k.v.x - b.v.x, k.v.y - b.v.y, k.v.z - b.v.z];
          return Math.acos(Math.max(-1, Math.min(1, (n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / Math.hypot(v[0], v[1], v[2]))));
        };
        let t = 0;
        for (; t < 120 && !(err() < 0.01 && g.player().spin < 0.005); t += 1 / 30) g.step(1 / 30);
        return { hold: g.player().hold, e: err(), t };
      });
      check(hp.hold === 'prograde' && hp.e < 0.02, `nose on prograde after ${hp.t.toFixed(0)} s (${(hp.e * 180 / Math.PI).toFixed(1)}° off)`);
      const box = await f.evaluate(() => { const r = document.querySelector('.hud-thr-track').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 }; });
      await page.touchscreen.tap(box.x, box.y);
      await sleep(300);
      const o0 = await snap(f);
      check(o0.throttle > 0.9, `throttle up by touch: ${(o0.throttle * 100).toFixed(0)}%`);
      await pump(f, 300);
      await settle(f);
      s = await snap(f);
      c = await crew(f);
      check(s.situation === 'orbit' && s.apo - o0.apo > 50e3 && s.dv < o0.dv, `10 s of prograde thrust changes the orbit: apoapsis ${(o0.apo / 1000).toFixed(1)} -> ${(s.apo / 1000).toFixed(1)} km, periapsis ${(o0.peri / 1000).toFixed(1)} -> ${(s.peri / 1000).toFixed(1)} km (${s.situation})`);
      check(s.throttle > 0.9 && c.felt.z > 5, `under thrust the strapped-in pilot feels ${(Math.hypot(c.felt.x, c.felt.y, c.felt.z) / 9.80665).toFixed(2)} g toward the stern (felt z = ${c.felt.z.toFixed(1)} m/s²)`);
      const tapped = await tap(page, f, BTN, /leave seat/);
      await sleep(300);
      check(tapped && (await crew(f)).mode === 'helm' && (await snap(f)).throttle > 0.9, 'LEAVE SEAT refuses while the drive is on');
      check(await tap(page, f, BTN, /camera view/), 'cockpit view under thrust');
      await sleep(2800);
      await shot('08-burn-cockpit');
      await tap(page, f, BTN, /camera view/);
      check(await tap(page, f, BTN, /^cut$/), 'tapped CUT');
      await sleep(200);
      s = await snap(f);
      check(s.throttle === 0 && !s.errPanel, 'throttle cut, no error panel');
    } catch (err) {
      fail.push(String((err && err.stack) || err));
      try { await page.screenshot({ path: path.join(shots, 'live-fail.png') }); } catch { /* ignore */ }
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors (portrait)');
    await browser.close();
  }

  // ------------------------------------------------------------------ landscape
  {
    const { browser, page, errors } = await launch('iphone15l', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    const shot = async (name) => { await settle(f); await sleep(350); await settle(f); await page.screenshot({ path: path.join(shots, `live-${name}.png`) }); };
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
      check(await tap(page, f, BTN, /^\s*enter/), '[landscape] tapped Enter');
      await sleep(1500);
      let ov = await overlaps(f);
      check(ov.length === 0, `[landscape] helm controls do not overlap${ov.length ? ': ' + ov.join('; ') : ''}`);
      await shot('09-l-helm');
      check(await tap(page, f, BTN, /leave seat/), '[landscape] tapped LEAVE SEAT');
      await sleep(500); await settle(f); await pump(f, 20);
      const h = await hands(page, { x: 150, y: 230 }, { x: 500, y: 150 });
      await h.walkTo(0, -12.2);
      await h.walkTo(0, -11.0);
      await h.walkTo(0, -9.6);
      await h.lookTo(-Math.PI / 2 + 0.25, -0.12); // toward the sofa and the big starboard window
      const c = await crew(f);
      ov = await overlaps(f);
      check(c.room === 'lounge' && c.cam === 'interior' && ov.length === 0, `[landscape] walked into the ${c.room}; controls do not overlap${ov.length ? ': ' + ov.join('; ') : ''}`);
      await shot('10-l-lounge');
    } catch (err) {
      fail.push(`[landscape] ${String((err && err.stack) || err)}`);
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors (landscape)');
    await browser.close();
  }

  await close();
  if (fail.length) { console.error(`INTERIOR CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('INTERIOR CHECK PASSED');
}

if (require.main === module) run();
