#!/usr/bin/env node
// End-to-end check of the loose objects aboard the Wren (src/world/props.ts, render/space/props.ts), in iPhone 15
// emulation (software GL, low quality), driven by real touches (CDP touch events -> the page's pointer handlers ->
// a ray from the eye into the cabin -> the hand, a spring on the object):
// title -> tap -> standing in the cockpit -> walk aft into the lounge with the left thumb -> to the end of the low
// table -> look down at the loose mug on it -> a finger on the mug takes hold -> carry it (the finger slides, the
// mug follows the hand) -> flick and let go: it flies off at the hand's speed (the pilot takes the reaction) ->
// it strikes the cabin and stays inside it, and the drawn instance follows the simulated pose.
//   node e2e/props.cjs [--no-build]      screenshots: shots/props-*.png (3)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { settle, sleep, pump } = require('./artifact.cjs');
const { fingers, st } = require('./cockpit.cjs');

const MUG = 'mug-table-2';
const mug = (f) => f.evaluate((id) => {
  const g = window.__tidelock.session, p = g.props().find((v) => v.id === id);
  const b = g.loose ? g.loose.bodies.find((x) => x.id === id) : null;
  const c = g.crew();
  return p ? { x: p.pos.x, y: p.pos.y, z: p.pos.z, room: p.room, grabbed: p.grabbed, asleep: p.asleep, stowed: p.stowed,
    v: b ? { x: b.v.x, y: b.v.y, z: b.v.z } : null, crewV: { x: c.vel.x, y: c.vel.y, z: c.vel.z } } : null;
}, MUG);
/** The drawn props: instances per mesh and whether one sits at the mug's simulated pose. */
const drawn = (f) => f.evaluate((id) => {
  const t = window.__tidelock, g = t.session, p = g.props().find((v) => v.id === id);
  let group = null;
  t.scene.insideScene.traverse((o) => { if (o.name === 'props') group = o; });
  if (!group || !p) return { found: !!group, n: 0, near: Infinity };
  let n = 0, near = Infinity;
  const m = new group.matrix.constructor();
  for (const mesh of group.children) {
    n += mesh.count;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const e = m.elements;
      near = Math.min(near, Math.hypot(e[12] - p.pos.x, e[13] - p.pos.y, e[14] - p.pos.z));
    }
  }
  return { found: true, n, near, visible: group.visible };
}, MUG);
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
  const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
  const f = page.mainFrame();
  const shot = async (name) => { await settle(f); await sleep(300); await settle(f); await page.screenshot({ path: path.join(shots, `props-${name}.png`), timeout: 180000 }).catch((e) => console.log(`   (screenshot ${name} skipped: ${e.message.split('\n')[0]})`)); };
  try {
    await page.goto(`${baseUrl}/index.html?q=low&fresh=1`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 });
    const programs = () => f.evaluate(() => window.__tidelock.pipeline.renderer.info.programs.length);
    const prog0 = await programs();
    const h = await fingers(page);
    const vw = page.viewportSize();
    await h.tapAt(vw.width / 2, vw.height * 0.45);
    await sleep(1200);
    await settle(f);
    await f.waitForFunction(() => [...document.body.children].every((e) => e.tagName === 'CANVAS' || parseFloat(getComputedStyle(e).opacity) < 0.02 || getComputedStyle(e).backgroundColor !== 'rgb(0, 0, 0)'), null, { timeout: 30000 }).catch(() => undefined);
    let s = await st(f);
    check(s.screen === 'flight' && s.mode === 'onFoot' && s.room === 'cockpit', `tap: standing in the cockpit (mode=${s.mode}, room=${s.room})`);
    const stick = await stickAt(f);
    // ---- aft into the lounge, to the forward end of the low table
    await h.lookTo(Math.PI, 0);
    await h.walkTo(stick, -0.3, -12.3);
    await h.walkTo(stick, 0, -11.0);
    await h.walkTo(stick, 0.1, -9.4);
    const d1 = await h.walkTo(stick, 0.22, -7.2, 0.12);
    s = await st(f);
    check(s.room === 'lounge' && d1 < 0.2, `walked to the lounge table (${s.room}, at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}; ${d1.toFixed(2)} m off)`);
    let m0 = await mug(f);
    check(!!m0 && m0.room === 'lounge' && !m0.grabbed, `the loose mug is on the table (${m0 ? `${m0.x.toFixed(2)}, ${m0.y.toFixed(2)}, ${m0.z.toFixed(2)}` : 'missing'})`);
    let dr = await drawn(f);
    check(dr.found && dr.n >= 20 && dr.near < 0.005, `the loose objects are drawn in the cabin: ${dr.n} instances in view, one at the mug (${dr.near.toFixed(4)} m)`);
    // ---- look down at it; a finger on it takes hold
    await h.aimAt(m0);
    await settle(f);
    await shot('1-table');
    const cx = vw.width / 2, cy = vw.height / 2;
    await h.down(3, cx, cy);
    await pump(f, 2);
    await settle(f);
    let m1 = await mug(f);
    check(!!m1 && m1.grabbed, `a finger on the mug takes hold of it (${m1 && m1.grabbed ? 'held' : 'not held'})`);
    // ---- carry: the finger slides up and to the right, the hand follows the touch ray
    for (let i = 0; i < 6; i++) { await h.move(3, cx + 10 * (i + 1), cy - 14 * (i + 1)); await pump(f, 3); }
    await settle(f);
    const m2 = await mug(f);
    const carried = m2 ? Math.hypot(m2.x - m0.x, m2.y - m0.y, m2.z - m0.z) : 0;
    check(!!m2 && m2.grabbed && carried > 0.1 && m2.y > m0.y + 0.05, `carried: the mug follows the hand ${carried.toFixed(2)} m, off the table (y ${m0.y.toFixed(2)} -> ${m2 ? m2.y.toFixed(2) : '?'})`);
    await shot('2-carry');
    // ---- throw: a quick flick up and let go
    // (the finger keeps moving as it lifts: the last move and the lift go out together, so no idle frame of the
    // software renderer comes between them — on the phone the finger moves every frame until it leaves the glass)
    // (the app's own frames are held meanwhile — a software-rendered frame takes far longer than the clamped
    // 0.1 s it simulates, so idle frames between two CDP touches would read as the hand stopping; the test steps
    // the session itself, one frame per finger sample, as the phone's 60 Hz touch events do)
    const crew0 = (await mug(f)).crewV;
    await f.evaluate(() => { window.__tidelock.hooks.holdSim = true; });
    for (let i = 0; i < 5; i++) { await h.move(3, cx + 60 + 12 * (i + 1), cy - 84 - 30 * (i + 1)); await pump(f, 1); }
    await Promise.all([h.move(3, cx + 60 + 12 * 6, cy - 84 - 30 * 6), h.up(3)]);
    await pump(f, 1);
    await f.evaluate(() => { window.__tidelock.hooks.holdSim = false; });
    const m3 = await mug(f);
    const speed = m3 && m3.v ? Math.hypot(m3.v.x, m3.v.y, m3.v.z) : 0;
    const crewDv = Math.hypot(m3.crewV.x - crew0.x, m3.crewV.y - crew0.y, m3.crewV.z - crew0.z);
    check(!!m3 && !m3.grabbed && speed > 0.3, `let go with a flick: the mug flies off at ${speed.toFixed(2)} m/s`);
    check(crewDv > 0 && crewDv < speed * 0.05, `the pilot takes the reaction (${(crewDv * 1000).toFixed(1)} mm/s, 0.4 kg against 80 kg)`);
    // ---- it flies, strikes the cabin, stays inside
    const L = { x0: -3.2, x1: 3.2, y0: -1.0, y1: 1.4, z0: -10.55, z1: -4.45 };
    let hit = false, inside = true, far = 0, minSpeed = speed;
    let prev = m3.v;
    for (let k = 0; k < 40; k++) {
      await pump(f, 3);
      const m = await mug(f);
      if (!m) break;
      far = Math.max(far, Math.hypot(m.x - m3.x, m.y - m3.y, m.z - m3.z));
      if (m.x < L.x0 || m.x > L.x1 || m.y < L.y0 || m.y > L.y1 || m.z < L.z0 - 6 || m.z > L.z1 + 2) inside = false;
      const sp = Math.hypot(m.v.x, m.v.y, m.v.z);
      const cos = (m.v.x * prev.x + m.v.y * prev.y + m.v.z * prev.z) / Math.max(1e-9, sp * Math.hypot(prev.x, prev.y, prev.z));
      if (cos < 0.7 || sp < 0.7 * minSpeed) hit = true;
      minSpeed = Math.min(minSpeed, sp);
      prev = m.v;
      if (hit && k > 6) break;
    }
    const m4 = await mug(f);
    check(far > 0.4, `it flies: ${far.toFixed(2)} m from where it left the hand`);
    check(hit && inside, `it strikes the cabin and stays inside (hit=${hit}, now ${m4.x.toFixed(2)}, ${m4.y.toFixed(2)}, ${m4.z.toFixed(2)} in ${m4.room || 'a doorway'}, ${Math.hypot(m4.v.x, m4.v.y, m4.v.z).toFixed(2)} m/s)`);
    // free fall: it drifts on between bounces; give it a minute and see where it comes to rest
    for (let k = 0; k < 20; k++) { await pump(f, 90); const m = await mug(f); if (m.asleep) break; }
    const m5 = await mug(f);
    const sp5 = Math.hypot(m5.v.x, m5.v.y, m5.v.z);
    check(sp5 < 0.3, `a minute later it has lost its throw to the cabin (${sp5.toFixed(3)} m/s, ${m5.asleep ? 'at rest' : 'drifting'}, at ${m5.x.toFixed(2)}, ${m5.y.toFixed(2)}, ${m5.z.toFixed(2)})`);
    await settle(f);
    dr = await drawn(f);
    check(dr.near < 0.005 || m5.room !== 'lounge', `the drawn mug follows the simulated one (${dr.near.toFixed(4)} m)`);
    await h.aimAt(m5);
    await shot('3-landed');
    s = await st(f);
    check(!s.err && !s.destroyed, 'no error panel, ship intact');
    const prog1 = await programs();
    check(prog1 <= prog0, `every shader program was compiled while loading (${prog0} before the tap, ${prog1} after the walk, the grab and the throw)`);
  } catch (err) {
    fail.push(String((err && err.stack) || err));
    console.log(String((err && err.stack) || err));
  }
  for (const e of errors) console.log(`   ${e}`);
  check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors');
  await browser.close();
  await close();
  if (fail.length) { console.error(`PROPS CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('PROPS CHECK PASSED');
}

run().catch((e) => { console.error(e); process.exit(1); });
