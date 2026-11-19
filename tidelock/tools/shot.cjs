#!/usr/bin/env node
// Screenshot a page from dist/ in headless Chromium (WebGL2 via SwiftShader).
//
//   node tools/shot.cjs <path-under-dist> <out.png> [options]
//
//   <path-under-dist>   e.g. "index.html", "dev/planet.html?cls=gasGiant&seed=7"
//   --device <name>     iphone15 (portrait, default) | iphone15l (landscape) | desktop
//   --dpr <n>           device scale factor override (1 = fast check, 2 = for people)
//   --wait <ms>         extra wait after window.__ready (default 500)
//   --no-ready          do not wait for window.__ready (just wait --wait ms)
//   --eval <js>         run JS in the page before the screenshot (may return a promise)
//   --tap <x,y>         tap at CSS pixel (repeatable; applied in order, 250 ms apart, before the screenshot)
//   --size <w>x<h>      viewport override in CSS px
//   --timeout <ms>      ready timeout (default 90000)
//
// Prints console/page errors, and exits 1 if there were page errors. Out paths are created as needed
// (keep them under shots/, which is git-ignored).

const fs = require('node:fs');
const path = require('node:path');
const { launch, serveDist, waitReady } = require('./pw.cjs');

(async () => {
  const argv = process.argv.slice(2);
  const positional = [];
  const opt = { device: 'iphone15', wait: 500, ready: true, taps: [], timeout: 90000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device') opt.device = argv[++i];
    else if (a === '--dpr') opt.dpr = Number(argv[++i]);
    else if (a === '--wait') opt.wait = Number(argv[++i]);
    else if (a === '--no-ready') opt.ready = false;
    else if (a === '--eval') opt.eval = argv[++i];
    else if (a === '--tap') opt.taps.push(argv[++i].split(',').map(Number));
    else if (a === '--size') opt.size = argv[++i].split('x').map(Number);
    else if (a === '--timeout') opt.timeout = Number(argv[++i]);
    else positional.push(a);
  }
  if (positional.length < 2) {
    console.error('usage: node tools/shot.cjs <path-under-dist> <out.png> [--device iphone15|iphone15l|desktop] [--dpr n] [--wait ms] [--eval js] [--tap x,y]');
    process.exit(2);
  }
  const [target, out] = positional;
  const overrides = {};
  if (opt.dpr) overrides.deviceScaleFactor = opt.dpr;
  if (opt.size) overrides.viewport = { width: opt.size[0], height: opt.size[1] };

  const server = await serveDist();
  const { browser, page, errors } = await launch(opt.device, overrides);
  let failed = false;
  try {
    await page.goto(`${server.baseUrl}/${target.replace(/^\//, '')}`, { waitUntil: 'load' });
    if (opt.ready) await waitReady(page, opt.timeout);
    if (opt.eval) await page.evaluate(opt.eval);
    for (const [x, y] of opt.taps) {
      await page.touchscreen.tap(x, y).catch(() => page.mouse.click(x, y));
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(opt.wait);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await page.screenshot({ path: out, timeout: Math.max(180000, opt.timeout) });
    console.log(`wrote ${out}`);
  } catch (e) {
    failed = true;
    console.error(`shot failed: ${e.message}`);
  } finally {
    for (const e of errors) console.error(e);
    if (errors.some((e) => e.startsWith('pageerror'))) failed = true;
    await browser.close();
    await server.close();
  }
  process.exit(failed ? 1 : 0);
})();
