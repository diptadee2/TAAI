/**
 * Pre-compiles JSX in HTML files so the browser ships plain JS.
 * Removes Babel standalone; swaps CDN React/ReactDOM for local vendor files.
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

const PAGES = ['index.html', 'courses.html', 'test-series.html', 'testimonials.html', 'contact.html', 'resources.html'];


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

  // 4. Remove Babel standalone <script> tag entirely
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/@babel\/standalone[^>]*><\/script>\s*/i,
    ''
  );

  // 5. Replace CDN React/ReactDOM with local vendor files
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/react@[^/]+\/umd\/react\.[^"]*"[^>]*><\/script>/i,
    '<script src="vendor/react.min.js"></script>'
  );
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/react-dom@[^/]+\/umd\/react-dom\.[^"]*"[^>]*><\/script>/i,
    '<script src="vendor/react-dom.min.js"></script>'
  );

  fs.writeFileSync(path.join(DIST, filename), out);
  console.log(`  ✓ ${filename}`);
}

// ── Notes data generator ──────────────────────────────────────────
const SUBJECT_META = {
  'linear-algebra':   { name: 'Linear Algebra',          accent: 'linear-gradient(135deg,#8B5CF6,#4D8BFF)', color: '#8B5CF6' },
  'probability':      { name: 'Probability',             accent: 'linear-gradient(135deg,#FF7FB7,#8B5CF6)', color: '#FF7FB7' },
  'statistics':       { name: 'Statistics',              accent: 'linear-gradient(135deg,#4D8BFF,#06b6d4)', color: '#4D8BFF' },
  'calculus':         { name: 'Calculus',                accent: 'linear-gradient(135deg,#f59e0b,#ef4444)', color: '#f59e0b' },
  'machine-learning': { name: 'Machine Learning',        accent: 'linear-gradient(135deg,#8B5CF6,#ec4899)', color: '#8B5CF6' },
  'ai':               { name: 'Artificial Intelligence', accent: 'linear-gradient(135deg,#06b6d4,#4D8BFF)', color: '#06b6d4' },
  'python':           { name: 'Python',                  accent: 'linear-gradient(135deg,#10b981,#06b6d4)', color: '#10b981' },
  'data-structures':  { name: 'Data Structures',         accent: 'linear-gradient(135deg,#4D8BFF,#8B5CF6)', color: '#4D8BFF' },
  'algorithms':       { name: 'Algorithms',               accent: 'linear-gradient(135deg,#f97316,#FF7FB7)', color: '#f97316' },
  'dbms':             { name: 'DBMS',                    accent: 'linear-gradient(135deg,#f97316,#ef4444)', color: '#f97316' },
};

function toTitle(filename) {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function generateNotesData() {
  const notesDir = path.join(SRC, 'notes');
  const subjects = Object.entries(SUBJECT_META).map(([id, meta]) => {
    const folder = path.join(notesDir, id);
    const notes = fs.existsSync(folder)
      ? fs.readdirSync(folder)
          .filter(f => f.toLowerCase().endsWith('.pdf'))
          .map(f => ({ title: toTitle(f), file: `notes/${id}/${f}` }))
      : [];
    return { id, ...meta, notes };
  });
  const json = JSON.stringify({ subjects }, null, 2);
  fs.writeFileSync(path.join(DIST, 'notes-data.json'), json);
  console.log('  ✓ notes-data.json');
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
  generateNotesData();
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
