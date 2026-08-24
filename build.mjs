/**
 * Pre-compiles JSX in HTML files so the browser ships plain JS.
 * Removes Babel standalone; swaps CDN React/ReactDOM for local vendor files.
 *
 * Usage:
 *   node build.mjs          → writes compiled files to dist/
 *   node build.mjs --watch  → rebuilds on file change
 */

import { transformSync } from '@babel/core';
import { marked } from 'marked';
import katex from 'katex';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SRC   = __dir;
const DIST  = path.join(__dir, 'dist');
const BLOG_CONTENT_DIR = path.join(__dir, 'content', 'blog');

const PAGES = ['index.html', 'gate-da-courses.html', 'gate-da-test-series.html', 'gate-da-toppers.html', 'contact.html', 'gate-da-free-notes.html', 'gate-da-progress-tracker.html'];
const SITE_URL = 'https://taai.live';


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

  // 3. Replace <script type="text/babel"…> with a plain <script>, but
  // with its body wrapped in a DOMContentLoaded listener rather than run
  // immediately. This has to happen because step 5 below defers the
  // React/ReactDOM vendor scripts, and `defer` has NO EFFECT on inline
  // scripts (only ones with a src attribute) per the HTML spec — a plain
  // inline script always runs the instant the parser reaches it,
  // regardless of a defer attribute on the tag. Without this wrapper the
  // compiled app code would run before the deferred React/ReactDOM
  // scripts had actually executed, throwing "React is not defined".
  // DOMContentLoaded fires only after every deferred script has run, so
  // wrapping in that guarantees the same effective ordering `defer` would
  // have given an external script.
  let out = src.replace(babelRe, `<script>\ndocument.addEventListener('DOMContentLoaded', function () {\n${code}\n});\n</script>`);

  // 4. Remove Babel standalone <script> tag entirely
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/@babel\/standalone[^>]*><\/script>\s*/i,
    ''
  );

  // 5. Replace CDN React/ReactDOM with local vendor files, deferred so
  // they don't block initial render (see the comment on step 3 above for
  // why the compiled app script also has to be deferred for this to be
  // safe).
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/react@[^/]+\/umd\/react\.[^"]*"[^>]*><\/script>/i,
    '<script defer src="vendor/react.min.js"></script>'
  );
  out = out.replace(
    /<script\s[^>]*unpkg\.com\/react-dom@[^/]+\/umd\/react-dom\.[^"]*"[^>]*><\/script>/i,
    '<script defer src="vendor/react-dom.min.js"></script>'
  );

  fs.writeFileSync(path.join(DIST, filename), out);
  console.log(`  ✓ ${filename}`);
}

// ── Notes data generator ──────────────────────────────────────────
const SUBJECT_META = {
  'linear-algebra':   { name: 'Linear Algebra',          accent: 'linear-gradient(135deg,#8B5CF6,#4D8BFF)', color: '#8B5CF6' },
  'probability':      { name: 'Probability',             accent: 'linear-gradient(135deg,#FF7FB7,#8B5CF6)', color: '#FF7FB7' },
  'statistics':       { name: 'Statistics',              accent: 'linear-gradient(135deg,#4D8BFF,#06b6d4)', color: '#4D8BFF' },
  'machine-learning': { name: 'Machine Learning',        accent: 'linear-gradient(135deg,#8B5CF6,#ec4899)', color: '#8B5CF6' },
  'calculus':         { name: 'Calculus',                accent: 'linear-gradient(135deg,#f59e0b,#ef4444)', color: '#f59e0b' },
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

// ── Blog generator ────────────────────────────────────────────────
// Reads Markdown posts from content/blog/, written via Decap CMS (/admin),
// and renders them as static pages matching the rest of the site's design.

const BLOG_NAV_LINKS = [
  { label: 'Courses', href: '/gate-da-courses' },
  { label: 'Test Series 2027', href: '/gate-da-test-series' },
  { label: 'Testimonials', href: '/gate-da-toppers' },
  { label: 'Resources', href: '/gate-da-free-notes' }, // renders as dropdown — see renderNav()
];

const BLOG_MENU_ICONS = {
  '/': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M3 12L12 4L21 12V20C21 20.6 20.6 21 20 21H15V16H9V21H4C3.4 21 3 20.6 3 20V12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>',
  '/gate-da-courses': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 5C4 4 4.5 3 6 3H11V20H6C4.5 20 4 19 4 18V5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /><path d="M20 5C20 4 19.5 3 18 3H13V20H18C19.5 20 20 19 20 18V5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>',
  '/gate-da-test-series': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.7" /><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.7" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></svg>',
  '/gate-da-toppers': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="9" r="3" stroke="currentColor" stroke-width="1.7" /><circle cx="16" cy="9" r="3" stroke="currentColor" stroke-width="1.7" /><path d="M3 19C3 16 5 14 8 14C11 14 13 16 13 19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M13 19C13 16 15 14 18 14C19 14 20 14.3 21 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>',
  '/gate-da-free-notes': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C5.4 2 5 2.4 5 3V21C5 21.6 5.4 22 6 22H18C18.6 22 19 21.6 19 21V7L14 2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /><path d="M14 2V7H19" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /><path d="M9 13H15M9 17H13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>',
  '/blogs': '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 20h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" /></svg>',
};

const TAG_LABELS = {
  'linear-algebra': 'Linear Algebra', 'probability': 'Probability',
  'statistics': 'Statistics', 'calculus': 'Calculus',
  'machine-learning': 'Machine Learning', 'ai': 'AI', 'dbms': 'DBMS',
  'python-dsa': 'Python & DSA', 'gate-strategy': 'GATE Strategy',
  'announcement': 'Announcement', 'career': 'Career', 'tips': 'Tips',
};

function renderTags(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="blog-tags">${tags.map(t => `<span class="blog-tag">${escapeHtml(TAG_LABELS[t] || t)}</span>`).join('')}</div>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Renders Markdown with KaTeX math support.
// Strategy: extract $...$ and $$...$$ before marked runs (so marked doesn't
// mangle them), replace with unique tokens, restore as KaTeX HTML after.
function renderMarkdown(content) {
  const blocks = [];

  let src = content
    // Display math $$...$$ (extract first to avoid matching inner $)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
      const i = blocks.length;
      try {
        blocks.push(`<div class="math-display">${katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false })}</div>`);
      } catch { blocks.push(`<div class="math-display math-error">${tex}</div>`); }
      return `MATHPLACEHOLDER_${i}_`;
    })
    // Inline math $...$
    .replace(/\$([^$\n]+?)\$/g, (_, tex) => {
      const i = blocks.length;
      try {
        blocks.push(`<span class="math-inline">${katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false })}</span>`);
      } catch { blocks.push(`<span class="math-inline math-error">${tex}</span>`); }
      return `MATHPLACEHOLDER_${i}_`;
    });

  let html = marked.parse(src);

  // Restore KaTeX HTML
  html = html.replace(/MATHPLACEHOLDER_(\d+)_/g, (_, i) => blocks[+i]);
  return html;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { data: {}, content: raw };
  const data = {};
  let currentListKey = null;
  for (const line of m[1].split('\n')) {
    const listItem = line.match(/^[ \t]*-[ \t]+(.+)$/);
    if (listItem && currentListKey) {
      data[currentListKey].push(listItem[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    currentListKey = null;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!val) { data[key] = []; currentListKey = key; continue; } // YAML list start
    if (val.startsWith('[') && val.endsWith(']')) { // inline list [a, b]
      data[key] = val.slice(1,-1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      data[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return { data, content: m[2] };
}

function renderHead({ title, description, canonicalPath, ogImage }) {
  const url = `${SITE_URL}${canonicalPath}`;
  const img = ogImage || `${SITE_URL}/og-banner.webp`;
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#6d28d9">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" href="/favicon.ico?v=6" sizes="any">
<link rel="icon" type="image/webp" sizes="192x192" href="/favicon-192.webp">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)}</title>
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="TAAI">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${img}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${img}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/blogs/blog.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">`;
}

function renderNav() {
  const links = BLOG_NAV_LINKS.map(l => l.href === '/gate-da-free-notes'
    ? `<div class="nav-dropdown-wrap">
            <span class="nav-resources-label">Resources</span>
            <div class="nav-dropdown">
              <a href="/gate-da-free-notes" class="nav-dd-item">Free Notes &amp; Lectures</a>
              <div class="nav-dd-divider"></div>
              <a href="/blogs" class="nav-dd-item active">Blog</a>
            </div>
          </div>`
    : `<a href="${l.href}" class="${l.active ? 'active' : ''}">${l.label}</a>`
  ).join('\n          ');
  // mobile menu expands Resources into its two sub-items directly
  const mobileLinks = [{ label: 'Home', href: '/' },
    ...BLOG_NAV_LINKS.flatMap(l => l.href === '/gate-da-free-notes'
      ? [{ href: '/gate-da-free-notes', label: 'Free Notes &amp; Lectures' }, { href: '/blogs', label: 'Blogs', active: true }]
      : [l]
    )
  ];
  return `<div class="menu-overlay"></div>
    <nav class="nav">
      <div class="nav-inner">
        <a href="/" class="nav-logo"><img src="/logo.webp" alt="TAAI"></a>
        <div class="nav-links">
          ${links}
        </div>
        <div class="nav-cta">
          <a target="_blank" rel="noopener noreferrer" href="https://learn.taai.live/learn/account/signin" class="btn-nav-signin btn-swap" id="blog-signin-btn">
            <span class="swap-default">Sign In</span>
            <span class="swap-hover" id="blog-signin-days">— days</span>
            <span class="swap-hover" id="blog-signin-gate">GATE</span>
          </a>
          <a target="_blank" rel="noopener noreferrer" href="https://learn.taai.live/learn/account/signup" class="btn-nav-signup">Sign Up</a>
          <a href="/contact" class="btn-nav-contact"><span class="phone-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Contact Us</a>
        </div>
        <button class="nav-hamburger" aria-label="Toggle menu"><span></span><span></span><span></span></button>
      </div>
    </nav>
    <div class="mobile-menu">
      ${mobileLinks.map(l => `<a href="${l.href}" class="mobile-menu-link${l.active ? ' active' : ''}">
        <span class="mobile-menu-link-icon">${BLOG_MENU_ICONS[l.href] || ''}</span>
        <span class="mobile-menu-link-label">${l.label}</span>
      </a>`).join('\n      ')}
      <div class="mobile-menu-divider"></div>
      <div class="mobile-menu-actions">
        <a target="_blank" rel="noopener noreferrer" href="https://learn.taai.live/learn/account/signin" class="btn-nav-signin"><span>Sign In</span></a>
        <a target="_blank" rel="noopener noreferrer" href="https://learn.taai.live/learn/account/signup" class="btn-nav-signup"><span>Sign Up</span></a>
      </div>
      <a href="/contact" class="mobile-menu-contact"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Contact Us</a>
    </div>
    <div class="nav-spacer"></div>`;
}

function renderFooter() {
  return `<footer class="footer">
      <div class="container">
        <div class="footer-inner">
          <div class="footer-copy">© 2026 Tomorrow's Architect of AI</div>
          <div class="footer-socials">
            <a target="_blank" rel="noopener noreferrer" href="https://wa.me/9088553305" aria-label="WhatsApp"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884"/></svg></a>
            <a target="_blank" rel="noopener noreferrer" href="https://discord.com/invite/AwZqYz9wvK" aria-label="Discord"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.031.057a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg></a>
            <a target="_blank" rel="noopener noreferrer" href="https://t.me/ManojGateDA" aria-label="Telegram"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg></a>
            <a href="https://www.youtube.com/@Manojkumar_TAAI" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
            <a href="https://www.linkedin.com/company/taai-gate-da-placements/?viewAsMember=true" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>
          </div>
          <a href="mailto:support@taai.live" class="footer-email">support@taai.live</a>
        </div>
      </div>
    </footer>`;
}

function renderChrome(bodyHtml) {
  return `<div id="scroll-progress-bar" class="scroll-progress" style="width:0%"></div>
    ${renderNav()}
    ${bodyHtml}
    ${renderFooter()}
    <button class="back-to-top" aria-label="Back to top"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></button>
    <script src="/blogs/blog.js"></script>`;
}

function loadPosts() {
  if (!fs.existsSync(BLOG_CONTENT_DIR)) return [];
  return fs.readdirSync(BLOG_CONTENT_DIR)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .map(f => {
      const raw = fs.readFileSync(path.join(BLOG_CONTENT_DIR, f), 'utf8');
      const { data, content } = parseFrontmatter(raw);
      const slug = data.slug || f.replace(/\.md$/i, '');
      return {
        slug,
        title: data.title || slug,
        date: data.date || '',
        description: data.description || '',
        cover: data.cover || '',
        tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []),
        html: renderMarkdown(content),
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function generateBlog() {
  const posts = loadPosts();
  // Written into the source blog/ folder (not dist/) so the regular dev
  // server — which serves source directly, same as the other pages —
  // can preview it without a build. The generic asset-copy step then
  // carries it into dist/ for the production build.
  const blogDir = path.join(SRC, 'blogs');
  if (!fs.existsSync(blogDir)) fs.mkdirSync(blogDir, { recursive: true });

  // Listing page
  const cardIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" /></svg>';
  const cards = posts.length
    ? posts.map((p, i) => `<a href="/blogs/${p.slug}/" class="blog-card fade-in" style="--delay: ${Math.min(i, 5) * 80}ms">
          ${p.cover ? `<img class="blog-card-cover" src="${escapeHtml(p.cover)}" alt="" loading="lazy">` : `<div class="blog-card-icon">${cardIcon}</div>`}
          <div class="blog-card-date">${formatDate(p.date)}</div>
          <div class="blog-card-title">${escapeHtml(p.title)}</div>
          <div class="blog-card-desc">${escapeHtml(p.description)}</div>
          ${renderTags(p.tags)}
          <span class="blog-card-link">Read more →</span>
        </a>`).join('\n        ')
    : '<p class="blog-empty">No posts yet — check back soon.</p>';

  const indexBody = `<section class="blog-hero">
      <div class="container">
        <div class="blog-eyebrow fade-in">TAAI Blogs</div>
        <h1 class="fade-in">GATE DA guides, syllabus<br>breakdowns, <em>and prep tips.</em></h1>
        <p class="blog-hero-sub fade-in">Written by the TAAI team to help you prepare smarter for GATE DA.</p>
      </div>
    </section>
    <section class="blog-list">
      <div class="container">
        <div class="blog-grid">
          ${cards}
        </div>
      </div>
    </section>`;

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead({ title: 'Blog | TAAI', description: 'GATE DA prep guides, syllabus breakdowns, and study tips from the TAAI team.', canonicalPath: '/blogs' })}
</head>
<body>
${renderChrome(indexBody)}
</body>
</html>`;
  fs.writeFileSync(path.join(blogDir, 'index.html'), indexHtml);

  // Individual post pages
  for (const post of posts) {
    const postDir = path.join(blogDir, post.slug);
    if (!fs.existsSync(postDir)) fs.mkdirSync(postDir, { recursive: true });
    const postBody = `<article class="blog-post">
      <div class="blog-post-hero">
        <div class="container">
          <a href="/blogs" class="blog-post-back">← Back to blog</a>
          <div class="blog-post-date fade-in">${formatDate(post.date)}</div>
          ${post.tags.length ? `<div class="fade-in">${renderTags(post.tags)}</div>` : ''}
          <h1 class="fade-in">${escapeHtml(post.title)}</h1>
        </div>
      </div>
      <div class="container">
        ${post.cover ? `<img class="blog-post-cover" src="${escapeHtml(post.cover)}" alt="">` : ''}
        <div class="blog-post-content">
          ${post.html}
        </div>
      </div>
    </article>`;
    const postHtml = `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead({ title: `${post.title} | TAAI Blogs`, description: post.description, canonicalPath: `/blogs/${post.slug}`, ogImage: post.cover ? `${SITE_URL}${post.cover}` : undefined })}
</head>
<body>
${renderChrome(postBody)}
</body>
</html>`;
    fs.writeFileSync(path.join(postDir, 'index.html'), postHtml);
  }

  console.log(`  ✓ blog (${posts.length} post${posts.length === 1 ? '' : 's'})`);
  return posts;
}

function generateSitemap(posts) {
  const staticUrls = [
    { loc: '/', priority: '1.0', freq: 'weekly' },
    { loc: '/gate-da-courses', priority: '0.9', freq: 'weekly' },
    { loc: '/gate-da-test-series', priority: '0.8', freq: 'weekly' },
    { loc: '/gate-da-toppers', priority: '0.7', freq: 'weekly' },
    { loc: '/gate-da-free-notes', priority: '0.7', freq: 'weekly' },
    { loc: '/gate-da-progress-tracker', priority: '0.7', freq: 'daily' },
    { loc: '/blogs', priority: '0.7', freq: 'weekly' },
    { loc: '/contact', priority: '0.5', freq: 'monthly' },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const postUrls = posts.map(p => ({ loc: `/blogs/${p.slug}`, priority: '0.6', freq: 'monthly', lastmod: p.date || today }));

  const entries = [...staticUrls.map(u => ({ ...u, lastmod: today })), ...postUrls];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(u => `  <url>
    <loc>${SITE_URL}${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(SRC, 'sitemap.xml'), xml);
  console.log('  ✓ sitemap.xml');
}

function build() {
  // Full clean before every build — dist/ previously only ever had files
  // added/overwritten, never removed, so a renamed or deleted source page
  // left its old compiled output orphaned in dist/ (and thus still live on
  // Netlify, regardless of what netlify.toml's redirects said).
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  console.log('Building…');
  // Generate blog pages + sitemap into source first, so the generic
  // copy step below carries the fresh output into dist/ along with
  // everything else.
  const posts = generateBlog();
  generateSitemap(posts);

  // Copy static assets (images, etc.) — skip dist/, node_modules/, and
  // anything that's internal tooling/docs rather than something a visitor
  // should ever be able to fetch (this loop has no other allowlist, so
  // anything not named here gets copied and publicly served as-is).
  const SKIP_DIRS = new Set([
    'dist', 'node_modules', '.git', 'content', 'netlify', 'supabase', 'scripts',
    'CLAUDE.md', 'build.mjs', 'package.json', 'package-lock.json', 'netlify.toml',
  ]);
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
  if (fs.existsSync(BLOG_CONTENT_DIR)) {
    fs.watch(BLOG_CONTENT_DIR, () => {
      console.log('\nblog content changed, rebuilding…');
      try { generateSitemap(generateBlog()); } catch (e) { console.error(e.message); }
    });
  }
}

