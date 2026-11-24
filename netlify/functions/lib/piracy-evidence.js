// Piracy evidence (2026-11-24): screenshots kept for legal action in the
// PRIVATE storage bucket "piracy-evidence" (manifest.json lists them with
// SHA-256 fingerprints) plus the takedown log CSV (reports.csv, one row per
// notice section). Used by team-piracy-evidence.js to file each screenshot
// under the report(s) it backs up.
import { normalizeTgLink, tgKey } from './piracy.js';

export const EVIDENCE_BUCKET = 'piracy-evidence';

export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some(c => c.trim())) rows.push(row); row = [];
    } else cur += ch;
  }
  row.push(cur); if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isoDate(d) {
  const m = String(d || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return m[3] + '-' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '').trim()) ? String(d).trim() : null;
}

// Every Telegram link written in a cell, in any of the shorthands used in the
// log and the evidence index: "https://t.me/x/55, /70", "x/55, /70",
// "https://t.me/c/123/2–/6 and /700", "https://t.me/c/123/700-728",
// "ID 123", "IDs 1, 2", "ID 1 · https://t.me/+invite", account names.
export function linkKeys(cell, { accounts = false } = {}) {
  const out = [];
  let prev = null;
  for (const part of String(cell || '').split(/\s+·\s+/)) {
    for (let tok of part.split(/,|\s+and\s+/)) {
      tok = tok.trim();
      if (!tok) continue;
      let url = null;
      const id = tok.match(/^IDs?\s+(\d{6,})$/i);
      if (id) url = 'https://t.me/c/' + id[1];
      else if (/^\d{8,}$/.test(tok) && prev && /^https:\/\/t\.me\/c\/\d+$/.test(prev)) url = 'https://t.me/c/' + tok;
      else if (/^(https?:\/\/)?(t\.me|telegram\.me)\//i.test(tok) || /^\+[A-Za-z0-9_-]{8,}$/.test(tok)) url = normalizeTgLink(tok.startsWith('+') ? 't.me/' + tok : tok);
      else if (/^\/?[\d/]+([–-]\/?\d+)?$/.test(tok) && prev) {
        // relative: "/70", "70", "/2/7", "2–/6": replace the parts after the channel
        const root = prev.match(/^(https:\/\/t\.me\/c\/\d+|https:\/\/t\.me\/[^/]+)/)[1];
        url = root + '/' + tok.replace(/^\//, '');
      } else if (/^[A-Za-z][A-Za-z0-9_]{3,}\/\d/.test(tok)) url = normalizeTgLink('t.me/' + tok);
      else if (accounts && /^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(tok)) url = 'https://t.me/' + tok.replace(/^@/, '');
      if (!url) continue;
      prev = url;
      const r = url.match(/^(.*\/)(\d+)[–-]\/?(\d+)$/);
      if (r) { for (let n = +r[2]; n <= +r[3] && n - +r[2] < 300; n++) out.push(tgKey(r[1] + n)); }
      else out.push(tgKey(url));
    }
  }
  return [...new Set(out)];
}

const rootOf = k => (k.match(/^(https:\/\/t\.me\/c\/\d+|https:\/\/t\.me\/[^/]+)/) || [k])[0];
const isRoot = k => rootOf(k) === k;

// Reports from reports.csv, each with the evidence paths that back it up:
//  - a screenshot of one of the report's exact message links, any date; or
//  - a screenshot of a channel / account / invite page (no message number) of
//    one of the report's channels or accounts, captured the SAME day (an old
//    screenshot of a reused username must not land under a newer report).
export function fileReports(csvText, files) {
  const rows = parseCsv(csvText);
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const col = name => head.findIndex(h => h.startsWith(name));
  const C = {
    date: col('date'), channel: col('channel / group'), status: col('status'), request: col('request'),
    chanLink: col('channel link'), links: col('infringing'), accounts: col('associated'), notes: col('notes'),
    network: col('network'), evidence: col('evidence'),
  };
  const get = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  const fileKeys = files.map(f => ({ f, keys: linkKeys(f.links) }));
  const used = new Set();
  const reports = rows.map((r, n) => {
    const rep = {
      n: n + 1,
      date: get(r, C.date), iso: isoDate(get(r, C.date)),
      channel: get(r, C.channel), status: get(r, C.status), request: get(r, C.request),
      channel_link: get(r, C.chanLink), links: get(r, C.links), accounts: get(r, C.accounts),
      notes: get(r, C.notes), network: get(r, C.network), evidence: get(r, C.evidence),
    };
    const keys = new Set([...linkKeys(rep.channel_link), ...linkKeys(rep.links), ...linkKeys(rep.accounts, { accounts: true })]);
    const roots = new Set([...keys].map(rootOf));
    rep.files = fileKeys.filter(({ f, keys: fk }) => fk.some(k =>
      (!isRoot(k) && keys.has(k)) ||
      (isRoot(k) && roots.has(k) && rep.iso && f.captured_on === rep.iso)
    )).map(({ f }) => f.path);
    rep.files.forEach(p => used.add(p));
    return rep;
  });
  const unfiled = files.filter(f => f.path.includes('/') && !used.has(f.path)).map(f => f.path);
  return { reports, unfiled };
}
