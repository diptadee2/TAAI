// /team > Piracy (2026-11-12). Admin only.
// GET    /api/team-piracy                    -> { rows, signature, terms, candidates, candidatesReady }
// PATCH  /api/team-piracy {id, candidate:true, status} -> review a scanner find
// POST   /api/team-piracy {action:'add', notice_label, reported_on, items:[...]}
//          items: { link, kind, scope, channel_name, subscribers, role }
//          Adds or updates one log row per link (a link reported again keeps
//          its row: times_reported +1, last_reported_on / notice_label updated).
// POST   /api/team-piracy {action:'check', ids?} -> runs the Telegram check now
// PATCH  /api/team-piracy {id, status?, notes?}  -> manual status / notes
// DELETE /api/team-piracy?id=<uuid>
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { PIRACY_TABLE, checkPiracyLinks, addPiracyItems, piracyIngestKey } from './lib/piracy.js';

const STATUSES = ['reported', 'up', 'removed', 'moved', 'unchecked'];

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

export async function handler(event, context) {
  const auth = requireAdmin(context);
  if (!auth.authorized) return auth.response;
  const supabase = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase.from(PIRACY_TABLE).select('*')
      .order('last_reported_on', { ascending: false });
    let signature = null, terms = null, candidates = [], candidatesReady = false;
    try {
      const { data: s } = await supabase.from('site_settings').select('*').eq('id', 'main').maybeSingle();
      signature = (s && s.piracy_signature) || null;
      terms = (s && s.piracy_terms) || null;
    } catch (e) { /* columns not added yet */ }
    try {
      const { data: c, error: cErr } = await supabase.from('piracy_candidates').select('*')
        .order('score', { ascending: false }).limit(500);
      if (!cErr) { candidates = c || []; candidatesReady = true; }
    } catch (e) { /* table not added yet */ }
    let runs = [];
    try {
      const { data: r, error: rErr } = await supabase.from('piracy_scan_runs').select('*')
        .order('ran_at', { ascending: false }).limit(60);
      if (!rErr) runs = r || [];
    } catch (e) { /* table not added yet */ }
    let ingested = [], ingestReady = false;
    try {
      const { data: g, error: gErr } = await supabase.from('piracy_ingested').select('*')
        .order('ingested_at', { ascending: false }).limit(10);
      if (!gErr) { ingested = g || []; ingestReady = true; }
    } catch (e) { /* table not added yet */ }
    const ingest = { key: piracyIngestKey(process.env.SUPABASE_SERVICE_KEY), ready: ingestReady, recent: ingested };
    if (error) return json(200, { rows: [], signature, terms, candidates, candidatesReady, runs, ingest, error: error.message });
    return json(200, { rows: data || [], signature, terms, candidates, candidatesReady, runs, ingest });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  if (event.httpMethod === 'POST' && body.action === 'check') {
    try {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : null;
      const result = await checkPiracyLinks(supabase, { ids, concurrency: 8, budgetMs: 8000 });
      return json(200, result);
    } catch (e) { return json(500, { error: e.message }); }
  }

  if (event.httpMethod === 'POST' && body.action === 'add') {
    if (!Array.isArray(body.items) || !body.items.length) return json(400, { error: 'nothing to add' });
    try {
      const r = await addPiracyItems(supabase, { items: body.items, notice_label: body.notice_label, reported_on: body.reported_on });
      if (r.empty) return json(400, { error: 'no valid Telegram links' });
      return json(200, { ok: true, added: r.added, updated: r.updated });
    } catch (e) { return json(500, { error: e.message }); }
  }

  // Scanner finds: mark reviewed ('confirmed' once turned into a notice,
  // 'dismissed' when it isn't piracy, 'new' to undo).
  if (event.httpMethod === 'PATCH' && body.candidate) {
    if (!body.id || !['new', 'confirmed', 'dismissed'].includes(body.status)) return json(400, { error: 'id and a valid status required' });
    const { error } = await supabase.from('piracy_candidates')
      .update({ status: body.status, reviewed_at: body.status === 'new' ? null : new Date().toISOString() }).eq('id', body.id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'PATCH') {
    if (!body.id) return json(400, { error: 'id required' });
    const patch = {};
    if (typeof body.status === 'string') {
      if (!STATUSES.includes(body.status)) return json(400, { error: 'invalid status' });
      patch.status = body.status;
      patch.removed_on = body.status === 'removed' ? todayIST() : null;
    }
    if (typeof body.notes === 'string') patch.notes = clip(body.notes, 2000);
    if (!Object.keys(patch).length) return json(400, { error: 'nothing to update' });
    const { error } = await supabase.from(PIRACY_TABLE).update(patch).eq('id', body.id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return json(400, { error: 'id required' });
    const { error } = await supabase.from(PIRACY_TABLE).delete().eq('id', id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}
