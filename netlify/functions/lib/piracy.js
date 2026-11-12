// Piracy takedown log + public Telegram link checker (2026-11-12).
//
// piracy_reports holds one row per reported Telegram link (channel, message,
// invite or account). /team > Piracy adds rows when a notice is drafted, and
// checkPiracyLinks() looks at Telegram's PUBLIC web pages to see whether each
// link is still up. No Telegram account is needed for that:
//   - https://t.me/<channel>/<n>?embed=1 shows the post, or an error such as
//     "Post not found" / "This channel is unavailable due to copyright
//     infringement" once Telegram has removed it.
//   - https://t.me/<channel> (or /+<invite>, or /<account>) shows the name and
//     subscriber count while it exists, and a generic "Telegram: Contact @x" /
//     "Join group chat on Telegram" page once it's gone or the invite expired.
// Private channel links (t.me/c/<id>/...) can't be seen from outside, so they
// stay "can't check".

import crypto from 'node:crypto';

export const PIRACY_TABLE = 'piracy_reports';
const UA = 'Mozilla/5.0 (compatible; TAAI-takedown-check/1.0)';

// Turn anything a person pastes (@user, t.me/user, telegram.me links, Bot-API
// ids like -1002230080912) into one canonical https://t.me/... link, so the
// same channel is always matched to the same log row.
export function normalizeTgLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const botId = s.match(/^-100(\d{6,})$/);
  if (botId) return 'https://t.me/c/' + botId[1];
  if (/^\d{8,}$/.test(s)) return 'https://t.me/c/' + s;
  if (s.startsWith('@')) s = 'https://t.me/' + s.slice(1);
  s = s.replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, 'https://t.me/');
  if (!/^https:\/\/t\.me\//.test(s)) {
    if (/^[A-Za-z0-9_+]/.test(s)) s = 'https://t.me/' + s; else return '';
  }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  s = s.replace(/^https:\/\/t\.me\/s\//, 'https://t.me/');
  s = s.replace(/^https:\/\/t\.me\/joinchat\//, 'https://t.me/+');
  return s;
}

// Comparison key: usernames are case-insensitive on Telegram, invite codes are
// NOT, so only the username part of public links is lowercased. Links are
// stored as typed (readable in notices) and matched by this key.
export function tgKey(link) {
  const s = normalizeTgLink(link);
  const m = s.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,})(\/\d+)?$/);
  if (m && m[1] !== 'c') return 'https://t.me/' + m[1].toLowerCase() + (m[2] || '');
  return s;
}

// 'private' | 'invite' | 'message' | 'channel' (a bare username: channel,
// group or account; the row's kind says which it was reported as).
export function tgLinkType(link) {
  if (/^https:\/\/t\.me\/c\//.test(link)) return 'private';
  if (/^https:\/\/t\.me\/\+/.test(link)) return 'invite';
  if (/^https:\/\/t\.me\/[A-Za-z0-9_]+\/\d+$/.test(link)) return 'message';
  return 'channel';
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, redirect: 'follow', signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(t); }
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Checks one link. Returns { status, note, title?, subscribers? } where status
// is 'up' | 'removed' | 'moved' | 'unchecked' | 'error'.
export async function checkTgLink(link, expectedTitle, timeoutMs = 7000) {
  const type = tgLinkType(link);
  if (type === 'private') return { status: 'unchecked', note: "Private channel, can't be checked from outside" };
  try {
    if (type === 'message') {
      const { text } = await fetchText(link + '?embed=1', timeoutMs);
      const err = text.match(/tgme_widget_message_error"[^>]*>([^<]*)</);
      if (err) {
        const msg = decodeEntities(err[1]).trim();
        if (/copyright/i.test(msg)) return { status: 'removed', note: 'Removed by Telegram: copyright infringement' };
        if (/not found/i.test(msg)) return { status: 'removed', note: 'Post removed' };
        return { status: 'removed', note: msg || 'Post unavailable' };
      }
      if (/data-post="/.test(text)) return { status: 'up', note: 'Post still visible' };
      return { status: 'error', note: 'Unexpected page from Telegram' };
    }
    const { text } = await fetchText(link, timeoutMs);
    const title = decodeEntities((text.match(/property="og:title" content="([^"]*)"/) || [])[1] || '').trim();
    const extra = decodeEntities((text.match(/tgme_page_extra">([^<]*)</) || [])[1] || '').trim();
    const subsM = extra.match(/([\d\s,]+)\s+(subscribers|members)/);
    const subscribers = subsM ? parseInt(subsM[1].replace(/[\s,]/g, ''), 10) : null;
    const generic = /^Telegram: Contact @/i.test(title) || /^Join group chat on Telegram$/i.test(title);
    if (generic && !extra) {
      return { status: 'removed', note: type === 'invite' ? 'Invite link expired or channel gone' : 'Channel or account gone' };
    }
    if (expectedTitle && title && title !== expectedTitle) {
      return { status: 'moved', note: `Username now shows "${title}" (was "${expectedTitle}")`, title, subscribers };
    }
    return { status: 'up', note: extra || 'Still up', title, subscribers };
  } catch (e) {
    return { status: 'error', note: e.name === 'AbortError' ? 'Telegram did not answer in time' : 'Check failed: ' + e.message };
  }
}

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Checks every logged link (or just `ids`) and saves the results. A link that
// errors keeps its previous status, so one slow answer from Telegram doesn't
// flip a removed channel back to "unknown".
export async function checkPiracyLinks(supabase, { ids = null, concurrency = 8, budgetMs = 20000 } = {}) {
  let q = supabase.from(PIRACY_TABLE).select('id, link, status, expected_title, removed_on');
  if (ids && ids.length) q = q.in('id', ids);
  const { data: rows, error } = await q;
  if (error) throw error;
  const started = Date.now();
  const today = todayIST();
  const results = { checked: 0, up: 0, removed: 0, newlyRemoved: [], skipped: 0 };
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const row = rows[i++];
      if (Date.now() - started > budgetMs) { results.skipped++; continue; }
      const r = await checkTgLink(row.link, row.expected_title);
      const patch = { checked_at: new Date().toISOString(), check_note: r.note };
      if (r.status !== 'error') patch.status = r.status;
      if (r.subscribers != null) patch.subscribers = r.subscribers;
      if (r.status === 'up' && r.title && !row.expected_title) patch.expected_title = r.title;
      if (r.status === 'removed' && row.status !== 'removed') {
        patch.removed_on = row.removed_on || today;
        results.newlyRemoved.push(row.link);
      }
      if (r.status === 'up' && row.status === 'removed') patch.removed_on = null;
      await supabase.from(PIRACY_TABLE).update(patch).eq('id', row.id);
      results.checked++;
      if (r.status === 'up') results.up++;
      if (r.status === 'removed') results.removed++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const a = new Date(dateStr + 'T00:00:00Z').getTime();
  const b = new Date(todayIST() + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

// Discord embed for the weekly 'piracy_status' scheduled post. Only reads the
// table (the daily piracy-check job does the actual checking).
export async function piracyStatusEmbed(supabase, row) {
  const { data, error } = await supabase.from(PIRACY_TABLE)
    .select('link, kind, channel_name, status, last_reported_on, removed_on, check_note');
  if (error || !data || !data.length) return null;
  const label = r => (r.channel_name ? `${r.channel_name}: ` : '') + r.link;
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const weekAgoStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(weekAgo);
  const removedThisWeek = data.filter(r => r.status === 'removed' && r.removed_on && r.removed_on > weekAgoStr);
  const stillUp = data.filter(r => r.status === 'up' && r.kind !== 'account')
    .sort((a, b) => (a.last_reported_on || '').localeCompare(b.last_reported_on || ''));
  const moved = data.filter(r => r.status === 'moved');
  const removedTotal = data.filter(r => r.status === 'removed').length;
  const privateCount = data.filter(r => r.status === 'unchecked').length;
  const cap = (arr, n) => arr.slice(0, n);
  const parts = [];
  if (row.body) parts.push(row.body);
  parts.push(`**${removedTotal} removed** · **${stillUp.length} still up** · ${privateCount} private (can't check) · ${data.length} reported in all`);
  if (removedThisWeek.length) {
    parts.push('✅ **Removed this week**\n' + cap(removedThisWeek, 12).map(r => `• ${label(r)}`).join('\n') + (removedThisWeek.length > 12 ? `\n…and ${removedThisWeek.length - 12} more` : ''));
  }
  if (stillUp.length) {
    parts.push('⚠️ **Still up** (oldest report first, consider reporting again)\n' + cap(stillUp, 12).map(r => {
      const d = daysSince(r.last_reported_on);
      return `• ${label(r)} (reported ${d === 0 ? 'today' : d + 'd ago'})`;
    }).join('\n') + (stillUp.length > 12 ? `\n…and ${stillUp.length - 12} more` : ''));
  }
  if (moved.length) {
    parts.push('🔁 **Username now used by a different channel**\n' + cap(moved, 6).map(r => `• ${label(r)}`).join('\n'));
  }
  parts.push('Full log and notice drafts: https://taai.live/team/ (Piracy tab)');
  let description = parts.join('\n\n');
  if (description.length > 4000) description = description.slice(0, 3990) + '…';
  return [{ title: row.title || '🛡️ Piracy takedown status', description, color: row.color ?? 0xef4444 }];
}

const KINDS = ['channel', 'message', 'invite', 'private', 'account'];
const SCOPES = ['whole', 'messages', 'suspected', 'account', 'promo'];
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

// Adds or updates one log row per link (a link reported again keeps its row:
// times_reported +1, last_reported_on / notice_label updated). Shared by
// /team's "Add to log" and the Gmail auto-log (piracy-ingest.js).
export async function addPiracyItems(supabase, { items, notice_label, reported_on }) {
  const reportedOn = /^\d{4}-\d{2}-\d{2}$/.test(reported_on || '') ? reported_on : todayIST();
  const notice = clip(notice_label, 120);
  const seen = [];
  const clean = [];
  for (const it of (items || []).slice(0, 300)) {
    const link = normalizeTgLink(it.link);
    if (!link || seen.includes(tgKey(link))) continue;
    seen.push(tgKey(link));
    const type = tgLinkType(link);
    clean.push({
      link,
      kind: KINDS.includes(it.kind) ? it.kind : type,
      scope: SCOPES.includes(it.scope) ? it.scope : null,
      channel_name: clip(it.channel_name, 200),
      subscribers: Number.isFinite(+it.subscribers) && +it.subscribers > 0 ? Math.round(+it.subscribers) : null,
      role: clip(it.role, 200),
    });
  }
  if (!clean.length) return { added: 0, updated: 0, empty: true };
  const { data: existing, error: exErr } = await supabase.from(PIRACY_TABLE).select('id, link, times_reported, status');
  if (exErr) throw exErr;
  const byLink = Object.fromEntries((existing || []).map(r => [tgKey(r.link), r]));
  let added = 0, updated = 0;
  for (const row of clean) {
    const ex = byLink[tgKey(row.link)];
    if (ex) {
      const patch = { last_reported_on: reportedOn, notice_label: notice, times_reported: (ex.times_reported || 1) + 1 };
      for (const k of ['scope', 'channel_name', 'subscribers', 'role']) if (row[k] != null) patch[k] = row[k];
      if (ex.status === 'removed') patch.status = 'reported';
      const { error } = await supabase.from(PIRACY_TABLE).update(patch).eq('id', ex.id);
      if (error) throw error;
      updated++;
    } else {
      const { error } = await supabase.from(PIRACY_TABLE).insert(Object.assign({}, row, {
        notice_label: notice, first_reported_on: reportedOn, last_reported_on: reportedOn,
        status: row.kind === 'private' ? 'unchecked' : 'reported',
      }));
      if (error) throw error;
      added++;
    }
  }
  return { added, updated };
}

// Reads a sent takedown notice (plain text, written in /team or in Claude
// chat) and returns log items. Uses the notice format's headings to tell a
// whole channel from single messages, suspected channels and accounts; a
// notice without those headings still logs every t.me link it contains.
export function parseNoticeText(text) {
  let body = String(text || '').replace(/\r/g, '');
  // Drop quoted earlier mail (replies / forwards) so it isn't logged twice.
  body = body.split(/\n\s*On .{5,200}wrote:\s*\n/)[0];
  body = body.split(/\n-{2,}\s*Forwarded message\s*-{2,}/i)[0];
  const lines = body.split('\n').filter(l => !/^\s*>/.test(l));
  const linkRe = /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/[A-Za-z0-9_+\/]+/g;
  const items = [];
  let sections = [];
  let sec = null;
  let mode = null; // 'channel' | 'samples' | 'messages' | 'suspected' | 'ref' | 'accounts' | null
  const newSec = () => { sec = { scope: null, name: null, items: [] }; sections.push(sec); };
  let sawHeading = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const up = line.replace(/[:.]+$/, '').toUpperCase();
    if (/^INFRINGING CHANNEL$/.test(up)) { if (!sec || sec.scope) newSec(); sec.scope = 'whole'; mode = 'channel'; sawHeading = true; continue; }
    if (/^SAMPLE INFRINGING MESSAGES?$/.test(up)) { if (!sec) newSec(); sec.scope = sec.scope || 'whole'; mode = 'samples'; sawHeading = true; continue; }
    if (/^INFRINGING MESSAGES?$/.test(up)) { if (!sec || sec.scope) newSec(); sec.scope = 'messages'; mode = 'messages'; sawHeading = true; continue; }
    if (/^SUSPECTED CHANNELS?$/.test(up)) { if (!sec || sec.scope) newSec(); sec.scope = 'suspected'; mode = 'suspected'; sawHeading = true; continue; }
    if (/^CHANNEL$/.test(up)) { if (!sec) newSec(); mode = 'ref'; continue; }
    if (/^ASSOCIATED ACCOUNTS?$/.test(up)) { if (!sec) newSec(); mode = 'accounts'; sawHeading = true; continue; }
    if (/^(NATURE OF INFRINGEMENT|ORIGINAL TAAI CONTENT|SUPPORTING DOCUMENTATION)$/.test(up)) { mode = null; continue; }
    if (!sawHeading || !mode) continue;
    const links = line.match(linkRe) || [];
    if (mode === 'ref') {
      const name = line.split(/\s+[–-]\s+(?:https?:\/\/)?t\.me|\s*\((?:private channel|https?:)/)[0].trim();
      if (name && !/^(https?:\/\/)?t\.me/.test(name)) sec.name = name;
      const subs = line.match(/([\d,]+)\s+(subscribers|members)/);
      if (subs) sec.subs = parseInt(subs[1].replace(/,/g, ''), 10);
      const pid = line.match(/ID:\s*(-?\d{6,})/);
      if (pid && !links.length) links.push(pid[1]);
      for (const l of links) if (!sec.items.some(i => tgKey(i.link) === tgKey(l))) sec.items.push({ link: l, kind: null, chan: true });
      mode = null;
      continue;
    }
    for (const l of links) {
      const type = tgLinkType(normalizeTgLink(l));
      if (mode === 'accounts') {
        const role = line.split(/\s+[–—-]\s+/).slice(1).join(' – ').trim() || null;
        sec.items.push({ link: l, kind: 'account', scope: 'account', role });
      } else if (mode === 'channel') {
        sec.items.push({ link: l, kind: type === 'message' ? 'message' : type, chan: type !== 'message' });
      } else {
        sec.items.push({ link: l, kind: type, chan: type === 'channel' || type === 'invite' });
      }
    }
  }
  if (!sawHeading) {
    const all = body.match(linkRe) || [];
    return all.map(l => ({ link: l, kind: null, scope: null }));
  }
  for (const s of sections) {
    for (const it of s.items) {
      items.push({
        link: it.link,
        kind: it.kind || tgLinkType(normalizeTgLink(it.link)),
        scope: it.scope || s.scope,
        channel_name: s.name,
        subscribers: it.chan ? s.subs : null,
        role: it.role || null,
      });
    }
  }
  return items;
}

// Key the Gmail script sends with every notice (derived from the service
// key, so nothing new to configure). Shown to admins in /team.
export function piracyIngestKey(serviceKey) {
  return crypto.createHmac('sha256', 'piracy-ingest:' + (serviceKey || '')).update('v1').digest('hex').slice(0, 32);
}
