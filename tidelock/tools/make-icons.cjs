#!/usr/bin/env node
// Render the TIDELOCK app icon to web/icon-180.png, web/icon-192.png and web/icon-512.png.
//
//   node tools/make-icons.cjs [--out <dir>] [--sizes 180,192,512]
//
// The artwork is appIcon() in src/ui/kit/icons.ts (the emblem on a deep-space gradient above a thin
// ember limb), so the PNGs always match the mark used in the game. The module is bundled in memory
// with esbuild and rasterised by headless Chromium at each target size (vector -> exact pixels, no
// resampling). Full-bleed square: iOS and Android apply their own masks.

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { launch, ROOT } = require('./pw.cjs');

(async () => {
  const argv = process.argv.slice(2);
  const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const outDir = path.resolve(arg('--out', path.join(ROOT, 'web')));
  const sizes = String(arg('--sizes', '180,192,512')).split(',').map(Number).filter((n) => n >= 16 && n <= 2048);

  const bundle = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/ui/kit/icons.ts')],
    bundle: true, format: 'iife', globalName: 'TidelockIcons', target: 'es2022', write: false, logLevel: 'warning',
  });
  const { browser, page, errors } = await launch('desktop', { viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  let failed = false;
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#05070b;overflow:hidden}svg{display:block}</style></head><body></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    fs.mkdirSync(outDir, { recursive: true });
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      await page.evaluate((s) => document.body.replaceChildren(window.TidelockIcons.appIcon(s)), size);
      const file = path.join(outDir, `icon-${size}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: size, height: size } });
      console.log(`wrote ${path.relative(ROOT, file)} (${size}×${size}, ${(fs.statSync(file).size / 1024).toFixed(1)} KiB)`);
    }
  } catch (e) {
    failed = true;
    console.error(`make-icons failed: ${e.message}`);
  } finally {
    for (const e of errors) console.error(e);
    if (errors.length) failed = true;
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})();
