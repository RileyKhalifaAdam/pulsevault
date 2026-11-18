#!/usr/bin/env node
// End-to-end smoke test of the first playable loop on an emulated iPhone 15 (software GL, 'low' quality):
//   build -> title -> New flight -> station -> Launch -> flight HUD, sim advancing.  Screenshots: shots/e2e-*.png
//   node e2e/smoke.cjs [--no-build] [--landscape]
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, waitReady, ROOT } = require('../tools/pw.cjs');

const args = process.argv.slice(2);
const shots = path.join(ROOT, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!args.includes('--no-build')) execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  fs.mkdirSync(shots, { recursive: true });
  const { baseUrl, close } = await serveDist();
  const device = args.includes('--landscape') ? 'iphone15l' : 'iphone15';
  const tag = device === 'iphone15l' ? 'l-' : '';
  const { browser, page, errors } = await launch(device, { deviceScaleFactor: 1 });
  const fail = [];
  const check = (ok, what) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) fail.push(what);
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `e2e-${tag}${name}.png`) });
  const state = () => page.evaluate(() => {
    const t = window.__tidelock;
    const fi = t.game.flightInfo();
    return { screen: t.screen, docked: t.game.shipPose().docked, alt: fi.altitude, time: t.game.time(), target: (t.game.targetInfo() || {}).name || null, hud: !!document.querySelector('.hud') && getComputedStyle(document.querySelector('.hud')).display !== 'none', altText: (document.querySelector('.hud-read b') || {}).textContent || '' };
  });
  /** Tap the first visible button whose text matches; false when there is none. */
  const tapText = async (re) => {
    const box = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && rx.test(b.textContent || '')) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, re.source);
    if (!box) return false;
    await page.touchscreen.tap(box.x, box.y);
    return true;
  };
  try {
    await page.goto(`${baseUrl}/index.html?q=low&fresh=1`);
    await waitReady(page, 120000);
    check((await state()).screen === 'title', 'title screen is up');
    await shot('1-title');

    check(await tapText(/new (flight|game|career)/), 'tapped New flight');
    await sleep(900);
    let s = await state();
    check(s.screen === 'station' && s.docked, `station screen, docked (screen=${s.screen})`);
    await shot('2-station');

    if (!(await tapText(/^\s*(launch|undock)/))) {
      console.log('note: no Launch button found by text; calling game.undock()');
      await page.evaluate(() => window.__tidelock.game.undock());
    }
    await sleep(1500);
    s = await state();
    check(s.screen === 'flight' && !s.docked, `flight screen after launch (screen=${s.screen})`);
    check(s.hud && s.altText.length > 0, `HUD visible, altitude reads "${s.altText}"`);
    await shot('3-flight');
    await sleep(4000);
    const s2 = await state();
    check(s2.time > s.time + 1, `sim time advances (${(s2.time - s.time).toFixed(1)} s)`);
    check(s2.alt !== s.alt && Number.isFinite(s2.alt), `altitude changes (${s.alt.toFixed(2)} -> ${s2.alt.toFixed(2)} m)`);
    check(!!s2.target, `a destination is targeted (${s2.target})`);
    await shot('4-flight-later');
    // hand the trip to the flight computer
    let went = false;
    for (let i = 0; i < 30 && !went; i++) {
      went = await tapText(/^go to /);
      if (!went) await sleep(500);
    }
    await sleep(2500);
    const ap = await page.evaluate(() => { const a = window.__tidelock.game.autopilot(); return { engaged: a.engaged, status: a.status, failed: a.failed }; });
    check(went && ap.engaged, `"Go to" engages the flight computer (${ap.status || ap.failed})`);
    await shot('5-autopilot');
    const diag = await page.evaluate(() => window.__tidelock.game.diagnostics());
    check(diag.faults === 0, `no sim faults (${diag.faults} ${diag.lastFault})`);
    check(!(await page.$('#tl-error')), 'no error panel');
  } catch (err) {
    fail.push(String(err && err.stack || err));
    try { await shot('failure'); } catch {}
  }
  const pageErrors = errors.filter((e) => e.startsWith('pageerror'));
  for (const e of errors) console.log(e);
  check(pageErrors.length === 0, 'no page errors');
  await browser.close();
  await close();
  if (fail.length) {
    console.error(`SMOKE FAILED:\n - ${fail.join('\n - ')}`);
    process.exit(1);
  }
  console.log('SMOKE PASSED');
})();
