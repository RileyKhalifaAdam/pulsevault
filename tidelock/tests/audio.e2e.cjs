#!/usr/bin/env node
// End-to-end check of the W1-D sound engine in Chromium (Playwright), inside an <iframe sandbox="allow-scripts">
// like the owner's viewer (e2e/artifact.cjs): opaque origin, no storage, no network.
//
//   AUDIO_E2E_DIR=<scratch dir> node tests/audio.e2e.cjs
//
// Bundles dev/harness/audio.ts with esbuild into AUDIO_E2E_DIR (default: <tmp>/tidelock-audio-e2e) as one inline
// page, serves that directory on a free port and checks:
//   - no AudioContext exists before a gesture, and a context made then is 'suspended' (the policy is enforced);
//   - a pointerdown alone does not start sound; releasing the finger (pointerup) makes it 'running';
//   - with no cause the output is silent; jet duty gives sound (AnalyserNode RMS); duty 0 gives silence again;
//   - an impact event gives a transient; a vacuum cabin with a floating body is silent while the jets fire;
//   - the context runs at 48 kHz, the bake rate (no second bake on the first tap);
//   - the mix chain is transparent below the limiter (94 dB = 1.0) and the worst coincidence stays under full scale;
//   - page hidden → suspended; visible again outside a gesture (resume() left pending, as the spec says) → the next
//     tap resumes it;
//   - zero network requests beyond the two pages; no page errors;
//   - and it measures the main-thread cost per update and the audio-render cost of the worst-case graph.
// Not testable here (reported as unverified): iOS's silent switch, navigator.audioSession, 'interrupted'.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const { serveDist } = require('../tools/pw.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.AUDIO_E2E_DIR || path.join(os.tmpdir(), 'tidelock-audio-e2e');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const res = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'dev/harness/audio.ts')], bundle: true, format: 'iife', write: false, target: 'es2022', minify: true, logLevel: 'warning',
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  fs.writeFileSync(path.join(OUT, 'audio.js'), js);
  fs.writeFileSync(path.join(OUT, 'audio.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{height:100%;margin:0;background:#05070a}</style></head><body><script>${js}</script></body></html>`);
  fs.writeFileSync(path.join(OUT, 'frame.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html,body{height:100%;margin:0;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts" src="audio.html?fans=0&policy=webkit&vis=emulate"></iframe></body></html>');
  console.log(`page: ${path.join(OUT, 'audio.html')} (${(js.length / 1024).toFixed(1)} KB of script)`);

  const fail = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };
  const { baseUrl, close } = await serveDist(OUT);
  // No --autoplay-policy=no-user-gesture-required here (tools/pw.cjs adds it for the game shots): the default
  // policy must hold, or "running only after a tap" would prove nothing.
  const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('request', (r) => requests.push(r.url()));
  const lines = [];
  try {
    await page.goto(`${baseUrl}/frame.html`);
    let fr = null;
    for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f.url().includes('audio.html')); if (!fr) await sleep(50); }
    await fr.waitForFunction(() => window.__ready === true && window.__audio.baked(), null, { timeout: 60000 });
    const A = (fn, arg) => fr.evaluate(fn, arg);
    const bake = await A(() => window.__audio.bake());
    lines.push(`bake (Chromium, background slices): ${bake.ms.toFixed(0)} ms of work, ${(bake.bytes / 1e6).toFixed(2)} MB of buffers`);
    check(await A(() => window.__audio.state()) === 'none', 'no AudioContext before any gesture');
    // Headless Chromium does not enforce the Web Audio autoplay rule (a context made without a gesture runs), so
    // the harness emulates WebKit's: suspended outside a user activation, resume() refused unless activation is
    // live. The engine must therefore create and resume its context inside the release of the finger.
    const probe = await A(() => window.__audio.probeSuspended());
    lines.push(`context made without a gesture: '${probe.browser}' in this headless Chromium (rule not enforced here), '${probe.webkitRule}' under the emulated WebKit rule`);
    check(probe.webkitRule === 'suspended', `a context made without a gesture is '${probe.webkitRule}' under the WebKit rule`);

    const box = await page.locator('iframe').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    await sleep(400);
    check(await A(() => window.__audio.state()) === 'none', 'finger down (touchstart / pointerdown) alone: no AudioContext, no sound');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    let st = '';
    for (let i = 0; i < 40 && st !== 'running'; i++) { st = await A(() => window.__audio.state()); if (st !== 'running') await sleep(50); }
    check(st === 'running', `finger lifted (touchend / pointerup): AudioContext '${st}', resumed inside the activation`);
    const rate = await A(() => window.__audio.rate());
    const stats0 = await A(() => window.__audio.stats());
    const rebakes = await A(() => window.__audio.rebakes());
    check(rate === 48000 && rebakes === 0 && stats0.bufferBytes === bake.bytes,
      `context at ${rate} Hz = the bake rate: no second bake (rebakes ${rebakes}, engine buffers ${(stats0.bufferBytes / 1e6).toFixed(2)} MB = baked ${(bake.bytes / 1e6).toFixed(2)} MB)`);

    // silence without a cause
    await sleep(600);
    await A(() => window.__audio.level());
    await sleep(500);
    let lv = await A(() => window.__audio.level());
    check(lv.n > 0 && lv.peak < 1e-4, `nothing firing, fans off: output silent (rms ${lv.rms.toExponential(1)}, peak ${lv.peak.toExponential(1)}, ${lv.n} samples read)`);

    // jets: thump-hiss
    await A(() => window.__audio.set({ duty: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0] }));
    await sleep(150);
    await A(() => window.__audio.level());
    await sleep(500);
    lv = await A(() => window.__audio.level());
    const jetRms = lv.rms;
    check(lv.rms > 3e-3, `two jets at duty 1: output ${(94 + 20 * Math.log10(lv.rms)).toFixed(0)} dB SPL rms (rms ${lv.rms.toExponential(2)}, peak ${lv.peak.toFixed(3)})`);
    // the same jets in a vacuum cabin, body floating (no air, no contact): nothing reaches the ear
    await A(() => window.__audio.set({ cabin: 0, posture: 'floating', gripped: false }));
    await sleep(700);
    await A(() => window.__audio.level());
    await sleep(400);
    lv = await A(() => window.__audio.level());
    check(lv.peak < 1e-4, `vacuum cabin, floating, jets still firing: silent (peak ${lv.peak.toExponential(1)})`);
    await A(() => window.__audio.set({ cabin: 101325, posture: 'seated', duty: [] }));
    await sleep(500);
    await A(() => window.__audio.level());
    await sleep(400);
    lv = await A(() => window.__audio.level());
    check(lv.peak < 1e-4, `duty back to 0: silent again (peak ${lv.peak.toExponential(1)})`);

    // an impact event: the clink of a mug on the deck
    await A(() => window.__audio.level());
    await A(() => window.__audio.impact(0.54));
    await sleep(300);
    lv = await A(() => window.__audio.level());
    check(lv.peak > 5e-3, `impact J = 0.54 N·s (0.4 kg mug at ~1 m/s): transient peak ${(94 + 20 * Math.log10(lv.peak)).toFixed(0)} dB SPL (${lv.peak.toFixed(3)})`);
    await sleep(800);
    await A(() => window.__audio.level());
    await A(() => window.__audio.impact(1.08));
    await sleep(300);
    const lv2 = await A(() => window.__audio.level());
    check(lv2.peak > lv.peak * 1.4, `twice the impulse is louder: peak ${lv.peak.toFixed(3)} -> ${lv2.peak.toFixed(3)}`);

    // above 4x warp continuous sources mute
    await A(() => window.__audio.set({ duty: [1, 1, 1, 1], warp: 10 }));
    await sleep(500);
    await A(() => window.__audio.level());
    await sleep(400);
    lv = await A(() => window.__audio.level());
    check(lv.peak < 1e-4, `jets firing at 10x warp: continuous sources muted (peak ${lv.peak.toExponential(1)}; at 1x the same jets were rms ${jetRms.toExponential(1)})`);
    await A(() => window.__audio.set({ duty: [], warp: 1 }));

    // hidden → suspended; visible again outside a gesture: resume() stays pending (spec), the tap listeners are
    // re-armed, and the next tap brings the sound back
    await A(() => window.__audio.hide());
    let hs = '';
    for (let i = 0; i < 40 && hs !== 'suspended'; i++) { hs = await A(() => window.__audio.state()); if (hs !== 'suspended') await sleep(50); }
    check(hs === 'suspended', `page hidden: context '${hs}'`);
    await A(() => window.__audio.show());
    await sleep(300);
    const vs = await A(() => window.__audio.state());
    const pend = await A(() => window.__audio.pendingResumes());
    check(vs === 'suspended' && pend > 0, `visible again outside a gesture: '${vs}' with ${pend} resume() pending (not rejected), as the spec says`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    st = '';
    for (let i = 0; i < 40 && st !== 'running'; i++) { st = await A(() => window.__audio.state()); if (st !== 'running') await sleep(50); }
    check(st === 'running', `the next tap after that resumes it: '${st}'`);

    // calibration: 94 dB = 1.0 through the limiter chain below threshold; the worst coincidence below full scale
    const lg = await A(() => window.__audio.limiterGain());
    const lgDb = Object.values(lg).map((x) => 20 * Math.log10(x));
    check(lgDb.every((d) => Math.abs(d) < 0.1), `mix chain below the limiter threshold is transparent: ${lgDb.map((d) => d.toFixed(2)).join(' / ')} dB at in 0.01 / 0.1 / 0.4`);
    const wp = await A(() => window.__audio.worstPeak());
    check(wp.peak < 1 && wp.samplesAtFullScale === 0, `worst coincidence (14 jetOn every 0.1 s, 4 × 20 N·s hits, engines lighting, q 30 kPa): peak ${wp.peak.toFixed(3)} (${(94 + 20 * Math.log10(wp.peak)).toFixed(1)} dB), ${wp.samplesAtFullScale} samples at full scale`);

    // costs
    for (let i = 0; i < 3; i++) {
      const bs = await A(() => window.__audio.bakeSlices(2));
      lines.push(`bake in 2 ms slices (fresh, run ${i + 1}): ${bs.totalMs.toFixed(0)} ms of work in ${bs.slices} slices; slice median ${bs.median.toFixed(2)} ms, p95 ${bs.p95.toFixed(2)}, max ${bs.max.toFixed(2)} ms, ${bs.over4} over 4 ms`);
    }
    const vc = [];
    for (let i = 0; i < 3; i++) vc.push(await A(() => window.__audio.voiceCost(40, 8000)));
    lines.push(`16-voice pool alone, 40 mug@deck hits/s with the Hertz low-pass, silent cabin: ${vc.map((x) => x.toFixed(2)).join(' / ')}% of a core (least ${Math.min(...vc).toFixed(2)}%)`);
    const b = await A(() => window.__audio.bench());
    lines.push(`main thread (Chromium x86): update ${b.contUs.toFixed(2)} µs/frame with 14 jets (PWM) + 2 engines + aero; ${b.burstUs.toFixed(1)} µs/frame with a burst of 20 impacts`);
    // the machine running this is shared: each cost is the least of three renders (noise only ever adds time)
    const best = async (parts) => { const r = []; for (let i = 0; i < 3; i++) r.push((await A(([s, p]) => window.__audio.audioThread(s, p), [10, parts])).cpuPct); return Math.min(...r); };
    const at = await best({});
    const cont = await best({ events: false });
    const typical = await best({ impactsPerKick: 0 });
    const idle = await best({ events: false, jets: false, engines: false, aero: false, fan: false, docked: false });
    lines.push(`audio render (Chromium x86, offline, 10 s, least of 3): idle graph ${idle.toFixed(2)}%; every continuous source at once (14 jets, 2 engines, aero, fan, hum) ${cont.toFixed(2)}%; ` +
      `plus a valve click every 0.1 s and a slide ${typical.toFixed(2)}%; plus 40 impacts/s more (extreme) ${at.toFixed(2)}% of a core`);
    const stats = await A(() => window.__audio.stats());
    lines.push(`engine stats: ${JSON.stringify(stats)}`);
  } catch (err) {
    fail.push(`exception: ${err && err.stack ? err.stack : err}`);
  } finally {
    await browser.close();
    await close();
  }
  const foreign = requests.filter((u) => !/\/frame\.html$/.test(u) && !/\/audio\.html(\?|$)/.test(u));
  check(foreign.length === 0, `network: ${requests.length} requests, all the test's own two pages${foreign.length ? `; foreign: ${foreign.join(', ')}` : ''}`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  for (const l of lines) console.log(`     ${l}`);
  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
  process.exit(fail.length ? 1 : 0);
}

run();
