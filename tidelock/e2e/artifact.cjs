#!/usr/bin/env node
// Proves dist/tidelock-artifact.html (the fragment the Claude page viewer publishes): wraps it in a skeleton
// like the host's, serves it, and loads it twice in iPhone 15 emulation — directly, and inside
// <iframe sandbox="allow-scripts"> where localStorage throws. Each must reach the title, begin on a tap, strap
// in by a touch on the harness, take a touch on a hold lamp and keep flying, with no page errors and no
// requests besides the page itself.
//   node e2e/artifact.cjs [--no-build]        screenshots: shots/artifact-direct.png, shots/artifact-iframe.png
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, ROOT, DIST } = require('../tools/pw.cjs');

const SKELETON_HEAD = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}</style></head><body>';
const HOST_DIR = path.join(DIST, 'artifact-test');

/** Static checks on the fragment, then write artifact-test/host.html (wrapped) and frame.html (sandboxed iframe). Returns problems. */
function writeHostPages() {
  const file = path.join(DIST, 'tidelock-artifact.html');
  const frag = fs.readFileSync(file, 'utf8');
  const problems = [];
  const lines = frag.split('\n');
  if (lines[0] !== '<title>TIDELOCK</title>') problems.push('first line is not <title>TIDELOCK</title>');
  if (lines[1] !== '<meta name="claude:viewport-fit-sides" content="cover">') problems.push('second line is not the viewport-fit-sides meta');
  const scriptAt = frag.indexOf('<script>');
  const markup = frag.slice(0, scriptAt);
  if (/<(!doctype|html|head|body)[\s>]/i.test(markup)) problems.push('fragment has doctype/html/head/body tags');
  if ((markup.match(/<style/g) || []).length !== 1) problems.push('expected exactly one <style>');
  if ((frag.match(/<script/gi) || []).length !== 1 || (frag.match(/<\/script/gi) || []).length !== 1) problems.push('expected exactly one <script>…</script> (unescaped "</script" inside the code?)');
  if (/\b(src|href)\s*=/.test(markup)) problems.push('markup references an external file');
  if (/serviceWorker/.test(frag)) problems.push('service worker code present');
  if (/@import|url\(\s*['"]?https?:/i.test(frag)) problems.push('CSS pulls a remote resource');
  const bytes = fs.statSync(file).size;
  if (bytes > 16 * 1024 * 1024) problems.push(`fragment is ${bytes} bytes (> 16 MB)`);
  fs.mkdirSync(HOST_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOST_DIR, 'host.html'), `${SKELETON_HEAD}${frag}</body></html>`);
  fs.writeFileSync(path.join(HOST_DIR, 'frame.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html,body{height:100%;margin:0;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" src="host.html?q=low"></iframe></body></html>');
  return { problems, bytes };
}

/** Tap the first visible, enabled element matching `sel` whose text or aria-label matches `re` (and whose card matches `scope`). */
async function tap(page, frame, sel, re, scope) {
  const box = await frame.evaluate(([s, src, sc]) => {
    const rx = src ? new RegExp(src, 'i') : null;
    const rs = sc ? new RegExp(sc, 'i') : null;
    for (const b of document.querySelectorAll(s)) {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      const txt = (b.textContent || '').trim();
      if (rx && !rx.test(txt) && !rx.test(b.getAttribute('aria-label') || '')) continue;
      if (rs) {
        let p = b.parentElement;
        while (p && (p.textContent || '').trim() === txt) p = p.parentElement;
        if (!p || !rs.test(p.textContent || '')) continue;
      }
      if (b.getClientRects().length === 0) continue;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && !(b.contains(hit) || hit.contains(b))) continue; // covered by something else
      return { x, y };
    }
    return null;
  }, [sel, re ? re.source : null, scope ? scope.source : null]);
  if (!box) return false;
  await page.touchscreen.tap(box.x, box.y);
  return true;
}
const BTN = 'button, [role="button"], [role="tab"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pump = (frame, n) => frame.evaluate((k) => { const g = window.__tidelock.session; for (let i = 0; i < k; i++) g.step(1 / 30); }, n);
const settle = (frame) => frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
const snap = (frame) => frame.evaluate(() => {
  const t = window.__tidelock, g = t.session, p = g.player(), w = g.warp(), f = g.flight();
  return { screen: t.screen, docked: p.dockedTo, time: g.time(), target: (g.target() || {}).id || null, warp: w.achieved, warpReq: w.requested, warpWhy: w.limitedBy,
    errPanel: !!document.getElementById('tl-error'), alt: f.altitude, apo: f.apoapsisAlt, peri: f.periapsisAlt, speed: f.speed, primary: f.primaryName, situation: f.situation,
    throttle: p.throttle, hold: p.hold, dv: p.deltaV, hud: !!document.querySelector('[data-hud="main"]') && document.querySelector('[data-hud="main"]').getClientRects().length > 0 };
});

async function run() {
  const args = process.argv.slice(2);
  if (!args.includes('--no-build')) execSync('node build.mjs --artifact', { cwd: ROOT, stdio: 'inherit' });
  const shots = path.join(ROOT, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { problems, bytes } = writeHostPages();
  check(problems.length === 0, `fragment shape (${(bytes / 1024).toFixed(0)} KiB)${problems.length ? ': ' + problems.join('; ') : ''}`);
  const { baseUrl, close } = await serveDist();
  for (const mode of ['direct', 'iframe']) {
    const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 1 });
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    try {
      await page.goto(`${baseUrl}/artifact-test/${mode === 'direct' ? 'host.html' : 'frame.html'}`);
      let frame = page.mainFrame();
      if (mode === 'iframe') {
        for (let i = 0; i < 50 && page.frames().length < 2; i++) await sleep(100);
        frame = page.frames().find((f) => f !== page.mainFrame());
        const ls = await frame.evaluate(() => { try { window.localStorage.getItem('x'); return 'works'; } catch (e) { return 'throws'; } });
        check(ls === 'throws', `[${mode}] localStorage ${ls} in the sandboxed frame`);
      }
      await frame.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
      // the new way in: tap to begin -> on foot behind the left seat -> tap the harness -> tap a hold lamp,
      // all by touches that go through the 3D picker (helpers of e2e/cockpit.cjs)
      const { fingers, pickMap, painted, st } = require('./cockpit.cjs');
      const h = await fingers(page, frame);
      let s = await snap(frame);
      check(s.screen === 'title', `[${mode}] title screen is up (default quality: ${mode === 'direct'})`);
      const vw = page.viewportSize();
      await h.tapAt(vw.width / 2, vw.height * 0.45);
      await sleep(1200);
      await settle(frame);
      let c = await st(frame);
      check(c.screen === 'flight' && c.mode === 'onFoot' && c.stick && !c.docked, `[${mode}] tap to begin: on foot in the cockpit, walk stick up, flying free around ${s.primary} (${s.situation})`);
      const buckle = await frame.evaluate(() => window.__tidelock.session.cockpit().devices.find((d) => d.id === 'harness').pos);
      await h.aimAt(buckle, 0.15);
      await settle(frame);
      let map = await pickMap(frame, 6);
      if (map.harness) await h.tapAt(map.harness.x, map.harness.y);
      await pump(frame, 20);
      await sleep(500);
      await settle(frame);
      c = await st(frame);
      const ui = await painted(frame);
      check(c.mode === 'helm' && c.posture === 'seated' && !c.stick && ui.length === 0, `[${mode}] tapped the harness: strapped in, nothing drawn over the view [${ui.join(', ')}]`);
      map = await pickMap(frame, 6);
      if (map['hold-pro']) await h.tapAt(map['hold-pro'].x, map['hold-pro'].y);
      const t0 = c.time;
      await pump(frame, 600);
      await settle(frame);
      c = await st(frame);
      s = await snap(frame);
      check(c.hold === 'prograde' && c.dev['hold-pro'].lit && !!c.fl && c.fl.hold.length > 0, `[${mode}] tapped the PRO lamp: hold = ${c.hold}, lamp lit, FLIGHT screen has data`);
      const cost = await frame.evaluate(() => { const k = window.__tidelock.scene.stats(); return `${k.drawCalls} draw calls, ${k.triangles} triangles`; });
      await sleep(mode === 'direct' ? 1500 : 300);
      await settle(frame);
      await page.screenshot({ timeout: 180000, path: path.join(shots, `artifact-${mode}.png`) });
      check(s.screen === 'flight' && s.time > t0 + 5 && Number.isFinite(s.alt), `[${mode}] flying: sim +${(s.time - t0).toFixed(0)} s, altitude ${(s.alt / 1000).toFixed(0)} km; frame from the seat: ${cost}`);
      check(!s.errPanel, `[${mode}] no error panel`);
    } catch (err) {
      fail.push(`[${mode}] ${String((err && err.stack) || err)}`);
    }
    for (const e of errors) console.log(`   ${e}`);
    check(errors.filter((e) => e.startsWith('pageerror')).length === 0, `[${mode}] no page errors`);
    const extra = requests.filter((u) => !/\/artifact-test\/(host|frame)\.html(\?.*)?$/.test(u) && !/^(data|blob|about):/.test(u));
    const soft = requests.filter((u) => /^(data|blob):/.test(u)).length;
    check(extra.length === 0, `[${mode}] no network requests besides the page (${requests.length} total, ${soft} data:/blob:)${extra.length ? ': ' + extra.join(', ') : ''}`);
    await browser.close();
  }
  await close();
  if (fail.length) { console.error(`ARTIFACT CHECK FAILED:\n - ${fail.join('\n - ')}`); process.exit(1); }
  console.log('ARTIFACT CHECK PASSED');
}

module.exports = { writeHostPages, tap, pump, settle, snap, sleep, BTN };
if (require.main === module) run();
