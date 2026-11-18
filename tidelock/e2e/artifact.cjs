#!/usr/bin/env node
// Proves dist/tidelock-artifact.html (the fragment the Claude page viewer publishes): wraps it in a skeleton
// like the host's, serves it, and loads it twice in iPhone 15 emulation — directly, and inside
// <iframe sandbox="allow-scripts"> where localStorage throws. Each must reach the title, start a new flight,
// show the station screen, launch and fly, with no page errors and no requests besides the page itself.
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
const pump = (frame, n) => frame.evaluate((k) => { const g = window.__tidelock.game; for (let i = 0; i < k; i++) g.step(1 / 30); }, n);
const settle = (frame) => frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
const snap = (frame) => frame.evaluate(() => {
  const t = window.__tidelock, g = t.game, d = g.dockedStation(), p = g.player(), w = g.warp(), a = g.autopilot();
  return { screen: t.screen, docked: d ? d.id : null, dockedName: d ? d.name : null, time: g.time(), credits: p.credits, cargo: p.cargoUsed, target: (g.target() || {}).id || null,
    warp: w.level, warpReq: w.requested, warpWhy: w.limitReason, ap: a.engaged, phase: a.phase, status: a.status, failed: a.failed,
    faults: g.diagnostics().faults, errPanel: !!document.getElementById('tl-error'), alt: g.flightInfo().altitude };
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
      let s = await snap(frame);
      check(s.screen === 'title', `[${mode}] title screen is up (default quality: ${mode === 'direct'})`);
      check(await tap(page, frame, BTN, /new flight/), `[${mode}] tapped New flight`);
      await sleep(1200);
      s = await snap(frame);
      check(s.screen === 'station' && s.docked === 'tallow.st.chandlers-wheel', `[${mode}] station screen, docked at ${s.dockedName}`);
      await settle(frame);
      if (mode === 'iframe') await page.screenshot({ path: path.join(shots, `artifact-${mode}.png`) });
      check(await tap(page, frame, BTN, /^\s*launch/), `[${mode}] tapped Launch`);
      await sleep(800);
      const t0 = (await snap(frame)).time;
      await pump(frame, 600);
      await settle(frame);
      s = await snap(frame);
      if (mode === 'direct') { await sleep(1500); await settle(frame); await page.screenshot({ path: path.join(shots, `artifact-${mode}.png`) }); } // flight view at the default quality
      check(s.screen === 'flight' && !s.docked && s.time > t0 + 5 && Number.isFinite(s.alt), `[${mode}] flying: screen=${s.screen}, sim +${(s.time - t0).toFixed(0)} s, altitude ${(s.alt / 1000).toFixed(0)} km`);
      check(s.faults === 0 && !s.errPanel, `[${mode}] no sim faults, no error panel`);
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
