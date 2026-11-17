// Shared Playwright helpers for screenshots and end-to-end tests.
// CommonJS on purpose: the pre-installed `playwright` resolves through `require` from any directory.
//
//   const { launch, serveDist, DEVICES } = require('./pw.cjs');
//   const { baseUrl, close } = await serveDist();          // static server for dist/ on a free port
//   const { browser, page } = await launch('iphone15');     // WebGL2-capable headless Chromium
//
// Headless rendering uses SwiftShader (software GL): correct but slow, so prefer deviceScaleFactor 1 for
// checks and 2 for screenshots a person will look at.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// CSS viewport sizes. iPhone 15: 393x852 pt @3x. Safari chrome eats some height; these are full-screen (PWA) sizes.
const DEVICES = {
  iphone15: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA },
  iphone15l: { viewport: { width: 852, height: 393 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA },
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};

const GL_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--autoplay-policy=no-user-gesture-required',
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/** Serve dist/ on an ephemeral port (safe when several agents test at once). */
function serveDist(dir = DIST) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(dir, path.normalize(p));
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/**
 * Launch headless Chromium with WebGL2 and open a page emulating `device`.
 * Console errors and page errors are collected in `errors` (array of strings).
 */
async function launch(device = 'iphone15', overrides = {}) {
  const browser = await chromium.launch({ args: GL_ARGS });
  const context = await browser.newContext({ ...(DEVICES[device] || DEVICES.iphone15), ...overrides });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return { browser, context, page, errors };
}

/** Wait until `window.__ready` is truthy (harnesses and the game set it once the first frame is drawn). */
async function waitReady(page, timeout = 60000) {
  await page.waitForFunction(() => window.__ready === true, null, { timeout });
}

module.exports = { launch, serveDist, waitReady, DEVICES, GL_ARGS, ROOT, DIST };
