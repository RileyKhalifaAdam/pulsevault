// Perf overlay: a small read-out in a top corner (toggle: pause menu, or a three-finger tap) with a
// "Copy performance report" button — the owner's phone is the only real test device.
import type { UiHost } from './host';
import { h, onTap } from './kit';
import { renderInfo, rtInfoText } from '../app/perf';

const CSS = `
.pf{position:absolute;z-index:60;right:max(8px,env(safe-area-inset-right,0px));top:calc(var(--pf-top,206px) + env(safe-area-inset-top,0px));width:184px;pointer-events:none;
 font:10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfe9f2;background:rgba(5,8,12,.78);border:1px solid rgba(111,227,255,.3);border-radius:4px;padding:6px 8px;-webkit-user-select:none;user-select:none}
.pf[hidden]{display:none}
.pf b{color:#fff;font-weight:600}
.pf .pf-bad{color:#ff8a7d}
.pf .pf-ok{color:#8fe3a5}
.pf pre{margin:0;font:inherit;white-space:pre-wrap}
.pf button{pointer-events:auto;display:block;width:100%;min-height:44px;margin-top:6px;font:600 10px/1.2 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#6fe3ff;border:1px solid rgba(111,227,255,.45);border-radius:3px;background:rgba(111,227,255,.08)}
.pf button.tl-pressed{background:rgba(111,227,255,.25)}
.pf textarea{pointer-events:auto;display:block;width:100%;height:90px;margin-top:6px;font:16px/1.2 ui-monospace,Menlo,monospace;color:#fff;background:#000;border:1px solid #456;-webkit-user-select:text;user-select:text;box-sizing:border-box}
@media (orientation:landscape){.pf{--pf-top:138px;right:auto;left:calc(50% - 92px)}}
`;

export interface PerfOverlay {
  el: HTMLElement;
  visible(): boolean;
  setVisible(on: boolean): void;
  update(dt: number): void;
}

export function createPerfOverlay(host: UiHost, extra: () => string[]): PerfOverlay {
  if (!document.getElementById('tl-pf-css')) {
    const s = document.createElement('style');
    s.id = 'tl-pf-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const l1 = h('div');
  const body = h('pre');
  const btn = h('button', { attrs: { type: 'button' }, text: 'Copy performance report' });
  const el = h('div.pf', { attrs: { 'data-perf': '1' } }, l1, body, btn);
  el.hidden = true;
  host.root.appendChild(el);
  let area: HTMLTextAreaElement | null = null;
  const fallback = (text: string): void => {
    if (!area) {
      area = document.createElement('textarea');
      area.readOnly = true;
      el.appendChild(area);
    }
    area.value = text;
    area.focus();
    area.select();
    btn.textContent = 'Select all and copy';
  };
  onTap(btn, () => {
    const text = host.perf.report(extra());
    let done = false;
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) {
        done = true;
        p.then(() => {
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = 'Copy performance report'), 1600);
        }, () => fallback(text));
      }
    } catch {
      done = false;
    }
    if (!done) fallback(text);
  });
  let acc = 1;
  return {
    el,
    visible: () => !el.hidden,
    setVisible(on) {
      el.hidden = !on;
      acc = 1;
      if (!on && area) {
        area.remove();
        area = null;
        btn.textContent = 'Copy performance report';
      }
    },
    update(dt) {
      if (el.hidden) return;
      acc += dt;
      if (acc < 0.5) return;
      acc = 0;
      const s = host.perf.snapshot();
      const cls = s.frameP95 > 34 ? 'pf-bad' : s.frameP95 < 20 ? 'pf-ok' : '';
      l1.innerHTML = `<b class="${cls}">${s.fps.toFixed(0)} fps</b> · ${s.tier} · ×${s.scale.toFixed(2)}`;
      body.textContent =
        `frame  ${s.frameMean.toFixed(1)} ms (p95 ${s.frameP95.toFixed(1)}, target ${s.target.toFixed(1)})\n` +
        `sim    ${s.simMean.toFixed(2)} ms · ${s.unitsMean.toFixed(0)} units\n` +
        `render ${s.renderMean.toFixed(1)} ms cpu\n` +
        `idle   ${s.idleMean.toFixed(1)} ms${s.gpuBound ? ' · GPU-bound' : ''}\n` +
        `steps ${s.steps.toFixed(1)} · draws ${s.drawCalls}\n` +
        `${rtInfoText()}\n` +
        `gpu mem ${(renderInfo.totalBytes / 1048576).toFixed(0)} MB · msaa ${renderInfo.msaa}x\n` +
        `(2 s means; ${s.samples} frames)`;
    },
  };
}
