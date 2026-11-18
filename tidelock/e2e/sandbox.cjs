#!/usr/bin/env node
// End-to-end check of the physics sandbox client in iPhone 15 emulation (software GL, low quality):
// title -> Enter -> flight HUD -> the world moves -> throttle changes the orbit -> stick turns the ship -> RCS mode
// -> map shows the path, a burn can be planned and deleted -> perf overlay shows sane numbers. One landscape pass.
//   node e2e/sandbox.cjs [--no-build]      screenshots: shots/sandbox-*.png (at most 8)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { tap, pump, settle, snap, sleep, BTN } = require('./artifact.cjs');

async function run() {
  if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { baseUrl, close } = await serveDist();
  const url = `${baseUrl}/index.html?q=low&fresh=1`;

  // ------------------------------------------------------------------ portrait
  {
    const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
    const shot = (name) => page.screenshot({ path: path.join(shots, `sandbox-${name}.png`) });
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
      const f = page.mainFrame();
      let s = await snap(f);
      check(s.screen === 'title', 'title screen is up');
      await sleep(600);
      await shot('1-title');
      check(await tap(page, f, BTN, /^\s*enter/), 'tapped Enter');
      await sleep(1500);
      s = await snap(f);
      check(s.screen === 'flight' && s.hud, `flight HUD shows (${s.primary} · ${s.situation})`);
      check(!s.docked && s.situation === 'orbit', `flying free in orbit (docked=${s.docked}, situation=${s.situation})`);
      const d0 = await f.evaluate(() => { const t = window.__tidelock.session.target(); return t ? { name: t.name, distance: t.distance } : null; });
      check(d0 && d0.distance > 20 && d0.distance < 5000, `starts beside the station: ${d0 ? `${d0.name} at ${d0.distance.toFixed(0)} m` : 'no target'}`);
      await settle(f);
      await shot('2-flight');

      // the world moves
      const a = s;
      await pump(f, 900);
      s = await snap(f);
      check(s.time > a.time + 25 && s.alt !== a.alt, `sim time +${(s.time - a.time).toFixed(0)} s, altitude ${(a.alt / 1000).toFixed(3)} -> ${(s.alt / 1000).toFixed(3)} km`);

      // throttle up (touch the top of the track) changes the orbit
      const box = await f.evaluate(() => { const r = document.querySelector('.hud-thr-track').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 }; });
      await page.touchscreen.tap(box.x, box.y);
      await sleep(300);
      const b = await snap(f);
      check(b.throttle > 0.9, `throttle up by touch: ${(b.throttle * 100).toFixed(0)}%`);
      await pump(f, 450);
      await settle(f);
      await sleep(400);
      s = await snap(f);
      await shot('3-thrust');
      check(Math.abs(s.apo - b.apo) > 1000 && s.dv < b.dv, `15 s of thrust: apoapsis ${(b.apo / 1000).toFixed(1)} -> ${(s.apo / 1000).toFixed(1)} km, periapsis ${(b.peri / 1000).toFixed(1)} -> ${(s.peri / 1000).toFixed(1)} km, Δv ${b.dv.toFixed(0)} -> ${s.dv.toFixed(0)} m/s`);
      check(await tap(page, f, BTN, /^cut$/), 'tapped CUT');
      await sleep(200);
      check((await snap(f)).throttle === 0, 'throttle cut');

      // the stick turns the ship (synthetic pointer on the stick zone), hold off so nothing fights it
      const q0 = await f.evaluate(() => {
        const ses = window.__tidelock.session;
        ses.setHold('off');
        const el = document.querySelector('.hud-surface'), st = document.querySelector('.hud-stick').getBoundingClientRect();
        const x = st.left + st.width / 2, y = st.top + st.height / 2;
        const ev = (type, dx, dy) => el.dispatchEvent(new PointerEvent(type, { pointerId: 77, pointerType: 'touch', isPrimary: true, clientX: x + dx, clientY: y + dy, bubbles: true, cancelable: true }));
        window.__stick = ev;
        ev('pointerdown', 0, 0);
        ev('pointermove', 40, 30);
        return { ...ses.craft().find((c) => c.isPlayer).q };
      });
      await sleep(400);
      await pump(f, 90);
      const q1 = await f.evaluate(() => { const q = { ...window.__tidelock.session.craft().find((c) => c.isPlayer).q }; window.__stick('pointerup', 40, 30); return q; });
      const turn = 2 * Math.acos(Math.min(1, Math.abs(q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w)));
      check(turn > 0.02, `stick turns the ship: ${(turn * 180 / Math.PI).toFixed(1)}° in 3 s`);
      await f.evaluate(() => window.__tidelock.session.setHold('stability'));

      // RCS translate mode
      check(await tap(page, f, BTN, /^rcs$/), 'tapped RCS');
      await sleep(200);
      check(await f.evaluate(() => document.querySelector('.hud-btn--rcs').getAttribute('aria-pressed') === 'true'), 'RCS translate mode is on');
      check(await tap(page, f, BTN, /^rcs$/), 'tapped RCS again (off)');

      // time acceleration: asked vs achieved
      check(await tap(page, f, BTN, /faster time/), 'tapped faster time');
      check(await tap(page, f, BTN, /faster time/), 'tapped faster time again');
      await sleep(1200);
      s = await snap(f);
      check(s.warpReq > 1, `time acceleration asked ×${s.warpReq}, achieved ×${s.warp.toFixed(1)}${s.warpWhy ? ` (${s.warpWhy})` : ''}`);
      await f.evaluate(() => window.__tidelock.session.setWarp(1));

      // map: the path, plan a burn, edit it, delete it
      check(await tap(page, f, BTN, /^map$/), 'tapped Map');
      await sleep(1200);
      await settle(f);
      const m = await f.evaluate(() => {
        const t = window.__tidelock, p = t.session.prediction(), c = document.querySelector('.pm canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let bright = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
        // where a path point is on screen (same fit as the map: centred on the frame body)
        let ext = 0;
        for (let i = 0; i < p.count; i++) ext = Math.max(ext, Math.abs(p.points[4 * i]), Math.abs(p.points[4 * i + 2]));
        const w = c.clientWidth, h = c.clientHeight, mpp = (ext * 1.2) / Math.max(60, Math.min(w, h) / 2 - 56), k = Math.floor(p.count * 0.3);
        return { screen: t.screen, count: p.count, events: p.events.map((e) => e.kind).join(','), bright, x: w / 2 + p.points[4 * k] / mpp, y: h / 2 + p.points[4 * k + 2] / mpp };
      });
      check(m.screen === 'map' && m.count > 20 && m.bright > 200, `map shows the path: ${m.count} points, ${m.bright} bright pixels, events [${m.events}]`);
      await shot('4-map');
      await page.touchscreen.tap(m.x, m.y);
      await sleep(500);
      let burns = await f.evaluate(() => window.__tidelock.session.burns().map((b) => ({ ...b })));
      check(burns.length === 1 && await f.evaluate(() => !document.querySelector('[data-burn-editor]').hidden), `tapping the path plans a burn (${burns.length}) and opens the editor`);
      for (let i = 0; i < 5; i++) await tap(page, f, BTN, /prograde more/);
      await sleep(600);
      await settle(f);
      burns = await f.evaluate(() => window.__tidelock.session.burns().map((b) => ({ ...b })));
      check(burns.length === 1 && burns[0].prograde >= 5, `prograde stepper edits the burn: ${burns[0] ? burns[0].prograde : '-'} m/s`);
      await shot('5-burn');
      check(await tap(page, f, BTN, /^delete$/), 'tapped Delete');
      await sleep(300);
      check((await f.evaluate(() => window.__tidelock.session.burns().length)) === 0, 'burn deleted');
      check(await tap(page, f, BTN, /back to flight/), 'back to flight');
      await sleep(500);

      // pause menu and the perf overlay
      check(await tap(page, f, BTN, /^menu$/), 'opened the menu');
      await sleep(600);
      await shot('6-menu');
      check(await tap(page, f, BTN, /perf overlay/), 'toggled the performance overlay');
      await sleep(300);
      check(await tap(page, f, BTN, /^\s*resume/), 'resumed');
      await sleep(9000);
      const pf = await f.evaluate(() => {
        const t = window.__tidelock, el = document.querySelector('[data-perf]');
        return { visible: !!el && !el.hidden, text: el ? el.innerText : '', snap: { ...t.perf.snapshot() }, report: t.perf.report() };
      });
      console.log(pf.report.split('\n').map((l) => `   | ${l}`).join('\n'));
      const ps = pf.snap;
      check(pf.visible && /fps/.test(pf.text) && /Copy performance report/i.test(pf.text), 'perf overlay is visible with a copy button');
      check(ps.samples > 5 && ps.fps > 0.5 && ps.fps < 250 && ps.frameP50 > 3 && ps.frameP95 >= ps.frameP50 && ps.simP95 < 50 && ps.renderP95 > 0 && ps.renderP50 <= ps.frameP95 && ps.scale >= 0.6 && ps.scale <= 1 && ps.drawCalls > 0 && ps.drawCalls < 400,
        `perf numbers are sane: ${ps.fps.toFixed(1)} fps, frame ${ps.frameP50.toFixed(1)}/${ps.frameP95.toFixed(1)} ms, sim ${ps.simP50.toFixed(2)}/${ps.simP95.toFixed(2)} ms, render ${ps.renderP50.toFixed(1)}/${ps.renderP95.toFixed(1)} ms, steps ${ps.steps.toFixed(1)}, draws ${ps.drawCalls}, scale ${ps.scale}, tier ${ps.tier}`);
      check(/WebGL renderer: \S/.test(pf.report) && /user agent/.test(pf.report), 'report carries the device lines');
      await shot('7-perf');
      check(!(await snap(f)).errPanel, 'no error panel');
    } catch (err) {
      fail.push(String((err && err.stack) || err));
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.length === 0, 'portrait: no page errors');
    await browser.close();
  }

  // ------------------------------------------------------------------ landscape
  {
    const { browser, page, errors } = await launch('iphone15l', { deviceScaleFactor: 2 });
    try {
      await page.goto(`${url}&perf=1`);
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
      const f = page.mainFrame();
      check(await tap(page, f, BTN, /^\s*enter/), 'landscape: tapped Enter');
      await sleep(4000);
      const s = await snap(f);
      check(s.screen === 'flight' && s.hud, 'landscape: flight HUD shows');
      await page.screenshot({ path: path.join(shots, 'sandbox-8-landscape.png') });
    } catch (err) {
      fail.push(String((err && err.stack) || err));
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.length === 0, 'landscape: no page errors');
    await browser.close();
  }
  await close();
  if (fail.length) { console.error(`SANDBOX CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('SANDBOX CHECK PASSED');
}
run();
