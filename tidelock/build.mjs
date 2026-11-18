// TIDELOCK build script (esbuild).
//
//   node build.mjs                    -> dist/index.html + dist/game.js (+ static files from web/)
//   node build.mjs --single           -> also writes dist/tidelock.html (everything inlined, one file)
//   node build.mjs --harness <name>   -> bundles dev/harness/<name>.ts to dist/dev/<name>.{js,html}
//   node build.mjs --serve [port]     -> build, then serve dist/ on http://localhost:<port> (default 8080)
//   node build.mjs --minify           -> minified production bundle
//   node build.mjs --artifact         -> also writes dist/tidelock-artifact.html: a self-contained FRAGMENT (no
//                                        doctype/html/head/body) for the Claude page viewer, which wraps it itself
//
// GLSL (*.glsl) and CSS (*.css) files import as strings.

import { build } from 'esbuild';
import { createServer } from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const common = {
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  loader: { '.glsl': 'text', '.css': 'text', '.svg': 'text' },
  logLevel: 'warning',
  define: { __DEV__: JSON.stringify(!has('--minify')) },
};

async function copyDir(src, dst) {
  if (!existsSync(src)) return;
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function buildGame() {
  await fs.mkdir(dist, { recursive: true });
  const entry = path.join(root, 'src/main.ts');
  if (!existsSync(entry)) {
    console.warn('src/main.ts does not exist yet — skipping the game bundle.');
    return;
  }
  await build({
    ...common,
    entryPoints: [entry],
    outfile: path.join(dist, 'game.js'),
    sourcemap: has('--minify') ? false : 'linked',
    minify: has('--minify') || has('--single'),
  });
  await copyDir(path.join(root, 'web'), dist);
  // Stamp the service-worker cache name so updates invalidate old caches.
  const sw = path.join(dist, 'sw.js');
  if (existsSync(sw)) {
    const stamp = Date.now().toString(36);
    await fs.writeFile(sw, (await fs.readFile(sw, 'utf8')).replaceAll('__BUILD_STAMP__', stamp));
  }
  if (has('--single')) {
    const html = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
    const js = await fs.readFile(path.join(dist, 'game.js'), 'utf8');
    const inlined = html
      .replace(/<script type="module" src="\.?\/?game\.js"><\/script>/, () => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script>`)
      .replace(/<link rel="manifest"[^>]*>\s*/g, '');
    await fs.writeFile(path.join(dist, 'tidelock.html'), inlined);
    console.log(`single-file build: dist/tidelock.html (${(inlined.length / 1024).toFixed(0)} KiB)`);
  }
  const size = (await fs.stat(path.join(dist, 'game.js'))).size;
  console.log(`built dist/game.js (${(size / 1024).toFixed(0)} KiB)`);
}

// The page the owner actually plays: one fragment, everything inline, no requests, no service worker.
// The host wraps it in its own <html>/<head>/<body> (and pads :root by the top/bottom safe areas), so this
// file must not carry those tags; the canvas and UI root are position:fixed and handle their own insets.
async function buildArtifact() {
  const res = await build({
    ...common,
    format: 'iife',
    entryPoints: [path.join(root, 'src/main.ts')],
    write: false,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    define: { __DEV__: 'false' },
  });
  let js = res.outputFiles[0].text;
  if (js.includes('<!--')) console.warn('warning: the bundle contains "<!--"; check the inline script still parses');
  js = js.replace(/<\/(script)/gi, '<\\/$1');
  const css = [
    'html,body{height:100%}',
    'html{box-sizing:border-box;overflow:hidden}',
    'body{margin:0;background:#05070B;color-scheme:dark;overflow:hidden;position:relative;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:none;-webkit-text-size-adjust:100%}',
    '#boot{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#8fa3b8;font:500 12px/1.6 -apple-system,"SF Pro Text",system-ui,sans-serif;letter-spacing:.32em;text-transform:uppercase}',
  ].join('\n');
  // Last-resort message if the game throws before its own error panel is up (same script, runs first).
  const guard = "window.addEventListener('error',function(e){if(window.__tlErr)return;var b=document.getElementById('boot');if(b){b.style.letterSpacing='0';b.style.textTransform='none';b.style.color='#FF5A4D';b.textContent='TIDELOCK could not start: '+(e&&e.message?e.message:'script error');}});";
  const frag = [
    '<title>TIDELOCK</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>\n${css}\n</style>`,
    '<div id="boot">Tidelock</div>',
    `<script>${guard}\n${js}</script>`,
    '',
  ].join('\n');
  const out = path.join(dist, 'tidelock-artifact.html');
  await fs.writeFile(out, frag);
  const bytes = Buffer.byteLength(frag);
  if (bytes > 16 * 1024 * 1024) throw new Error(`artifact is ${bytes} bytes: over the 16 MB limit`);
  console.log(`artifact fragment: dist/tidelock-artifact.html (${(bytes / 1024).toFixed(0)} KiB)`);
}

async function buildHarness(name) {
  const entry = path.join(root, 'dev/harness', `${name}.ts`);
  if (!existsSync(entry)) throw new Error(`no such harness: ${entry}`);
  const outDir = path.join(dist, 'dev');
  await fs.mkdir(outDir, { recursive: true });
  await build({ ...common, entryPoints: [entry], outfile: path.join(outDir, `${name}.js`), sourcemap: 'inline' });
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>harness: ${name}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;color:#cfe;font:12px -apple-system,system-ui,sans-serif}canvas{display:block}</style>
</head><body><script type="module" src="./${name}.js"></script></body></html>`;
  await fs.writeFile(path.join(outDir, `${name}.html`), html);
  console.log(`built harness dist/dev/${name}.html`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
};

function serve(port) {
  createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(dist, path.normalize(p));
      if (!file.startsWith(dist)) throw new Error('bad path');
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }).listen(port, () => console.log(`serving dist/ on http://localhost:${port}`));
}

const harness = valueOf('--harness');
if (harness) await buildHarness(harness);
else await buildGame();
if (!harness && has('--artifact')) await buildArtifact();
if (has('--serve')) serve(Number(valueOf('--serve') ?? 8080));
