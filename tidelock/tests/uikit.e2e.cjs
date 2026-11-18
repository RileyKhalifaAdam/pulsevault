#!/usr/bin/env node
// UI kit end-to-end check (Playwright, headless Chromium). Not a vitest file: run it directly after
// building the harness.
//
//   node build.mjs --harness uikit && node tests/uikit.e2e.cjs
//
// 1. Layout audit of every harness page in portrait and landscape: no page errors, no ellipsised
//    text, nothing sticking out of its panel or the viewport, every button at least 44 × 44 pt.
// 2. Behaviour on the components page: toggle, segmented control, tabs, chips, stepper (tap and
//    accelerating hold), slider drag, sortable table, help popover, modal, bottom sheet (drag to
//    dismiss), toasts, hold-to-confirm, comms paging and typed-on text.
//
// Exits 1 if anything fails.

const { launch, serveDist, waitReady } = require('../tools/pw.cjs');

const PAGES = ['components', 'market', 'market&mode=sell', 'mission', 'mission&sheet=0', 'faction', 'hudbits', 'icons', 'splash', 'splash&ready=1'];
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.error(`  FAIL ${msg}`);
};
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else fail(msg);
};

/** Runs in the page: returns layout problems as strings. */
function audit() {
  const out = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.querySelector('.tl-root');
  const label = (el) => `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]} "${(el.textContent || '').trim().slice(0, 28)}"`;
  const inScrollX = (el) => !!el.closest('.tl-scroll--x');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) out.push(`truncated: ${label(el)}`);
    if (el.tagName === 'BUTTON') {
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.push(`touch target ${r.width.toFixed(0)}×${r.height.toFixed(0)}: ${label(el)}`);
    }
  }
  // Nothing may stick out of its panel sideways (sideways scrollers excepted), or out of the viewport.
  for (const panel of root.querySelectorAll('.tl-panel, .tl-comms, .tl-sheet, .tl-modal, .tl-toast')) {
    const pr = panel.getBoundingClientRect();
    for (const el of panel.querySelectorAll('*')) {
      if (!visible(el) || inScrollX(el) || el.closest('svg') && el.tagName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push(`overflows panel by ${Math.max(r.right - pr.right, pr.left - r.left).toFixed(1)}px: ${label(el)}`);
    }
  }
  for (const el of root.querySelectorAll('.tl-header *, .tl-screen__foot *, .hx-hud > * *, .hx-hud > *, .tl-splash > *:not(canvas)')) {
    if (!visible(el) || inScrollX(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.left < -0.5 || r.bottom > vh + 0.5 || r.top < -0.5) out.push(`outside viewport: ${label(el)}`);
  }
  if (document.documentElement.scrollWidth > vw) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  return [...new Set(out)];
}

async function open(device, query, overrides = {}) {
  const ctx = await launch(device, { deviceScaleFactor: 1, ...overrides });
  await ctx.page.goto(`${open.base}/dev/uikit.html?page=${query}`);
  await waitReady(ctx.page);
  await ctx.page.waitForTimeout(350);
  return ctx;
}

const centre = async (page, selector, nth = 0) => {
  const box = await page.locator(selector).nth(nth).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
const tap = async (page, selector, nth = 0) => {
  await page.locator(selector).nth(nth).scrollIntoViewIfNeeded();
  const c = await centre(page, selector, nth);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(60);
};
const hold = async (page, selector, ms, nth = 0) => {
  await page.locator(selector).nth(nth).scrollIntoViewIfNeeded();
  const c = await centre(page, selector, nth);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(60);
};
const drag = async (page, from, to, steps = 8, stepMs = 16) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(stepMs);
  }
  await page.mouse.up();
};

(async () => {
  const server = await serveDist();
  open.base = server.baseUrl;

  // ---------------------------------------------------------------- 1. layout audit
  console.log('layout audit');
  for (const device of ['iphone15', 'iphone15l']) {
    for (const q of PAGES) {
      const { browser, page, errors } = await open(device, q);
      const problems = await page.evaluate(audit);
      // Long pages: audit again further down so every panel has been laid out on screen.
      const more = await page.evaluate(() => {
        const b = document.querySelector('.tl-screen__body.tl-scroll--y');
        if (!b) return false;
        b.scrollTop = b.scrollHeight;
        return true;
      });
      if (more) {
        await page.waitForTimeout(150);
        for (const p of await page.evaluate(audit)) if (!problems.includes(p)) problems.push(p);
      }
      ok(errors.length === 0 && problems.length === 0, `${device} ${q}`);
      for (const e of errors) console.error(`       ${e}`);
      for (const p of problems) console.error(`       ${p}`);
      await browser.close();
    }
  }

  // ---------------------------------------------------------------- 2. behaviour
  console.log('behaviour');
  {
    const { browser, page, errors } = await open('iphone15', 'components');
    const attr = (sel, name, nth = 0) => page.locator(sel).nth(nth).getAttribute(name);
    const text = (sel, nth = 0) => page.locator(sel).nth(nth).innerText();

    await tap(page, '.tl-toggle', 2);
    ok((await attr('.tl-toggle', 'aria-checked', 2)) === 'true', 'toggle flips on tap');

    await tap(page, '.tl-seg >> nth=0 >> .tl-seg__item', 1);
    ok((await attr('.tl-seg >> nth=0 >> .tl-seg__item', 'aria-pressed', 1)) === 'true' && (await attr('.tl-seg >> nth=0 >> .tl-seg__item', 'aria-pressed', 0)) === 'false', 'segmented control moves selection');

    await tap(page, '.tl-tab', 1);
    ok((await attr('.tl-tab', 'aria-selected', 1)) === 'true', 'tab selects');

    await tap(page, '.tl-chip', 1);
    const chipOn = await attr('.tl-chip', 'aria-pressed', 1);
    await tap(page, '.tl-chip', 1);
    ok(chipOn === 'true' && (await attr('.tl-chip', 'aria-pressed', 1)) === 'false', 'chip selects, second tap clears');

    const stepVal = async () => Number((await text('.tl-stepper__value .tl-num')).replace(/,/g, ''));
    const v0 = await stepVal();
    await tap(page, '.tl-stepper__btn', 1);
    const v1 = await stepVal();
    await hold(page, '.tl-stepper__btn', 1500, 0);
    const v2 = await stepVal();
    await hold(page, '.tl-stepper__btn', 2600, 1);
    const v3 = await stepVal();
    ok(v1 === v0 + 1, `stepper +1 on tap (${v0} -> ${v1})`);
    ok(v2 === 0, `stepper hold repeats down to the minimum (${v1} -> ${v2})`);
    ok(v3 === 32 && (await page.locator('.tl-stepper__btn').nth(1).isDisabled()), `stepper hold accelerates up to the maximum and disables + (${v3})`);

    await page.locator('.tl-slider__zone').first().scrollIntoViewIfNeeded();
    const zone = (await centre(page, '.tl-slider__zone')).box;
    await drag(page, { x: zone.x + zone.width * 0.64, y: zone.y + 22 }, { x: zone.x + zone.width * 0.25, y: zone.y + 22 });
    const slider = Number(await attr('.tl-slider__zone', 'aria-valuenow'));
    ok(Math.abs(slider - 25) <= 1, `slider follows a drag (${slider})`);

    const firstRow = () => text('.tl-tr >> nth=0 >> .tl-cell-main__title');
    const before = await firstRow();
    await tap(page, '.tl-th--sortable', 2);
    const sortA = await attr('.tl-th--sortable', 'aria-sort', 2);
    const afterA = await firstRow();
    await tap(page, '.tl-th--sortable', 2);
    const afterB = await firstRow();
    ok(sortA === 'descending' && afterA !== afterB, `table sorts by a tapped column and flips (${before} / ${afterA} / ${afterB})`);

    await tap(page, '.tl-help');
    const pop = await page.locator('.tl-pop').boundingBox();
    ok(!!pop && pop.x >= 0 && pop.x + pop.width <= 393 && pop.y >= 59 && pop.y + pop.height <= 852 - 34, 'help popover opens inside the safe area');
    await page.mouse.click(196, 120);
    await page.waitForTimeout(80);
    ok((await page.locator('.tl-pop').count()) === 0, 'help popover closes on an outside tap');

    await tap(page, 'button:has-text("Modal")');
    await page.waitForTimeout(350);
    ok((await page.locator('.tl-modal.tl-modal--in').count()) === 1, 'modal opens');
    const modalProblems = await page.evaluate(audit);
    ok(modalProblems.length === 0, `modal lays out cleanly ${modalProblems.join('; ')}`);
    await page.mouse.click(196, 90);
    await page.waitForTimeout(500);
    ok((await page.locator('.tl-modal').count()) === 0, 'modal closes on a scrim tap and unmounts');

    await tap(page, 'button:has-text("Sheet")');
    await page.waitForTimeout(400);
    ok((await page.locator('.tl-sheet.tl-sheet--in').count()) === 1, 'bottom sheet opens');
    const sheetProblems = await page.evaluate(audit);
    ok(sheetProblems.length === 0, `sheet lays out cleanly ${sheetProblems.join('; ')}`);
    const scrolled = await page.evaluate(() => {
      const b = document.querySelector('.tl-sheet__body');
      b.scrollTop = 60;
      return b.scrollHeight > b.clientHeight ? b.scrollTop > 0 : true;
    });
    ok(scrolled, 'sheet body scrolls');
    const grab = await centre(page, '.tl-sheet__grab');
    await drag(page, grab, { x: grab.x, y: grab.y + 60 }, 6, 60);
    await page.waitForTimeout(350);
    ok((await page.locator('.tl-sheet.tl-sheet--in').count()) === 1, 'a short drag springs the sheet back');
    await drag(page, grab, { x: grab.x, y: grab.y + 420 }, 10);
    await page.waitForTimeout(500);
    ok((await page.locator('.tl-sheet').count()) === 0, 'dragging the sheet down dismisses it');

    await tap(page, 'button:has-text("Toast")');
    await page.waitForTimeout(300);
    const toasts = await page.locator('.tl-toast').count();
    await tap(page, '.tl-toast', 0);
    await page.waitForTimeout(400);
    ok(toasts === 2 && (await page.locator('.tl-toast').count()) === 1, 'toasts stack and dismiss on tap');
    await tap(page, '.tl-toast', 0);
    await page.waitForTimeout(400);

    await hold(page, '.tl-hold', 250);
    await page.waitForTimeout(150);
    const early = await page.locator('.tl-toast').count();
    await hold(page, '.tl-hold', 1200);
    await page.waitForTimeout(200);
    ok(early === 0 && (await page.locator('.tl-toast:has-text("Cargo jettisoned")').count()) === 1, 'hold-to-confirm ignores a short press and fires after a full hold');

    const count0 = await text('.tl-comms__count');
    await tap(page, '.tl-comms .tl-btn');
    await page.waitForTimeout(80);
    await tap(page, '.tl-comms .tl-btn');
    ok(count0 === '1/2' && (await text('.tl-comms__count')) === '2/2', 'comms message pages forward');

    ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
    await browser.close();
  }
  {
    // Programmatic pieces, driven through window.__kit.
    const { browser, page, errors } = await open('iphone15', 'components');
    const swap = await page.evaluate(async () => {
      const k = window.__kit;
      const host = k.h('div', { style: 'position:absolute;inset:0;z-index:80' });
      document.querySelector('.tl-root').appendChild(host);
      const a = k.Screen({ header: k.ScreenHeader({ title: 'First' }), body: 'a' });
      const b = k.Screen({ header: k.ScreenHeader({ title: 'Second', onBack: () => {} }), body: 'b' });
      await k.swapScreen(host, a.el, 'fade');
      const one = host.children.length === 1 && host.firstElementChild === a.el;
      await k.swapScreen(host, b.el, 'push');
      const two = host.children.length === 1 && host.firstElementChild === b.el && getComputedStyle(b.el).opacity === '1';
      host.remove();
      return one && two;
    });
    ok(swap, 'swapScreen replaces the current screen (leave, then enter)');

    const tween = await page.evaluate(async () => {
      const k = window.__kit;
      const header = k.ScreenHeader({ title: 'T', credits: 1000 });
      document.querySelector('.tl-root').appendChild(header.el);
      const read = () => header.el.querySelector('.tl-header__readout--credits .tl-num').textContent;
      const start = read();
      header.update({ credits: 48250 });
      await new Promise((r) => setTimeout(r, 150));
      const mid = read();
      await new Promise((r) => setTimeout(r, 600));
      const end = read();
      header.destroy();
      return { start, mid, end };
    });
    ok(tween.start === '1,000' && tween.end === '48,250' && tween.mid !== tween.start && tween.mid !== tween.end, `header credits count to the new balance (${tween.start} -> ${tween.mid} -> ${tween.end})`);

    const answer = page.evaluate(() => window.__kit.confirmDialog({ title: 'Sell the Wren?', message: 'This cannot be undone.', confirmLabel: 'Sell', danger: true }));
    await page.waitForTimeout(350);
    await tap(page, '.tl-modal .tl-btn:has-text("Sell")');
    ok((await answer) === true, 'confirmDialog resolves true on the confirming action');
    const refusal = page.evaluate(() => window.__kit.confirmDialog({ title: 'Jump now?' }));
    await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    ok((await refusal) === false, 'confirmDialog resolves false on Escape');

    const live = await page.evaluate(() => {
      const k = window.__kit;
      const g = k.Gauge({ kind: 'radial', value: 10, max: 100, text: '10', live: true });
      const s = k.Sparkline({ values: [1, 2, 3] });
      const kv = k.KeyValue({ items: [{ k: 'Speed', v: '1' }] });
      g.update({ value: 80, text: '80' });
      s.update({ values: [3, 2, 1] });
      kv.set(0, '7.61');
      const res = g.el.getAttribute('aria-valuenow') === '80' && g.el.textContent.includes('80') && s.el.getAttribute('aria-label') === 'Trend falling' && kv.el.textContent.includes('7.61');
      g.destroy(); s.destroy(); kv.destroy();
      return res;
    });
    ok(live, 'gauge, sparkline and key/value update in place');
    ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
    await browser.close();
  }
  {
    // Typed-on text grows over time and finishes.
    const { browser, page } = await open('iphone15', 'hudbits&anim=1');
    const typed = () => page.evaluate(() => document.querySelector('.tl-comms__text').firstChild.data.length);
    const a = await typed();
    await page.waitForTimeout(400);
    const b = await typed();
    await page.waitForTimeout(2500);
    const done = await page.locator('.tl-comms.tl-comms--done').count();
    ok(b > a && done === 1, `comms text types on (${a} -> ${b} chars) and completes`);
    await browser.close();
  }
  {
    // Landscape: the sheet becomes a side sheet and dismisses with a sideways drag.
    const { browser, page } = await open('iphone15l', 'mission');
    await page.waitForTimeout(300);
    const box = await page.locator('.tl-sheet').boundingBox();
    ok(!!box && box.x > 300 && Math.abs(box.x + box.width - 852) < 1 && box.height === 393, 'landscape: sheet docks to the right edge');
    const head = await centre(page, '.tl-sheet__title');
    await drag(page, head, { x: head.x + 380, y: head.y }, 10);
    await page.waitForTimeout(500);
    ok((await page.locator('.tl-sheet').count()) === 0, 'landscape: dragging the sheet right dismisses it');
    await browser.close();
  }
  {
    // Reduced motion: overlays still open and close (transitions collapse to 1 ms).
    const { browser, page } = await open('iphone15', 'components&overlay=modal', { reducedMotion: 'reduce' });
    ok((await page.locator('.tl-modal.tl-modal--in').count()) === 1, 'reduced motion: modal opens');
    await page.mouse.click(196, 90);
    await page.waitForTimeout(200);
    ok((await page.locator('.tl-modal').count()) === 0, 'reduced motion: modal closes');
    await browser.close();
  }

  await server.close();
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
