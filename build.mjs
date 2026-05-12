/**
 * Pre-compiles JSX in HTML files so the browser ships plain JS.
 * Removes babel standalone + swaps dev React for production builds.
 *
 * Usage:
 *   node build.mjs          → writes compiled files to dist/
 *   node build.mjs --watch  → rebuilds on file change
 */

import { transformSync } from '@babel/core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC   = __dir;
const DIST  = path.join(__dir, 'dist');

const PAGES = ['index.html', 'courses.html', 'test-series.html', 'testimonials.html', 'contact.html'];

// Swap CDN URLs: dev → production, remove Babel standalone
const CDN_SWAPS = [
  // React dev → prod
  [
    'https://unpkg.com/react@18.3.1/umd/react.development.js',
    'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  ],
  // ReactDOM dev → prod
  [
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js',
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  ],
];

function compilePage(filename) {
  const src  = fs.readFileSync(path.join(SRC, filename), 'utf8');

  // 1. Extract the <script type="text/babel"> block
  const babelRe = /<script\s+type="text\/babel"[^>]*>([\s\S]*?)<\/script>/i;
  const match   = src.match(babelRe);
  if (!match) {
    console.log(`  ${filename} — no babel block, copying as-is`);
    fs.writeFileSync(path.join(DIST, filename), src);
    return;
  }

  const jsxSource = match[1];

  // 2. Compile JSX → plain JS
  const { code } = transformSync(jsxSource, {
    presets: ['@babel/preset-react'],
    filename,
    sourceMaps: false,
    compact: false,
  });

  // 3. Replace <script type="text/babel"…> with <script>
  let out = src.replace(babelRe, `<script>\n${code}\n</script>`);

  // 4. Remove the Babel standalone <script> tag entirely
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/@babel\/standalone[^>]*><\/script>\s*/i,
    ''
  );

  // 5. Swap dev React builds for production builds
  for (const [from, to] of CDN_SWAPS) {
    out = out.split(from).join(to);
  }

  fs.writeFileSync(path.join(DIST, filename), out);
  console.log(`  ✓ ${filename}`);
}

function build() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST);

  // Copy static assets (images, etc.) — skip dist/ and node_modules/
  const SKIP_DIRS = new Set(['dist', 'node_modules', '.git']);
  for (const entry of fs.readdirSync(SRC)) {
    if (PAGES.includes(entry)) continue;
    if (SKIP_DIRS.has(entry)) continue;
    const stat = fs.statSync(path.join(SRC, entry));
    if (stat.isDirectory()) {
      fs.cpSync(path.join(SRC, entry), path.join(DIST, entry), { recursive: true });
    } else {
      fs.copyFileSync(path.join(SRC, entry), path.join(DIST, entry));
    }
  }

  console.log('Building…');
  for (const page of PAGES) {
    if (fs.existsSync(path.join(SRC, page))) compilePage(page);
  }
  console.log('Done → dist/');
}

build();

// --watch mode
if (process.argv.includes('--watch')) {
  console.log('Watching for changes…');
  for (const page of PAGES) {
    const full = path.join(SRC, page);
    if (!fs.existsSync(full)) continue;
    fs.watch(full, () => {
      console.log(`\n${page} changed, rebuilding…`);
      try { compilePage(page); } catch (e) { console.error(e.message); }
    });
  }
}
