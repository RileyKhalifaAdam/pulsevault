#!/usr/bin/env node
// Scripted check of the render pipeline in headless Chromium (not a vitest file: needs a GL context).
//
//   node build.mjs --harness pipeline && node tests/pipeline.e2e.cjs
//
// Exercises, on one live page: portrait -> landscape -> portrait resize, WEBGL_lose_context loss and
// restore (MSAA tier and FXAA tier), run-time quality switches, exposure / bloom setters and dispose().
// Frames are compared through window.__h.signature() (8x8 mean luminances + mean RGB of the canvas).
// Screenshots of the interesting states are written to shots/pipeline-e2e-*.png.

const path = require('node:path');
const { launch, serveDist, waitReady } = require('../tools/pw.cjs');

const SHOTS = path.resolve(__dirname, '..', 'shots');
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
/** Mean and max absolute difference over luminance-cell rows 0..`rows`-1 (row 0 = bottom of the frame). */
function diff(a, b, rows = 8) {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < rows * 8; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / (rows * 8), max };
}
const fmt = (d) => `mean ${d.mean.toFixed(2)} max ${d.max.toFixed(2)}`;

(async () => {
  const server = await serveDist();
  const { browser, page, errors } = await launch('iphone15', { deviceScaleFactor: 2 });
  const state = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas');
      const s = window.__h.pipeline.stats();
      return {
        w: c.width, h: c.height, cssW: c.style.width, cssH: c.style.height,
        quality: window.__h.pipeline.quality, msaa: s.msaa, scale: s.resolutionScale,
        sceneW: s.width, sceneH: s.height, draws: s.drawCalls, tris: s.triangles, passes: s.postPasses,
        ratio: window.__h.pipeline.pixelRatio,
      };
    });
  const signature = () => page.evaluate(() => window.__h.signature());
  const settle = async () => {
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  try {
    await page.goto(`${server.baseUrl}/dev/pipeline.html?quality=high&frames=2`, { waitUntil: 'load' });
    await waitReady(page, 90000);

    // ---- portrait baseline
    let st = await state();
    check('portrait: backing store = css x min(dpr, tier cap)', st.w === 786 && st.h === 1704, `${st.w}x${st.h}`);
    check('portrait: css box untouched', st.cssW === '393px' && st.cssH === '852px', `${st.cssW} x ${st.cssH}`);
    check('high tier renders through 4x MSAA', st.msaa === 4, `msaa ${st.msaa}`);
    check('two layers drawn', st.draws > 10 && st.tris > 1000, `${st.draws} draws, ${st.tris} tris, ${st.passes} post passes`);
    const sigA = await signature();
    check('image is not blank and blacks are black', sigA[65] > 1 && Math.min(...sigA.slice(0, 64)) < 2, `mean G ${sigA[65].toFixed(2)}, darkest cell ${Math.min(...sigA.slice(0, 64)).toFixed(2)}`);
    const sigA2 = await signature();
    check('consecutive frames are stable (grain / dither only)', diff(sigA, sigA2).max < 0.5, fmt(diff(sigA, sigA2)));

    // ---- resize portrait -> landscape -> portrait
    await page.setViewportSize({ width: 852, height: 393 });
    await settle();
    st = await state();
    check('landscape: backing store follows', st.w === 1704 && st.h === 786, `${st.w}x${st.h}`);
    check('landscape: css box follows', st.cssW === '852px' && st.cssH === '393px', `${st.cssW} x ${st.cssH}`);
    check('landscape: scene target follows', st.sceneW === 1704 && st.sceneH === 786, `${st.sceneW}x${st.sceneH}`);
    const sigL = await signature();
    check('landscape frame differs from portrait and is not blank', diff(sigA, sigL).mean > 0.3 && sigL[65] > 1, fmt(diff(sigA, sigL)));
    await page.screenshot({ path: path.join(SHOTS, 'pipeline-e2e-landscape.png') });
    await page.setViewportSize({ width: 393, height: 852 });
    await settle();
    st = await state();
    const sigP = await signature();
    check('back to portrait: same size, same image', st.w === 786 && st.h === 1704 && diff(sigA, sigP).max < 0.5, `${st.w}x${st.h}, ${fmt(diff(sigA, sigP))}`);

    // ---- context loss / restore on the MSAA tier
    const log = await page.evaluate(() => window.__h.loseContext(300));
    check('context loss: hooks fired in order', log.join(',') === 'lost,restored', log.join(','));
    await settle();
    st = await state();
    const sigR = await signature();
    check('context restored: MSAA path is back', st.msaa === 4 && st.w === 786, `msaa ${st.msaa}`);
    check('context restored: same image as before the loss', diff(sigP, sigR).max < 0.75, fmt(diff(sigP, sigR)));
    await page.screenshot({ path: path.join(SHOTS, 'pipeline-e2e-restored.png') });

    // ---- run-time quality switches (MSAA <-> FXAA paths, DPR caps)
    await page.evaluate(() => window.__h.pipeline.setQuality('low'));
    st = await state();
    const sigLow = await signature();
    check('low: dpr cap 1.0, FXAA path', st.w === 393 && st.h === 852 && st.msaa === 0 && st.ratio === 1, `${st.w}x${st.h} msaa ${st.msaa}`);
    check('low: same picture, coarser', diff(sigA, sigLow).mean < 2.5, fmt(diff(sigA, sigLow)));
    await page.evaluate(() => window.__h.pipeline.setQuality('medium'));
    st = await state();
    const sigMed = await signature();
    check('medium: dpr cap 1.5, FXAA path', st.w === 590 && st.h === 1278 && st.msaa === 0, `${st.w}x${st.h} msaa ${st.msaa}`);
    check('medium: same picture', diff(sigA, sigMed).mean < 2, fmt(diff(sigA, sigMed)));
    const log2 = await page.evaluate(() => window.__h.loseContext(200));
    await settle();
    const sigMedR = await signature();
    check('context loss on the FXAA tier recovers', log2.slice(-2).join(',') === 'lost,restored' && diff(sigMed, sigMedR).max < 0.75, fmt(diff(sigMed, sigMedR)));

    // ---- dynamic-resolution scale changes only the scene target
    await page.evaluate(() => window.__h.pipeline.setQuality('high'));
    await page.evaluate(() => window.__h.pipeline.setDynamicResolution(false, 0.6));
    const sig06 = await signature();
    st = await state();
    check('scale 0.6: scene target shrinks, canvas does not', st.sceneW === 472 && st.sceneH === 1022 && st.w === 786 && st.cssW === '393px', `scene ${st.sceneW}x${st.sceneH}, canvas ${st.w}x${st.h}`);
    // Bottom five rows only: the top of the frame is crossed by the harness's 1-internal-pixel GL lines,
    // which get wider (more light per cell) when the scene target shrinks — a property of GL lines, not of
    // the post chain.
    check('scale 0.6: same picture (bloom does not breathe)', diff(sigA, sig06, 5).mean < 1 && diff(sigA, sig06, 5).max < 3, fmt(diff(sigA, sig06, 5)));
    await page.evaluate(() => window.__h.pipeline.setDynamicResolution(false, 1));
    const sigH = await signature();
    check('back on high at full scale: same image as the baseline', diff(sigA, sigH).max < 0.75, fmt(diff(sigA, sigH)));

    // ---- setters
    await page.evaluate(() => window.__h.pipeline.setExposure(1));
    const sigEv = await signature();
    check('setExposure(+1) brightens', sigEv[65] > sigA[65] * 1.15, `mean G ${sigA[65].toFixed(2)} -> ${sigEv[65].toFixed(2)}`);
    await page.evaluate(() => { window.__h.pipeline.setExposure(0); window.__h.pipeline.setBloom(0); });
    const sigNoBloom = await signature();
    check('setBloom(0) removes the halos', sigNoBloom[65] < sigA[65] - 0.1, `mean G ${sigA[65].toFixed(2)} -> ${sigNoBloom[65].toFixed(2)}`);
    await page.evaluate(() => { window.__h.pipeline.setBloom(0.15); window.__h.pipeline.setEffect('flash', 1); });
    const sigFlash = await signature();
    check("setEffect('flash', 1) whites out", Math.min(...sigFlash.slice(0, 64)) > 250, `darkest cell ${Math.min(...sigFlash.slice(0, 64)).toFixed(1)}`);
    await page.evaluate(() => window.__h.pipeline.setEffect('flash', 0));

    // ---- dispose
    const disposed = await page.evaluate(() => {
      window.__h.pipeline.dispose();
      window.__h.frame(); // must be a harmless no-op
      return true;
    });
    check('dispose() and a late render() do not throw', disposed === true);
  } catch (e) {
    failures++;
    console.error(`e2e aborted: ${e.message}`);
  } finally {
    for (const e of errors) console.error(e);
    check('no page errors / console errors', errors.length === 0, `${errors.length}`);
    await browser.close();
    await server.close();
  }
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})();
