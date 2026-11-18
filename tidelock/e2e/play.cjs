#!/usr/bin/env node
// Plays the first loop on an emulated iPhone 15 against the SHIPPED page (the artifact fragment in a host-like
// skeleton, low quality, software GL): New flight -> buy cargo -> set Gloaming Lock -> Launch -> "Go to" ->
// time warp -> docked at Gloaming Lock -> sell. Screenshots: shots/play-*.png.
// Software rendering runs far below real time, so between taps the test advances the simulation itself with
// window.__tidelock.game.step(1/30) — the same call the frame loop makes. Every player action is a real tap.
//   node e2e/play.cjs [--no-build]
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT } = require('../tools/pw.cjs');
const { writeHostPages, tap, pump, settle, snap, sleep, BTN } = require('./artifact.cjs');

const GLOAMING = 'tallow.st.gloaming-lock';
(async () => {
  if (!process.argv.includes('--no-build')) execSync('node build.mjs --artifact', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  for (const f of fs.readdirSync(shots)) if (/^play-.*\.png$/.test(f)) fs.unlinkSync(path.join(shots, f));
  writeHostPages();
  const { baseUrl, close } = await serveDist();
  const { browser, context, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const frame = page.mainFrame();
  const fail = [];
  const notes = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const note = (s) => { console.log(`note: ${s}`); notes.push(s); };
  let n = 0;
  const shot = async (name) => { await settle(frame); await sleep(300); await page.screenshot({ path: path.join(shots, `play-${String(++n).padStart(2, '0')}-${name}.png`) }); };
  const T = (re, scope, sel = BTN) => tap(page, frame, sel, re, scope);
  // iPhone 15 safe areas (Dynamic Island 59 pt, home bar 34 pt), if this Chromium can emulate them.
  let cdp = null;
  const insets = async (v) => {
    try {
      cdp = cdp || (await context.newCDPSession(page));
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: v });
      return true;
    } catch (e) { return false; }
  };
  try {
    const haveInsets = await insets({ top: 59, bottom: 34, left: 0, right: 0 });
    await page.goto(`${baseUrl}/artifact-test/host.html?q=${process.env.TL_Q || 'low'}&fresh=1`);
    await frame.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
    const envTop = await frame.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;padding-top:env(safe-area-inset-top,0px)'; document.body.appendChild(d); const v = getComputedStyle(d).paddingTop; d.remove(); return v; });
    note(`safe-area emulation ${haveInsets ? 'requested' : 'unavailable'}; env(safe-area-inset-top) = ${envTop}`);
    let s = await snap(frame);
    check(s.screen === 'title', 'title screen is up');
    await shot('title');

    check(await T(/new flight/), 'tapped New flight');
    await sleep(1200);
    s = await snap(frame);
    check(s.screen === 'station' && s.docked === 'tallow.st.chandlers-wheel', `docked at ${s.dockedName}, station screen`);
    const credits0 = s.credits;
    await shot('station-market');

    // buy: tap a market row, Max, Buy
    check((await T(/orchard/, null, '.tls-mrow')) || (await T(null, null, '.tls-mrow')), 'opened a commodity');
    await sleep(700);
    await T(/^max$/);
    await sleep(300);
    await shot('trade-sheet');
    check(await T(/^buy\s+\d/), 'tapped Buy');
    await sleep(900);
    s = await snap(frame);
    check(s.cargo > 0 && s.credits < credits0, `bought ${s.cargo} t for ${Math.round(credits0 - s.credits)} cr`);
    const creditsLoaded = s.credits;
    const cargoLoaded = s.cargo;

    // destination
    check(await T(/^departures/), 'opened Departures');
    await sleep(700);
    if (!(await T(/set as destination/, /gloaming lock/))) note('no "Set as destination" button for Gloaming Lock was tappable');
    await sleep(600);
    s = await snap(frame);
    if (s.target !== GLOAMING) {
      note('FALLBACK: destination set through window.__tidelock.game.setTarget, not the UI');
      await frame.evaluate((id) => window.__tidelock.game.setTarget({ kind: 'station', id }), GLOAMING);
      fail.push('destination could not be set from the station screen');
    }
    check((await snap(frame)).target === GLOAMING, 'destination is Gloaming Lock');
    await shot('departures');

    check(await T(/^\s*launch/), 'tapped Launch');
    await sleep(1000);
    await pump(frame, 60);
    s = await snap(frame);
    check(s.screen === 'flight' && !s.docked, `flight screen after launch (screen=${s.screen})`);
    await shot('launched');

    // hand the trip to the flight computer
    let went = false;
    for (let i = 0; i < 40 && !went; i++) {
      went = await T(/^go to /);
      if (!went) { await pump(frame, 60); await settle(frame); }
    }
    if (!went) {
      note('FALLBACK: flight computer engaged through window.__tidelock.game.engageAutopilot, not the "Go to" button');
      await frame.evaluate((id) => window.__tidelock.game.engageAutopilot({ kind: 'goToStation', stationId: id }), GLOAMING);
      fail.push('"Go to" button was not tappable');
    }
    await sleep(400);
    await pump(frame, 30);
    s = await snap(frame);
    check(s.ap, `flight computer engaged: ${s.status || s.failed}`);
    // raise time warp with the HUD button (the flight computer may already have asked for the maximum itself)
    const warpBefore = s.warpReq;
    let taps = 0;
    for (let i = 0; i < 12; i++) {
      const before = (await snap(frame)).warpReq;
      if (!(await T(/faster time/))) break;
      await sleep(150);
      taps++;
      if ((await snap(frame)).warpReq <= before) break;
    }
    s = await snap(frame);
    check(taps > 0 && s.warpReq > 1, `time warp: ${taps} tap(s) on "Faster time"; requested ${warpBefore}x before, ${s.warpReq}x after`);
    if (warpBefore >= s.warpReq) note('with the flight computer engaged it sets time warp itself; the HUD warp buttons answer with a notice until it is disengaged');
    if (s.warpReq <= 1) await frame.evaluate(() => window.__tidelock.game.setWarp(100000));

    // fly: the test steps the sim (see header); log each phase
    const t0 = s.time;
    let phase = '', frames = 0, shotCoast = false, shotBurn = false;
    const wall = Date.now();
    while (frames < 60000 && Date.now() - wall < 9 * 60000) {
      await pump(frame, 150);
      frames += 150;
      s = await snap(frame);
      if (s.phase !== phase) { phase = s.phase; console.log(`   [frame ${frames}, t+${Math.round(s.time - t0)} s, warp ${s.warp}x${s.warpWhy ? ' (' + s.warpWhy + ')' : ''}] ${s.phase}: ${s.status}`); }
      if (s.docked || s.failed || s.errPanel || !s.ap) break;
      if (!shotCoast && s.phase === 'coast' && s.warp > 1) { shotCoast = true; await shot('coast-warp'); }
      if (!shotBurn && s.phase === 'burn' && frames > 600) { shotBurn = true; await pump(frame, 60); await shot('burn'); }
    }
    check(s.docked === GLOAMING, `docked at Gloaming Lock after ${frames} stepped frames, ${((s.time - t0) / 3600).toFixed(2)} h of sim time${s.failed ? ' — flight computer: ' + s.failed : ''}`);
    for (let i = 0; i < 20 && (await snap(frame)).screen !== 'station'; i++) await sleep(300);
    s = await snap(frame);
    check(s.screen === 'station', `station screen at ${s.dockedName}`);
    await shot('docked-gloaming');

    // sell everything
    await T(/^market/);
    await sleep(400);
    check(await T(/^in hold/), 'filtered the market to the hold');
    await sleep(500);
    check(await T(null, null, '.tls-mrow--held'), 'opened the held commodity');
    await sleep(700);
    if (await T(/^sell$/)) await sleep(300);
    await T(/^max$/);
    await sleep(300);
    check(await T(/^sell\s+\d/), 'tapped Sell');
    await sleep(900);
    s = await snap(frame);
    check(s.cargo === 0 && s.credits > creditsLoaded, `sold ${cargoLoaded} t for ${Math.round(s.credits - creditsLoaded)} cr: trade profit ${Math.round(s.credits - credits0)} cr (credits ${Math.round(s.credits)})`);
    await shot('sold');

    // landscape flight view
    await insets({ top: 0, bottom: 21, left: 59, right: 59 });
    await page.setViewportSize({ width: 852, height: 393 });
    await sleep(800);
    check(await T(/^\s*launch/), 'tapped Launch (landscape)');
    await sleep(800);
    await pump(frame, 600);
    s = await snap(frame);
    check(s.screen === 'flight' && !s.docked, 'flying again in landscape');
    const w0 = s.warpReq;
    await T(/faster time/);
    await sleep(200);
    await T(/faster time/);
    await sleep(200);
    s = await snap(frame);
    check(s.warpReq > w0, `manual time warp (no flight computer): requested ${w0}x -> ${s.warpReq}x, running ${s.warp}x${s.warpWhy ? ' (' + s.warpWhy + ')' : ''}`);
    await pump(frame, 30);
    await shot('flight-landscape');
    check(s.faults === 0 && !s.errPanel, `no sim faults (${s.faults}), no error panel`);
  } catch (err) {
    fail.push(String((err && err.stack) || err));
    try { await page.screenshot({ path: path.join(shots, 'play-failure.png') }); } catch {}
  }
  for (const e of errors) console.log(`   ${e}`);
  check(errors.filter((e) => e.startsWith('pageerror')).length === 0, 'no page errors');
  const extra = requests.filter((u) => !/\/artifact-test\/host\.html(\?.*)?$/.test(u) && !/^(data|blob|about):/.test(u));
  check(extra.length === 0, `no network requests besides the page${extra.length ? ': ' + extra.join(', ') : ''}`);
  await browser.close();
  await close();
  if (notes.length) console.log(`NOTES:\n - ${notes.join('\n - ')}`);
  if (fail.length) { console.error(`PLAY FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('PLAY PASSED');
})();
