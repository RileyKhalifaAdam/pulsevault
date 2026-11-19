#!/usr/bin/env node
// Budget audit of the player's ship on every tier, in iPhone 15 emulation (software GL, dpr 1: the counts do
// not depend on the resolution). Views of dev/lighting.html (run `node build.mjs --harness lighting` first)
// plus the title view of the game itself (dist/index.html, `node build.mjs`).
//   node tools/audit.cjs [--tiers low,medium,high,ultra] [--views title,hero,lounge,aft,cargo,engineering,dark]
// Prints one line per view: draw calls, triangles, texture MB, programs, load ms; writes shots/audit.txt.
const fs = require('fs');
const path = require('path');
const { launch, serveDist, waitReady } = require('./pw.cjs');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const tiers = arg('--tiers', 'low,medium,high,ultra').split(',');
const views = arg('--views', 'title,hero,lounge,aft,cargo,engineering,dark').split(',');

(async () => {
  const server = await serveDist();
  const lines = [];
  const say = (s) => {
    console.log(s);
    lines.push(s);
  };
  for (const q of tiers) {
    for (const v of views) {
      const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 1 });
      try {
        const t0 = Date.now();
        if (v === 'title') {
          await page.goto(`${server.baseUrl}/index.html?q=${q}&fresh=1`, { waitUntil: 'load' });
          await waitReady(page, 240000);
          await page.waitForTimeout(4000);
          const r = await page.evaluate(() => {
            const t = window.__tidelock;
            const s = t.scene.stats();
            return { dc: s.drawCalls, tri: s.triangles, tex: s.textureBytes, prog: t.pipeline.renderer.info.programs.length, load: globalThis.__tlLoad || '' };
          });
          say(`${q.padEnd(6)} ${v.padEnd(12)} dc ${r.dc} · tris ${(r.tri / 1000).toFixed(0)}k · tex ${(r.tex / 1048576).toFixed(0)} MB · programs ${r.prog} · page ${((Date.now() - t0) / 1000).toFixed(0)} s\n        load: ${r.load}`);
        } else {
          await page.goto(`${server.baseUrl}/dev/lighting.html?view=${v}&q=${q}&frames=8`, { waitUntil: 'load' });
          await waitReady(page, 300000);
          const txt = await page.evaluate(() => document.querySelector('pre').textContent);
          const m = (re) => (txt.match(re) || [])[1] || '?';
          say(`${q.padEnd(6)} ${v.padEnd(12)} dc ${m(/draw calls (\d+)/)} · tris ${(Number(m(/triangles (\d+)/)) / 1000).toFixed(0)}k · tex ${m(/textures ([\d.]+) MB/)} MB · targets ${m(/targets ([\d.]+) MB/)} MB · probes ${m(/probes ([\d.]+) MB/)} MB · programs ${m(/programs (\d+)/)} · rooms ${m(/rooms (\d+\/\d+)/)} · load ${m(/load ([\d.]+) s/)} s\n        ${m(/(build [^\n]*)/)}\n        load: ${m(/load: ([^\n]*)/)}`);
          if (/ERROR/.test(txt)) say(txt.slice(0, 400));
        }
        for (const e of errors) if (/pageerror/.test(e)) say(`        ${e.slice(0, 200)}`);
      } catch (e) {
        say(`${q} ${v} FAILED ${e.message.split('\n')[0]}`);
      } finally {
        await browser.close();
      }
    }
  }
  await server.close();
  fs.mkdirSync(path.join(__dirname, '..', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'shots', 'audit.txt'), lines.join('\n') + '\n');
})();
