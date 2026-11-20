#!/usr/bin/env node
// End-to-end check of living aboard the 32 m Wren, in iPhone 15 emulation (software GL, low quality), driven by
// real touches (CDP touch events -> the page's pointer handlers -> rays into the 3D interior):
// title (the exterior orbit) -> tap -> standing in the cockpit, nothing on screen but the walk stick -> walk aft
// with the left thumb through the companionway into the lounge (room culling: the rooms behind the bulkheads are
// not drawn) -> look at the LIGHTS switch beside the door and flip it off and on -> down the corridor spine into
// the cargo bay and on into engineering -> back forward to the sofa's aft end, tap the sofa: seated at the table.
// One landscape pass: title -> tap -> walk into the lounge. The flight controls and the bunk are in e2e/cockpit.cjs.
//   node e2e/interior.cjs [--no-build]      screenshots: shots/live-*.png (4)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { settle, sleep, pump } = require('./artifact.cjs');
const { fingers, pickMap, painted, st } = require('./cockpit.cjs');

/** Rooms drawn this frame by the interior's portal culling, and the room the camera is in. */
const rooms = (f) => f.evaluate(() => {
  const l = window.__tidelock.scene.stats().lighting;
  return l ? { n: l.rooms, of: l.roomsTotal, room: l.room } : null;
});
/** Centre of the walk stick's ring (CSS px). */
const stickAt = (f) => f.evaluate(() => {
  const e = document.querySelector('.walk-stick');
  const r = e ? e.getBoundingClientRect() : null;
  return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 100, y: 640 };
});

async function run() {
  if (!process.argv.includes('--no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { baseUrl, close } = await serveDist();
  const url = `${baseUrl}/index.html?q=low&fresh=1`;

  /** Title -> tap -> standing in the cockpit, eyes open. */
  async function begin(page, f, h, tag) {
    await page.goto(url);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
    let s = await st(f);
    check(s.screen === 'title' && s.cam === 'orbit', `${tag}title: the exterior orbit round the Wren (camera ${s.cam})`);
    const vw = page.viewportSize();
    await h.tapAt(vw.width / 2, vw.height * 0.45);
    await sleep(1200);
    await settle(f);
    await f.waitForFunction(() => [...document.body.children].every((e) => e.tagName === 'CANVAS' || parseFloat(getComputedStyle(e).opacity) < 0.02 || getComputedStyle(e).backgroundColor !== 'rgb(0, 0, 0)'), null, { timeout: 30000 }).catch(() => undefined);
    s = await st(f);
    check(s.screen === 'flight' && s.mode === 'onFoot' && s.room === 'cockpit' && s.cam === 'interior', `${tag}tap: standing in the cockpit (mode=${s.mode}, room=${s.room}, camera=${s.cam})`);
    const ui = await painted(f);
    check(ui.every((e) => /walk-stick/.test(e)), `${tag}nothing over the view but the walk stick: [${ui.join(', ')}]`);
    return stickAt(f);
  }

  // ------------------------------------------------------------------ portrait
  {
    const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    const shot = async (name) => { await settle(f); await sleep(300); await settle(f); await page.screenshot({ path: path.join(shots, `live-${name}.png`), timeout: 180000 }).catch((e) => console.log(`   (screenshot ${name} skipped: ${e.message.split('\n')[0]})`)); };
    try {
      const h = await fingers(page);
      const stick = await begin(page, f, h, '');
      // ---- aft through the companionway into the lounge
      await h.lookTo(Math.PI, 0);
      await h.walkTo(stick, -0.3, -12.3);
      await h.walkTo(stick, 0, -11.0);
      const d1 = await h.walkTo(stick, -0.2, -9.6);
      let s = await st(f);
      check(d1 < 0.25 && s.room === 'lounge', `walked aft with the left thumb into the lounge (${s.room}, ${d1.toFixed(2)} m off)`);
      await h.lookTo(Math.PI, -0.1);
      await settle(f);
      let r = await rooms(f);
      check(!!r && r.room === 'lounge' && r.n < r.of, `room culling from the lounge looking aft: ${r ? `${r.n}/${r.of} rooms drawn` : 'no lighting stats'}`);
      await shot('1-lounge');
      // ---- the LIGHTS switch on the lounge's forward bulkhead (within arm's reach of it)
      // (step up to it: 0.7 m from the bulkhead, so the eye is inside the 0.95 m reach whatever the walk's 0.14 m slop)
      const dl = await h.walkTo(stick, -0.95, -9.7);
      s = await st(f);
      console.log(`     at the LIGHTS switch: ${s.x.toFixed(2)}, ${s.z.toFixed(2)} (${dl.toFixed(2)} m off)`);
      await h.aimAt({ x: -1.1, y: 0.2, z: -10.4 });
      await settle(f);
      let map = await pickMap(f);
      check(!!map.lights, `the LIGHTS switch is under a finger (${map.lights ? `${map.lights.w}x${map.lights.h} px` : 'not found'})`);
      if (map.lights) {
        await h.tapAt(map.lights.x, map.lights.y);
        await pump(f, 5);
        s = await st(f);
        check(s.lights === false, `tapped LIGHTS: cabin lights ${s.lights ? 'on' : 'off'}`);
        await sleep(600);
        await shot('2-lights-off');
        await h.tapAt(map.lights.x, map.lights.y);
        await pump(f, 5);
        s = await st(f);
        check(s.lights === true, `tapped LIGHTS again: cabin lights ${s.lights ? 'on' : 'off'}`);
      }
      // ---- down the corridor spine, through the cargo bay into engineering
      await h.lookTo(Math.PI, 0);
      await h.walkTo(stick, 0, -7.6);
      await h.walkTo(stick, 0, -5.2);
      await h.walkTo(stick, 0, -3.0);
      s = await st(f);
      check(s.room === 'corridor', `in the corridor (${s.room})`);
      await h.walkTo(stick, 0, 1.6);
      const d2 = await h.walkTo(stick, 0, 4.4);
      s = await st(f);
      check(d2 < 0.25 && s.room === 'cargo', `through the cargo-bay door (${s.room}, ${d2.toFixed(2)} m off)`);
      await shot('3-cargo');
      await h.walkTo(stick, 0, 9.2);
      const d3 = await h.walkTo(stick, 0, 10.9);
      s = await st(f);
      check(d3 < 0.25 && s.room === 'engineering', `into engineering (${s.room}, ${d3.toFixed(2)} m off)`);
      await h.lookTo(0, 0);
      await settle(f);
      r = await rooms(f);
      check(!!r && r.room === 'engineering' && r.n >= 2, `looking forward from engineering: ${r ? `${r.n}/${r.of} rooms drawn` : 'no lighting stats'}`);
      // ---- forward again to the sofa's aft end; sit
      await h.walkTo(stick, 0, 9.2);
      await h.walkTo(stick, 0, 3.6);
      await h.walkTo(stick, 0, -3.0);
      await h.walkTo(stick, 0, -4.95);
      const d4 = await h.walkTo(stick, 2.1, -4.95);
      s = await st(f);
      check(d4 < 0.3 && s.room === 'lounge', `at the sofa's aft end (${s.room}, ${d4.toFixed(2)} m off)`);
      await h.aimAt({ x: 2.4, y: -0.6, z: -6.6 });
      await settle(f);
      map = await pickMap(f);
      check(!!map['table-seat'], `the sofa is under a finger (${map['table-seat'] ? `${map['table-seat'].w}x${map['table-seat'].h} px` : 'not found'})`);
      if (map['table-seat']) await h.tapAt(map['table-seat'].x, map['table-seat'].y);
      await pump(f, 30);
      await settle(f);
      s = await st(f);
      check(s.posture === 'seated', `tapped the sofa: ${s.posture} at the table`);
      await shot('4-sofa');
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
  {
    const { browser, page, errors } = await launch('iphone15l', { deviceScaleFactor: 2 });
    const f = page.mainFrame();
    try {
      const h = await fingers(page);
      h.setLook({ x: 640, y: 90 });
      const stick = await begin(page, f, h, '[landscape] ');
      await h.lookTo(Math.PI, 0);
      await h.walkTo(stick, -0.3, -12.3);
      await h.walkTo(stick, 0, -11.0);
      const d = await h.walkTo(stick, -0.2, -9.6);
      const s = await st(f);
      check(d < 0.25 && s.room === 'lounge' && !s.err, `[landscape] walked into the lounge (${s.room}, ${d.toFixed(2)} m off)`);
    } catch (err) {
      fail.push(String((err && err.stack) || err));
      console.log(String((err && err.stack) || err));
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors (landscape)');
    await browser.close();
  }

  await close();
  if (fail.length) { console.error(`INTERIOR CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('INTERIOR CHECK PASSED');
}

run().catch((e) => { console.error(e); process.exit(1); });
