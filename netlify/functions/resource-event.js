// POST /api/resource-event  { kind, id? }  -> 204
//
// Counter for the free Resources page (gate-da-free-notes.html), 2026-11-08.
// kind: 'visit' (page opened, no id), 'new' (first visit ever from this browser, no id), 'note' (Download PDF), 'play' (lecture
// Play), 'slides' (lecture Slides). id is the site_notes / site_lectures id.
// Public and unauthenticated (sent with navigator.sendBeacon, so the body may
// arrive as text/plain). Anyone could inflate a count by calling this; the
// page itself only sends a visit once per browser tab session and a click at
// most once per item per 10 minutes, so normal use isn't double counted.
// Always answers 204, even on errors: nobody waits on it.
import { getSupabase, todayIST } from './lib/supabase.js';

const KINDS = new Set(['visit', 'new', 'note', 'play', 'slides']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const done = { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  let body = {};
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '{}')); } catch (e) { return done; }
  const kind = String(body.kind || '');
  if (!KINDS.has(kind)) return done;
  let item = '';
  if (kind !== 'visit' && kind !== 'new') {
    item = String(body.id || '');
    if (!UUID.test(item)) return done;
  }
  try {
    await getSupabase().rpc('bump_resource_stat', { p_day: todayIST(), p_kind: kind, p_item: item.toLowerCase() });
  } catch (e) { /* best-effort */ }
  return done;
}
