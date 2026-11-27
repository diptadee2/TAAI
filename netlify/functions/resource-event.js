// POST /api/resource-event  { kind, id? }  -> 204
//
// Counter for the free Resources page (gate-da-free-notes.html), 2026-11-08.
// kind: 'visit' (page opened, no id), 'new' (first visit ever from this browser, no id), 'note' (Download PDF), 'play' (lecture
// Play), 'slides' (lecture Slides). id is the site_notes / site_lectures id.
// Survey answers: kind sv_year | sv_gate | sv_src | sv_done, id = one of SURVEY's values.
// Public and unauthenticated (sent with navigator.sendBeacon, so the body may
// arrive as text/plain). Anyone could inflate a count by calling this; the
// page itself only sends a visit once per browser tab session and a click at
// most once per item per 10 minutes, so normal use isn't double counted.
// Always answers 204, even on errors: nobody waits on it.
import { getSupabase, todayIST } from './lib/supabase.js';

const KINDS = new Set(['visit', 'new', 'note', 'play', 'slides']);
// One-time survey on the Resources page (2026-11-27): anonymous totals only,
// one count per answer; sv_done counts answered vs skipped. Fixed values, so
// nothing typed by a visitor is ever stored.
export const SURVEY = {
  sv_year: ['y2', 'y3', 'final', 'grad', 'full'],
  sv_gate: ['da27', 'da28', 'cse', 'both', 'jobs', 'undecided'],
  sv_src: ['youtube', 'telegram', 'whatsapp', 'friend', 'google', 'discord', 'other'],
  sv_done: ['answered', 'skipped'], // skipped: only from the first version (no skip since the same day)
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const done = { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  let body = {};
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '{}')); } catch (e) { return done; }
  const kind = String(body.kind || '');
  let item = '';
  if (SURVEY[kind]) {
    item = String(body.id || '');
    // "Other" on how they found us comes with a word or two, kept as
    // 'other:<text>' (lowercase letters, digits and spaces only, 40 chars max).
    const m = kind === 'sv_src' && /^other:(.*)$/i.exec(item);
    if (m) {
      const t = m[1].normalize('NFKC').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
      item = t.length >= 2 ? 'other:' + t : 'other';
    } else if (!SURVEY[kind].includes(item)) return done;
  } else if (!KINDS.has(kind)) return done;
  else if (kind !== 'visit' && kind !== 'new') {
    item = String(body.id || '');
    if (!UUID.test(item)) return done;
  }
  try {
    await getSupabase().rpc('bump_resource_stat', { p_day: todayIST(), p_kind: kind, p_item: item.toLowerCase() });
  } catch (e) { /* best-effort */ }
  return done;
}
