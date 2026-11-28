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
        out.push({ name: o.course_name.trim(), price: p.batch_fee || null, mrp: p.promotional_fee && p.promotional_fee !== p.batch_fee ? p.promotional_fee : null, url: 'https://www.geeksforgeeks.org/courses/' + o.course_slug, currency: o.currency_symbol || null });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}

// GfG shows prices in the visitor's currency, decided by its CDN from the
// visitor's country; our checks run on US servers, so the page itself came
// back in dollars. Its course API takes the country as a "cdn-country-code"
// header (found 2026-11-28), so ask it for India directly. Same course
// objects as the page's own data, so gfgOffers reads them unchanged. Returns
// null on any problem, and the page's own data is used instead.
export async function gfgIndiaCourses(pageUrl) {
  const m = String(pageUrl).match(/\/courses\/category\/([a-z0-9-]+)/i);
  if (!m) return null;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch('https://practiceapi.geeksforgeeks.org/api/vr/courses/?category=' + m[1] + '&course_fee_type=1&page=' + page,
        { headers: { 'user-agent': UA, accept: 'application/json', 'cdn-country-code': 'IN' }, signal: ac.signal });
      if (!r.ok) return all.length ? all : null;
      const d = await r.json();
      const res = d.results || [];
      all.push(...res);
      if (!res.length || all.length >= (d.count || 0)) break;
    } catch { return all.length ? all : null; } finally { clearTimeout(t); }
  }
  // GATE's own landing list holds a few courses the list above doesn't
  // (e.g. Mission 100), priced per batch; add those, first batch's price.
  if (m[1] === 'gate') {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch('https://practiceapi.geeksforgeeks.org/api/v1/gate-courses/list/', { headers: { 'user-agent': UA, accept: 'application/json', 'cdn-country-code': 'IN' }, signal: ac.signal });
      if (r.ok) {
        const have = new Set(all.map(c => c.course_slug));
        (function walk(o) {
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (!o || typeof o !== 'object') return;
          if (typeof o.course_name === 'string' && o.course_slug) {
            const b = (o.batches || [])[0];
            if (b && !have.has(o.course_slug)) { have.add(o.course_slug); all.push({ course_name: o.course_name, course_slug: o.course_slug, currency_symbol: '₹', price: { batch_fee: b.batch_fee, promotional_fee: b.promotional_fee } }); }
            return;
          }
          for (const k in o) walk(o[k]);
        })(await r.json());
      }
    } catch { /* the main list is enough */ } finally { clearTimeout(t); }
  }
  return all.length ? all : null;
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

// The JSON array/object that starts at html[i] ('[' or '{'), or null.
function jsonAt(html, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length && j < i + 200000; j++) {
    const ch = html[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (!depth) { try { return JSON.parse(html.slice(i, j + 1)); } catch { return null; } } }
  }
  return null;
}

// Spayee course pages (GO Classes): the course title and every plan
// ("6-Month Validity", "1-Year Validity + 3 Months Extra"…) with its MRP,
// price and validity are in the page's own data.
function spayeeOffers(html, pageUrl) {
  const t = html.match(/"spayee:title":"((?:[^"\\]|\\.)*)"/);
  const at = html.indexOf('"spayee:productVariants":');
  if (!t || at === -1) return [];
  const product = JSON.parse('"' + t[1] + '"').trim();
  const variants = jsonAt(html, html.indexOf('[', at)) || [];
  const out = [];
  for (const v of variants) {
    if (!v || v.archived) continue;
    for (const vv of v.validityVariants || []) {
      const validity = vv.validityDate ? 'till ' + vv.validityDate : vv.validity ? vv.validity + ' ' + (vv.validityType || 'days') : (vv.label || '').trim();
      out.push({ product, plan: (v.productType || '').trim() || null, validity: validity || null, price: vv.price != null ? Math.round(vv.price) : null, mrp: vv.mrp && vv.mrp !== vv.price ? Math.round(vv.mrp) : null, url: pageUrl, note: 'incl. GST' });
    }
  }
  return out;
}

// schema.org offers in the page's JSON-LD (The ML Hub lists every plan this
// way). An offer named "GATE DA 2027 Core (Till Feb 2027) — Till Feb 2027
// (GATE DA 2027)" becomes product "GATE DA 2027 Core (Till Feb 2027)" with
// validity "Till Feb 2027 (GATE DA 2027)".
function jsonLdOffers(html, pageUrl) {
  const out = [], seen = new Set();
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let d; try { d = JSON.parse(m[1]); } catch { continue; }
    (function walk(o, parentName) {
      if (Array.isArray(o)) { o.forEach(x => walk(x, parentName)); return; }
      if (!o || typeof o !== 'object') return;
      const type = [].concat(o['@type'] || []).join(',');
      if (/\bOffer\b/.test(type) && (o.price != null || o.lowPrice != null)) {
        const full = String(o.name || parentName || '').trim();
        const [product, validity] = full.split(/\s+[—–]\s+/);
        const price = Math.round(Number(o.price != null ? o.price : o.lowPrice));
        const key = (product || '') + '|' + (validity || '') + '|' + price;
        if (!seen.has(key) && product && price > 0) { seen.add(key); out.push({ product: product.trim(), plan: null, validity: validity ? validity.trim() : null, price, mrp: null, url: o.url || pageUrl }); }
        return;
      }
      if (/FAQPage|Question|Answer|Review|Organization|Person|BreadcrumbList/.test(type)) return;
      for (const k in o) walk(o[k], o.name || parentName);
    })(d, null);
  }
  // The same plan listed twice on one page (with and without a validity):
  // keep the one that says how long it lasts.
  return out.filter(o => o.validity || !out.some(x => x !== o && x.validity && x.product === o.product && x.price === o.price));
}

// Offers carry: product, plan, validity, price, mrp, url, and source
// 'data' (read from the site's own data) or 'text' (a rupee amount found in
// the page text, with a nearby line as its label; less reliable, kept only
// when a page has no data at all). v:2 marks this format.
export function extractPage(page, html, finalUrl, extra = {}) {
  const filter = page.match ? new RegExp(page.match, 'i') : null;
  const lines = htmlToLines(html);
  const url = finalUrl || page.url;
  let offers;
  if (page.extractor === 'gfg') offers = (extra.gfgCourses ? gfgOffers('<script id="__NEXT_DATA__">' + JSON.stringify(extra.gfgCourses) + '</script>', filter) : gfgOffers(html, filter)).map(o => ({ product: o.name, plan: null, validity: null, price: o.price, mrp: o.mrp, url: o.url, currency: o.currency && o.currency !== '₹' ? o.currency : undefined }));
  else if (page.extractor === 'pw') offers = pwOffers(html, url, filter).map(o => ({ product: o.name, plan: null, validity: null, price: o.price, mrp: o.mrp, url: o.url }));
  else {
    offers = spayeeOffers(html, url);
    if (!offers.length) offers = jsonLdOffers(html, url);
    if (!offers.length) {
      offers = offersFromLines(stableLines(lines)).filter(o => o.name.length <= 100)
        .map(o => ({ product: o.name, plan: null, validity: null, price: o.price, mrp: o.mrp, url: null, key: o.key, source: 'text' }));
    }
  }
  offers = offers.map(o => Object.assign({ v: 2, source: 'data' }, o, {
    name: o.product + (o.plan ? ' · ' + o.plan : '') + (o.validity ? ' · ' + o.validity : ''),
    key: o.key || [o.product, o.plan, o.validity].map(x => String(x || '').toLowerCase().trim()).join('|'),
  }));
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

const offerKey = o => o.key || o.url || o.name.replace(/[0-9,.₹]+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
const fmt = (n, cur) => n == null ? '-' : (cur || '₹') + Number(n).toLocaleString(cur && cur !== '₹' ? 'en-US' : 'en-IN');
// Old GfG readings (before 2026-11-27) have no currency field; dollar prices
// have cents (119.98), rupee prices never do.
export const offerCurrency = o => (o && o.currency) || (o && o.price != null && o.price % 1 !== 0 ? '$' : '₹');

// Accuracy rules (2026-11-27, "are the website changes accurate?"):
// - a star rating or review count ticking over ("4.9", "(47 ratings)") and
//   long navigation menus ("UPSC Online Coaching UPSC Offline ...") are not
//   changes worth reporting;
// - offers guessed from page text are too unstable to report as new/gone
//   (they produced a burst of 74 bogus entries on 2026-11-26);
// - small menu-word edits ("Jobs" -> "Interview Prep") are kept but marked minor.
const RATING_RE = /^\(?\s*\d+(\.\d+)?\s*(k\+?|\+)?\s*(ratings?|reviews?|students?|learners?|enrolled|views?|learners enrolled)?\s*\)?$/i;
export function isTrivialLine(l) {
  l = String(l || '').trim();
  if (!l || RATING_RE.test(l)) return true;
  if (l.length >= 100) {
    const words = l.toLowerCase().match(/[a-z]{5,}/g) || [];
    const count = {}; let top = 0;
    words.forEach(w => { count[w] = (count[w] || 0) + 1; if (count[w] > top) top = count[w]; });
    if (top >= 4 && !/[.!?]/.test(l)) return true; // a menu: the same word over and over, no sentences
  }
  return false;
}
const MEANINGFUL_RE = /₹|\$|%|\b(sale|offer|discount|coupon|off|launch|new|batch|free|live|price|fee|starts?|deadline|last date|validity|enrol|admission|mock|test series|course)\b/i;
export function isMinorText(added, removed) {
  const all = (added || []).concat(removed || []);
  return !all.some(l => l.length >= 25 || MEANINGFUL_RE.test(l));
}
// For rows already stored: true when the change is one of the noise kinds above.
export function isNoiseChange(c) {
  const d = c.detail || {};
  if ((c.kind === 'offer_new' || c.kind === 'offer_gone') && d.offer && d.offer.source === 'text') return true;
  if (c.kind === 'price' && d.from && d.to && offerCurrency(d.from) !== offerCurrency(d.to)) return true;
  if (c.kind === 'text') {
    const added = (d.added || []).filter(l => !isTrivialLine(l)), removed = (d.removed || []).filter(l => !isTrivialLine(l));
    if (!added.length && !removed.length) return true;
  }
  return false;
}

// What changed between two extractions of the same page.
export function diffPage(prev, cur) {
  const changes = [];
  if (prev.title && cur.title && prev.title !== cur.title) changes.push({ kind: 'title', summary: 'Page title changed', detail: { from: prev.title, to: cur.title } });
  // Snapshots from before the v:2 offer format (2026-11-25) can't be
  // compared offer by offer; the first new read just becomes the baseline.
  // Offers are compared only when both readings come from the site's own
  // data, in the same currency.
  const dataOnly = list => (list || []).filter(o => o.source !== 'text');
  const curs = list => [...new Set(dataOnly(list).map(offerCurrency))].sort().join(',');
  const comparable = (!(prev.offers || []).length || (prev.offers || []).some(o => o.v === 2)) && curs(prev.offers) === curs(cur.offers);
  const pm = new Map(comparable ? dataOnly(prev.offers).map(o => [offerKey(o), o]) : []);
  const cm = new Map(comparable && dataOnly(prev.offers).length ? dataOnly(cur.offers).map(o => [offerKey(o), o]) : []);
  for (const [k, o] of cm) {
    const was = pm.get(k);
    if (!was) changes.push({ kind: 'offer_new', summary: 'New: ' + o.name.slice(0, 140) + (o.price ? ' at ' + fmt(o.price, offerCurrency(o)) : ''), detail: { offer: o } });
    else if (was.price !== o.price || was.mrp !== o.mrp) {
      const dir = o.price != null && was.price != null ? (o.price > was.price ? 'up' : o.price < was.price ? 'down' : 'same') : 'same';
      const cu = offerCurrency(o);
      changes.push({ kind: 'price', summary: o.name.slice(0, 120) + ': ' + fmt(was.price, cu) + ' → ' + fmt(o.price, cu) + (o.mrp !== was.mrp ? ' (MRP ' + fmt(was.mrp, cu) + ' → ' + fmt(o.mrp, cu) + ')' : ''), detail: { from: was, to: o, dir } });
    }
  }
  if (cm.size) for (const [k, o] of pm) if (!cm.has(k)) changes.push({ kind: 'offer_gone', summary: 'Gone: ' + o.name.slice(0, 140) + (o.price ? ' (was ' + fmt(o.price, offerCurrency(o)) + ')' : ''), detail: { offer: o } });
  // Text: lines added / removed, ignoring countdowns. When a page's prices
  // come from its text, its short price lines are reported as offers above,
  // so they're left out here; longer sentences that mention a price stay in.
  const fromText = (cur.offers || []).some(o => o.source === 'text');
  const skip = l => fromText && amounts(l).length && l.length <= 100;
  const a = new Set(stableLines(prev.lines || [])), b = new Set(stableLines(cur.lines || []));
  const added = [...b].filter(l => !a.has(l) && !skip(l) && !isTrivialLine(l));
  const removed = [...a].filter(l => !b.has(l) && !skip(l) && !isTrivialLine(l));
  if (added.length || removed.length) {
    const first = (added[0] || removed[0] || '').slice(0, 110);
    changes.push({ kind: 'text', summary: (added.length ? added.length + ' line' + (added.length === 1 ? '' : 's') + ' added' : '') + (added.length && removed.length ? ', ' : '') + (removed.length ? removed.length + ' removed' : '') + (first ? ': "' + first + '"' : ''), detail: { added: added.slice(0, 80), removed: removed.slice(0, 80), minor: isMinorText(added, removed) } });
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
      const gfgCourses = page.extractor === 'gfg' ? await gfgIndiaCourses(page.url) : null;
      const cur = extractPage(page, r.text, r.finalUrl, { gfgCourses });
      if (!cur.lines.length && !cur.offers.length) throw new Error('page came back empty');
      const { data: last } = await s.from('web_snapshots').select('id, title, lines, offers').eq('page_id', page.id).order('taken_at', { ascending: false }).limit(1).maybeSingle();
      // A page that had prices in its own data and now shows none is far more
      // likely a bad read than every course being removed at once
      // (2026-11-27: GO Classes' free Linear Algebra course was reported
      // "gone" this way). Keep the last reading and report a problem instead.
      const hadData = last && (last.offers || []).some(o => o.v === 2 && o.source !== 'text');
      if (hadData && !cur.offers.some(o => o.source !== 'text')) throw new Error('no prices found on this read (kept the last reading)');
      let rows = [];
      if (last) rows = diffPage(last, cur).map(c => Object.assign({ page_id: page.id }, c));
      // Also re-save when the stored snapshot predates the v:2 offer format.
      const oldFormat = last && (last.offers || []).some(o => o.v !== 2);
      if (!last || rows.length || oldFormat) {
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
