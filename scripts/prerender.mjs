// Saves a rendered copy of each React page into its built HTML (2026-10-24).
//
// Why: the main pages draw everything with React in the browser, so their
// HTML files are an empty <div id="root"></div>. AI crawlers (ChatGPT,
// Claude, Perplexity) mostly don't run JavaScript and saw ~10 words per
// page. This opens each built page in headless Chromium after `npm run
// build`, waits for it to finish drawing (live prices etc. come from the
// real taai.live API), and writes the drawn #root into dist/<page>.html.
// Visitors see no difference: React's createRoot() replaces the saved copy
// as soon as it runs.
//
// Never fails the deploy: any problem (no browser, a page error) is logged
// and that page, or every page, ships exactly as before.
//
//   node scripts/prerender.mjs        (Netlify runs it after npm run build)
//   PRERENDER_CHROME=/path/to/chrome node scripts/prerender.mjs   (local)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
// The progress tracker is left out: what it shows depends on who's signed in.
const PAGES = ['index.html', 'gate-da-courses.html', 'gate-da-test-series.html', 'gate-da-toppers.html', 'contact.html', 'gate-da-free-notes.html'];
const LIVE_API = 'https://taai.live';
const EMPTY_ROOT = '<div id="root"></div>';

// On Netlify, keep the browser inside node_modules so the build cache keeps it.
if (process.env.NETLIFY && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

function serveDist() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = path.join(DIST, p);
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return null; }
  const opts = process.env.PRERENDER_CHROME ? { executablePath: process.env.PRERENDER_CHROME } : {};
  try { return await chromium.launch(opts); } catch (e) {
    if (process.env.PRERENDER_CHROME) throw e;
    console.log('prerender: installing Chromium for the build');
    execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 240000 });
    return chromium.launch(opts);
  }
}

async function main() {
  const browser = await launch();
  if (!browser) { console.log('prerender: playwright not installed, skipped (pages ship as before)'); return; }
  const server = await serveDist();
  const base = 'http://127.0.0.1:' + server.address().port;
  let done = 0;
  try {
    for (const file of PAGES) {
      const target = path.join(DIST, file);
      const html = fs.readFileSync(target, 'utf8');
      if (!html.includes(EMPTY_ROOT)) { console.log('prerender: ' + file + ' has no empty root, skipped'); continue; }
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // Live data (prices, notes, testimonials) comes from the real site's public API.
      await ctx.route(base + '/api/**', async (route) => {
        try {
          const url = LIVE_API + route.request().url().slice(base.length);
          const r = await fetch(url, { method: route.request().method(), signal: AbortSignal.timeout(15000) });
          await route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' }, body: Buffer.from(await r.arrayBuffer()) });
        } catch { await route.abort(); }
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(base + '/' + file.replace(/\.html$/, '').replace(/^index$/, ''), { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(1500);
        const inner = await page.evaluate(() => {
          const root = document.getElementById('root');
          return root ? root.innerHTML : '';
        });
        const words = inner.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
        if (errors.length || words < 50) {
          console.log('prerender: ' + file + ' skipped (' + (errors[0] || words + ' words only') + ')');
        } else {
          fs.writeFileSync(target, html.replace(EMPTY_ROOT, '<div id="root">' + inner + '</div>'));
          done++;
          console.log('prerender: ' + file + ' saved (' + words + ' words)');
        }
      } catch (e) {
        console.log('prerender: ' + file + ' skipped (' + e.message.split('\n')[0] + ')');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('prerender: ' + done + ' of ' + PAGES.length + ' pages saved');
}

main().catch((e) => { console.log('prerender: skipped (' + e.message.split('\n')[0] + '), pages ship as before'); });
