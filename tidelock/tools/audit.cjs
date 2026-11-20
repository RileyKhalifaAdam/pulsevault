#!/usr/bin/env node
// Budget audit of the player's ship on every tier and ray-tracing setting, in iPhone 15 emulation (software GL).
//   * views of dev/lighting.html (run `node build.mjs --harness lighting` first) at dpr 1 (draw calls, triangles,
//     programs and textures do not depend on the resolution), plus the title view of the game (dist/index.html);
//   * `memory`: the game itself at the phone's real size (393x852 CSS px, DPR 2 -> 786x1704) after load and the
//     texture upgrades: textures + render targets (with the MSAA actually chosen and at 4x / 2x) + the ray tracer's
//     buffers for every RT tier — the total GPU memory the phone would hold (budget 300 MB).
//   node tools/audit.cjs [--tiers low,medium,high,ultra] [--rt off,low,high] [--views title,hero,lounge,aft,cargo,dark,memory]
// Prints one line per view; writes shots/audit.txt.
const fs = require('fs');
const path = require('path');
const { launch, serveDist, waitReady } = require('./pw.cjs');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const tiers = arg('--tiers', 'low,medium,high,ultra').split(',');
const rts = arg('--rt', 'off,high').split(',');
const views = arg('--views', 'title,hero,lounge,aft,cargo,dark,memory').split(',');
const MB = (b) => (b / 1048576).toFixed(1);

(async () => {
  const server = await serveDist();
  const lines = [];
  const say = (s) => {
    console.log(s);
    lines.push(s);
  };
  for (const q of tiers) {
    for (const v of views) {
      for (const rt of v === 'memory' ? ['-'] : rts) {
        const tag = `${q.padEnd(6)} RT ${rt.padEnd(5)} ${v.padEnd(8)}`;
        const phone = v === 'memory';
        const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: phone ? 2 : 1 });
        try {
          const t0 = Date.now();
          if (v === 'title' || phone) {
            await page.goto(`${server.baseUrl}/index.html?q=${q}&fresh=1${phone ? '' : `&rt=${rt}`}`, { waitUntil: 'load' });
            await waitReady(page, 1200000);
            const tReady = Date.now();
            for (let i = 0; i < 120; i++) {
              const busy = await page.evaluate(() => /upgrading|pending/.test(globalThis.__tlInterior ?? '') || window.__tidelock.scene.busy());
              if (!busy) break;
              await page.waitForTimeout(1000);
            }
            await page.waitForTimeout(phone ? 3000 : 4000);
            const r = await page.evaluate(() => {
              const t = window.__tidelock, sc = t.scene, p = t.pipeline, ps = p.stats(), s = sc.stats();
              const tr = sc.rt;
              const rows = [];
              for (const tier of ['off', 'low', 'medium', 'high', 'ultra']) rows.push([tier, tr.bytesAt(tier, ps.outputWidth, ps.outputHeight)]);
              return { dc: s.drawCalls, tri: s.triangles, tex: s.textureBytes, tgt: s.targetBytes, rtb: s.rtBytes, msaa: ps.msaa, w: ps.outputWidth, h: ps.outputHeight,
                t4: p.targetBytesAt(4), t2: p.targetBytesAt(2), rows, prog: p.renderer.info.programs.length, load: globalThis.__tlLoad || '', interior: globalThis.__tlInterior || '' };
            });
            if (phone) {
              say(`${tag} ${r.w}x${r.h} · textures ${MB(r.tex)} MB · targets now ${MB(r.tgt)} MB (msaa ${r.msaa}x; 4x ${MB(r.t4)}, 2x ${MB(r.t2)}) · page ready ${((tReady - t0) / 1000).toFixed(0)} s`);
              for (const [tier, b] of r.rows) say(`        RT ${tier.padEnd(6)} rt ${MB(b).padStart(5)} MB · total msaa4 ${MB(r.tex + r.t4 + b)} MB · msaa2 ${MB(r.tex + r.t2 + b)} MB`);
              say(`        interior: ${r.interior}`);
            } else {
              say(`${tag} dc ${r.dc} · tris ${(r.tri / 1000).toFixed(0)}k · tex ${MB(r.tex)} MB · targets ${MB(r.tgt)} MB · rt ${MB(r.rtb)} MB · programs ${r.prog} · ready ${((tReady - t0) / 1000).toFixed(0)} s\n        load: ${r.load}`);
            }
          } else {
            await page.goto(`${server.baseUrl}/dev/lighting.html?view=${v}&q=${q}&rt=${rt}&frames=8`, { waitUntil: 'load' });
            await waitReady(page, 1200000);
            const txt = await page.evaluate(() => document.querySelector('pre').textContent);
            const m = (re) => (txt.match(re) || [])[1] || '?';
            say(`${tag} dc ${m(/draw calls (\d+)/)} · tris ${(Number(m(/triangles (\d+)/)) / 1000).toFixed(0)}k · tex ${m(/textures ([\d.]+) MB/)} MB · targets ${m(/targets ([\d.]+) MB/)} MB · rt ${m(/\+ rt ([\d.]+) =/)} MB · programs ${m(/programs (\d+)/)} · rooms ${m(/rooms (\d+\/\d+)/)} · load ${m(/load ([\d.]+) s/)} s · ${m(/(rt \w+ active \w+)/)}\n        load: ${m(/load: ([^\n]*)/)}`);
            if (/ERROR/.test(txt)) say(txt.slice(0, 400));
          }
          for (const e of errors) if (/pageerror/.test(e)) say(`        ${e.slice(0, 200)}`);
        } catch (e) {
          say(`${tag} FAILED ${e.message.split('\n')[0]}`);
        } finally {
          await browser.close();
        }
        fs.mkdirSync(path.join(__dirname, '..', 'shots'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '..', 'shots', 'audit.txt'), lines.join('\n') + '\n');
      }
    }
  }
  await server.close();
})();
