// Global failure panel (CLAUDE.md "Visible failures"): nobody can open a console on the owner's phone, so every
// uncaught error and unhandled rejection shows here with a Copy report and a Reload button. No dependencies:
// this module must work even when everything else is broken. Importing it installs the listeners.

const notes: string[] = [];
let panel: HTMLElement | null = null;
let pre: HTMLElement | null = null;
let count = 0;

/** Add a line of context to future reports (build, quality, last screen...). */
export function noteForReport(line: string): void {
  notes.push(line);
  if (notes.length > 40) notes.shift();
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? '(no stack)'}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

function header(): string {
  let size = '';
  try {
    size = `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`;
  } catch {
    /* ignore */
  }
  return `TIDELOCK error report\n${navigator.userAgent}\nview ${size}\n${notes.join('\n')}`;
}

function button(label: string, primary: boolean, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText =
    `flex:1 1 0;min-height:48px;padding:0 12px;border-radius:4px;font:600 13px/1 -apple-system,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;` +
    (primary ? 'background:#FFB454;color:#0b0d10;border:1px solid #FFB454;' : 'background:transparent;color:#e8eef5;border:1px solid rgba(255,255,255,.32);');
  b.addEventListener('click', fn);
  return b;
}

function selectText(el: HTMLElement): void {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  } catch {
    /* ignore */
  }
}

/** Show the failure panel (or add to it). Safe to call at any time, with anything. */
export function showFatal(err: unknown, where = ''): void {
  try {
    count++;
    const text = `${where ? `[${where}] ` : ''}${describe(err)}`;
    try {
      console.error(err);
    } catch {
      /* ignore */
    }
    if (panel && pre) {
      if (count <= 8) pre.textContent += `\n\n---- #${count}\n${text}`;
      return;
    }
    panel = document.createElement('div');
    panel.id = 'tl-error';
    panel.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;' +
      'padding:calc(16px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) calc(16px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));' +
      'background:rgba(5,7,11,.96);color:#e8eef5;font:400 14px/1.45 -apple-system,system-ui,sans-serif;touch-action:auto;';
    const title = document.createElement('div');
    title.textContent = 'Something went wrong';
    title.style.cssText = 'font:600 17px/1.2 -apple-system,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#FF5A4D;';
    const hint = document.createElement('div');
    hint.textContent = 'Tap "Copy report" and paste it to the developer. Your last docking is saved.';
    hint.style.cssText = 'color:#8fa3b8;';
    pre = document.createElement('pre');
    pre.textContent = `${header()}\n\n---- #1\n${text}`;
    pre.style.cssText =
      'flex:1 1 auto;min-height:0;margin:0;padding:10px;overflow:auto;-webkit-overflow-scrolling:touch;white-space:pre-wrap;word-break:break-word;' +
      'border:1px solid rgba(255,255,255,.16);border-radius:4px;background:#0a0e14;color:#c9d4df;font:12px/1.4 ui-monospace,Menlo,monospace;' +
      '-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;touch-action:pan-y;';
    const status = document.createElement('div');
    status.style.cssText = 'min-height:18px;color:#63E6A1;font-size:12px;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;flex:none;';
    const thePre = pre;
    row.append(
      button('Copy report', true, () => {
        const body = thePre.textContent ?? '';
        const fallback = (): void => {
          selectText(thePre);
          status.textContent = 'Could not copy automatically: the text is selected — use Copy from the menu.';
        };
        try {
          const p = navigator.clipboard?.writeText(body);
          if (p) p.then(() => (status.textContent = 'Report copied.'), fallback);
          else fallback();
        } catch {
          fallback();
        }
      }),
      button('Reload', false, () => {
        try {
          location.reload();
        } catch {
          status.textContent = 'Reload is blocked here: close and reopen the page.';
        }
      }),
      button('Dismiss', false, () => {
        panel?.remove();
        panel = null;
        pre = null;
      }),
    );
    panel.append(title, hint, pre, status, row);
    (document.body ?? document.documentElement).appendChild(panel);
  } catch {
    /* the panel itself must never throw */
  }
}

/** Plain full-screen explanation (no WebGL2, etc.). */
export function showPlainMessage(title: string, message: string): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;justify-content:center;gap:12px;box-sizing:border-box;padding:32px max(24px,env(safe-area-inset-left,0px));' +
    'background:#05070b;color:#e8eef5;font:400 15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;';
  const t = document.createElement('div');
  t.textContent = title;
  t.style.cssText = 'font-weight:600;font-size:17px;letter-spacing:.1em;text-transform:uppercase;color:#FFB454;';
  const m = document.createElement('div');
  m.textContent = message;
  m.style.color = '#8fa3b8';
  el.append(t, m);
  document.body.appendChild(el);
}

const BENIGN = /ResizeObserver loop/i;

let installed = false;
export function installErrorPanel(): void {
  if (installed) return;
  installed = true;
  (window as unknown as { __tlErr: boolean }).__tlErr = true;
  window.addEventListener('error', (e) => {
    if (BENIGN.test(e.message ?? '')) return;
    showFatal(e.error ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => showFatal(e.reason ?? 'unhandled rejection', 'promise'));
}

installErrorPanel();
