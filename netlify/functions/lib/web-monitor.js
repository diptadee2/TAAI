// Competitor website watcher (2026-11-25), for /team > Competitors > Websites.
//
// Each tracked page (table web_pages) is fetched on a schedule (web-monitor.js,
// every 12 hours) or from /team's "Check now". What we keep from a page:
//   lines   the readable text, one line per block (scripts, styles, nav and
//           footer dropped), used to show what text was added or removed
//   offers  [{name, price, mrp, url}] what the page sells: from the site's own
//           data where we know how to read it (GfG course list, PW batches),
//           otherwise every line that shows a rupee amount
// A snapshot row is stored only when something changed, and every change
// becomes a row in web_changes (price, offer_new, offer_gone, text, title,
// page_new, page_gone, error). Sitemaps (extractor 'sitemap') list a site's
// pages instead; new and removed pages are reported.
//
// Only public pages are read, with an ordinary browser User-Agent, at most
// twice a day per page. Sites that block automated visits (Unacademy) can't
// be tracked this way.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_LINES = 700;
const MAX_LINE = 240;

async function fetchText(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-IN,en;q=0.9' }, redirect: 'follow', signal: ac.signal });
    const text = await r.text();
    return { status: r.status, text, finalUrl: r.url };
  } finally { clearTimeout(t); }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•', rupee: '₹', times: '×' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

// Readable text, one line per block element.
export function htmlToLines(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|li|ul|ol|tr|td|th|table|h[1-6]|header|main|aside|button|a|span|label|dt|dd|figcaption|summary|details)\b[^>]*>/gi, m => /^<\/?(span|a|label)\b/i.test(m) ? ' ' : '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  const out = [];
  const seen = new Set();
  for (let line of s.split('\n')) {
    line = line.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    if (line.length < 3 || !/[a-z0-9₹]/i.test(line)) continue;
    if (/<@|@>|\{\{|\}\}/.test(line)) continue;            // unrendered template code
    if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + '…';
    if (seen.has(line)) continue;                             // repeated menus, cards shown twice
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

// Lines that only show a countdown or a live counter change on every visit.
const NOISE = /(\b\d+\s*(d|h|m|s|days?|hrs?|hours?|mins?|minutes?|secs?|seconds?)\b.*){2,}|\bseats? left\b|\bviewing now\b|\bjust (enrolled|bought|purchased)\b|\b\d+\s*(people|students) (are )?(viewing|watching)\b/i;
export function stableLines(lines) { return lines.filter(l => !NOISE.test(l)); }

function rupees(s) {
  const m = String(s).match(/(?:₹|Rs\.?|INR)\s?([0-9][0-9,]*(?:\.\d+)?)/i);
  return m ? Math.round(Number(m[1].replace(/,/g, ''))) : null;
}

// Every line with a rupee amount, as an "offer". Prices often sit on a line
// of their own ("₹5,999"), so the nearest text lines around it (that have no
// price) are kept as its label, e.g. "₹5,999 · Core (Till Feb 2027)". The key
// is the line plus its label with the numbers taken out, so a changed amount
// in the same place reads as a price change, not a new offer.
const amounts = l => [...l.matchAll(/(?:₹|Rs\.?\s?|INR\s?)\s?([0-9][0-9,]*)/gi)].map(m => Number(m[1].replace(/,/g, ''))).filter(n => n >= 50);
const LABEL_SKIP = /^(add to cart|buy now|enrol+ now|enroll now|checkout|price|view details|know more|\d{4}-\d{2}-\d{2})$/i;
function offersFromLines(lines) {
  const out = [], count = {};
  const plain = i => i >= 0 && i < lines.length && !amounts(lines[i]).length && lines[i].length <= 90 && !LABEL_SKIP.test(lines[i]) ? lines[i] : null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const all = amounts(l);
    if (!all.length) continue;
    const bare = l.replace(/(?:₹|Rs\.?|INR)\s?[0-9][0-9,]*|[0-9]+%|\b(off|only|gst|\+|\/|-)\b/gi, '').replace(/[^a-z]/gi, '').length < 4;
    const label = bare ? (plain(i + 1) || plain(i - 1)) : null;
    const name = label ? l + ' · ' + label : l;
    // Same text twice (two bare "₹27999" lines) stays two offers, told apart
    // by their order on the page.
    const base = name.replace(/[0-9,.₹]+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
    count[base] = (count[base] || 0) + 1;
    out.push({ name, price: Math.min(...all), mrp: all.length > 1 ? Math.max(...all) : null, key: base + (count[base] > 1 ? ' #' + count[base] : '') });
  }
  return out;
}

// GeeksforGeeks course lists: the page's own Next.js data has every course
// with batch_fee (what you pay) and promotional_fee (the struck-out price).
function gfgOffers(html, filter) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [], seen = new Set();
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.course_name === 'string' && o.course_slug) {
      if (!seen.has(o.course_slug) && (!filter || filter.test(o.course_name))) {
        seen.add(o.course_slug);
        const p = o.price || {};
        out.push({ name: o.course_name.trim(), price: p.batch_fee || null, mrp: p.promotional_fee && p.promotional_fee !== p.batch_fee ? p.promotional_fee : null, url: 'https://www.geeksforgeeks.org/courses/' + o.course_slug });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}

// PW (GATE Wallah) batch lists: each batch's data has
// "fees":{"price":MRP,"total":what you pay,"discount":%} after its name/slug.
function pwOffers(html, pageUrl, filter) {
  const p = html.replace(/\\"/g, '"');
  const out = [], seen = new Set();
  const re = /"fees":\{"price":(\d+(?:\.\d+)?),"total":(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(p))) {
    const before = p.slice(Math.max(0, m.index - 12000), m.index);
    const names = [...before.matchAll(/"name":"([^"]*(?:Batch|GATE)[^"]*)"/g)];
    const slugs = [...before.matchAll(/"slug":"([a-z0-9-]+-\d{6})"/g)];
    if (!names.length) continue;
    const name = JSON.parse('"' + names[names.length - 1][1] + '"').trim();
    const slug = slugs.length ? slugs[slugs.length - 1][1] : null;
    const key = slug || name;
    if (seen.has(key) || (filter && !filter.test(name))) continue;
    seen.add(key);
    const mrp = Math.round(+m[1]), price = Math.round(+m[2]);
    out.push({ name, price: price || null, mrp: mrp && mrp !== price ? mrp : null, url: slug ? pageUrl.replace(/[?#].*$/, '').replace(/\/$/, '') + '/' + slug : null });
  }
  return out;
}

export function extractPage(page, html, finalUrl) {
  const filter = page.match ? new RegExp(page.match, 'i') : null;
  const lines = htmlToLines(html);
  let offers;
  if (page.extractor === 'gfg') offers = gfgOffers(html, filter);
  else if (page.extractor === 'pw') offers = pwOffers(html, finalUrl || page.url, filter);
  else offers = offersFromLines(stableLines(lines));
  return { title: pageTitle(html), lines, offers };
}

// Sitemap: every <loc>, following a sitemap index one level down.
async function sitemapUrls(url, filter) {
  const r = await fetchText(url);
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  let locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
  if (/<sitemapindex/i.test(r.text)) {
    const kids = locs.slice(0, 8);
    locs = [];
    for (const k of kids) {
      try { const c = await fetchText(k); locs.push(...[...c.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]))); } catch { /* skip that part */ }
    }
  }
  return [...new Set(locs.filter(u => !filter || filter.test(u)))].slice(0, 3000);
}

const offerKey = o => o.url || o.key || o.name.replace(/[0-9,.₹]+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
const fmt = n => n == null ? '-' : '₹' + Number(n).toLocaleString('en-IN');

// What changed between two extractions of the same page.
export function diffPage(prev, cur) {
  const changes = [];
  if (prev.title && cur.title && prev.title !== cur.title) changes.push({ kind: 'title', summary: 'Page title changed', detail: { from: prev.title, to: cur.title } });
  const pm = new Map((prev.offers || []).map(o => [offerKey(o), o]));
  const cm = new Map((cur.offers || []).map(o => [offerKey(o), o]));
  for (const [k, o] of cm) {
    const was = pm.get(k);
    if (!was) changes.push({ kind: 'offer_new', summary: 'New: ' + o.name.slice(0, 140) + (o.price ? ' at ' + fmt(o.price) : ''), detail: { offer: o } });
    else if (was.price !== o.price || was.mrp !== o.mrp) {
      const dir = o.price != null && was.price != null ? (o.price > was.price ? 'up' : o.price < was.price ? 'down' : 'same') : 'same';
      changes.push({ kind: 'price', summary: o.name.slice(0, 120) + ': ' + fmt(was.price) + ' → ' + fmt(o.price) + (o.mrp !== was.mrp ? ' (MRP ' + fmt(was.mrp) + ' → ' + fmt(o.mrp) + ')' : ''), detail: { from: was, to: o, dir } });
    }
  }
  for (const [k, o] of pm) if (!cm.has(k)) changes.push({ kind: 'offer_gone', summary: 'Gone: ' + o.name.slice(0, 140) + (o.price ? ' (was ' + fmt(o.price) + ')' : ''), detail: { offer: o } });
  // Text: lines added / removed, ignoring countdowns and lines with a rupee
  // amount (those are reported as offers above).
  const a = new Set(stableLines(prev.lines || [])), b = new Set(stableLines(cur.lines || []));
  const added = [...b].filter(l => !a.has(l) && !amounts(l).length);
  const removed = [...a].filter(l => !b.has(l) && !amounts(l).length);
  if (added.length || removed.length) {
    const first = (added[0] || removed[0] || '').slice(0, 110);
    changes.push({ kind: 'text', summary: (added.length ? added.length + ' line' + (added.length === 1 ? '' : 's') + ' added' : '') + (added.length && removed.length ? ', ' : '') + (removed.length ? removed.length + ' removed' : '') + (first ? ': "' + first + '"' : ''), detail: { added: added.slice(0, 80), removed: removed.slice(0, 80) } });
  }
  return changes;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

// Checks every active page (or just the given ids). Returns a summary.
export async function runWebMonitor(s, { ids = null, budgetMs = 22000 } = {}) {
  const t0 = Date.now();
  let q = s.from('web_pages').select('*').eq('active', true).order('sort');
  if (ids) q = q.in('id', ids);
  const { data: pages, error } = await q;
  if (error) throw error;
  const now = new Date().toISOString();
  let checked = 0, changed = 0, failed = 0;
  const problems = [];
  await pool(pages || [], 4, async (page) => {
    if (Date.now() - t0 > budgetMs) return;
    try {
      if (page.extractor === 'sitemap') {
        const urls = await sitemapUrls(page.url, page.match ? new RegExp(page.match, 'i') : null);
        const { data: known } = await s.from('web_sitemap_urls').select('url, gone_at').eq('page_id', page.id);
        const kmap = new Map((known || []).map(k => [k.url, k]));
        const cur = new Set(urls);
        const first = !(known || []).length;
        const fresh = urls.filter(u => !kmap.has(u) || kmap.get(u).gone_at);
        const gone = [...kmap.values()].filter(k => !k.gone_at && !cur.has(k.url)).map(k => k.url);
        if (fresh.length) {
          for (let i = 0; i < fresh.length; i += 500) await s.from('web_sitemap_urls').upsert(fresh.slice(i, i + 500).map(u => ({ page_id: page.id, url: u, first_seen: now, last_seen: now, gone_at: null })), { onConflict: 'page_id,url' });
        }
        if (urls.length) await s.from('web_sitemap_urls').update({ last_seen: now }).eq('page_id', page.id).is('gone_at', null);
        if (gone.length) await s.from('web_sitemap_urls').update({ gone_at: now }).eq('page_id', page.id).in('url', gone.slice(0, 500));
        const rows = [];
        if (!first) {
          for (const u of fresh) rows.push({ page_id: page.id, kind: 'page_new', summary: 'New page: ' + u, detail: { url: u } });
          for (const u of gone) rows.push({ page_id: page.id, kind: 'page_gone', summary: 'Page removed: ' + u, detail: { url: u } });
        }
        if (rows.length) { await s.from('web_changes').insert(rows.slice(0, 200)); changed++; }
        await s.from('web_pages').update({ last_checked_at: now, last_status: 200, last_error: null, last_count: urls.length }).eq('id', page.id);
        checked++;
        return;
      }
      const r = await fetchText(page.url);
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      const cur = extractPage(page, r.text, r.finalUrl);
      if (!cur.lines.length && !cur.offers.length) throw new Error('page came back empty');
      const { data: last } = await s.from('web_snapshots').select('id, title, lines, offers').eq('page_id', page.id).order('taken_at', { ascending: false }).limit(1).maybeSingle();
      let rows = [];
      if (last) rows = diffPage(last, cur).map(c => Object.assign({ page_id: page.id }, c));
      if (!last || rows.length) {
        await s.from('web_snapshots').insert({ page_id: page.id, title: cur.title, lines: cur.lines, offers: cur.offers });
        if (rows.length) { await s.from('web_changes').insert(rows); changed++; }
      }
      // A page that had been failing and works again
      if (page.last_error) await s.from('web_changes').insert({ page_id: page.id, kind: 'error', summary: 'Page reachable again', detail: { was: page.last_error } });
      await s.from('web_pages').update({ last_checked_at: now, last_status: r.status, last_error: null, last_count: cur.offers.length }).eq('id', page.id);
      checked++;
    } catch (e) {
      failed++;
      const msg = (e.name === 'AbortError' ? 'timed out' : e.message || String(e)).slice(0, 200);
      problems.push((page.label || page.url) + ': ' + msg);
      if (!page.last_error) await s.from('web_changes').insert({ page_id: page.id, kind: 'error', summary: 'Could not read the page: ' + msg, detail: {} });
      await s.from('web_pages').update({ last_checked_at: now, last_error: msg }).eq('id', page.id);
    }
  });
  const skipped = (pages || []).length - checked - failed;
  return { ok: true, pages: (pages || []).length, checked, changed, failed, skipped, error: problems.join('; ') || null };
}
