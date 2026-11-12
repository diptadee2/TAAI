// /team > Piracy (2026-11-12). Admin only.
// GET    /api/team-piracy                    -> { rows, signature }
// POST   /api/team-piracy {action:'add', notice_label, reported_on, items:[...]}
//          items: { link, kind, scope, channel_name, subscribers, role }
//          Adds or updates one log row per link (a link reported again keeps
//          its row: times_reported +1, last_reported_on / notice_label updated).
// POST   /api/team-piracy {action:'check', ids?} -> runs the Telegram check now
// PATCH  /api/team-piracy {id, status?, notes?}  -> manual status / notes
// DELETE /api/team-piracy?id=<uuid>
import { getSupabase, json, requireAdmin } from './lib/supabase.js';
import { PIRACY_TABLE, normalizeTgLink, tgKey, tgLinkType, checkPiracyLinks } from './lib/piracy.js';

const KINDS = ['channel', 'message', 'invite', 'private', 'account'];
const SCOPES = ['whole', 'messages', 'suspected', 'account', 'promo'];
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
    let signature = null;
    try {
      const { data: s } = await supabase.from('site_settings').select('piracy_signature').eq('id', 'main').maybeSingle();
      signature = (s && s.piracy_signature) || null;
    } catch (e) { /* column not added yet */ }
    if (error) return json(200, { rows: [], signature, error: error.message });
    return json(200, { rows: data || [], signature });
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
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
    if (!items.length) return json(400, { error: 'nothing to add' });
    const reportedOn = /^\d{4}-\d{2}-\d{2}$/.test(body.reported_on || '') ? body.reported_on : todayIST();
    const notice = clip(body.notice_label, 120);
    const links = [];
    const clean = [];
    for (const it of items) {
      const link = normalizeTgLink(it.link);
      if (!link || links.includes(tgKey(link))) continue;
      links.push(tgKey(link));
      const type = tgLinkType(link);
      clean.push({
        link,
        kind: KINDS.includes(it.kind) ? it.kind : (type === 'channel' ? 'channel' : type),
        scope: SCOPES.includes(it.scope) ? it.scope : null,
        channel_name: clip(it.channel_name, 200),
        subscribers: Number.isFinite(+it.subscribers) && +it.subscribers > 0 ? Math.round(+it.subscribers) : null,
        role: clip(it.role, 200),
      });
    }
    if (!clean.length) return json(400, { error: 'no valid Telegram links' });
    const { data: existing, error: exErr } = await supabase.from(PIRACY_TABLE)
      .select('id, link, times_reported, status');
    if (exErr) return json(500, { error: exErr.message });
    const byLink = Object.fromEntries((existing || []).map(r => [tgKey(r.link), r]));
    let added = 0, updated = 0;
    for (const row of clean) {
      const ex = byLink[tgKey(row.link)];
      if (ex) {
        const patch = { last_reported_on: reportedOn, notice_label: notice, times_reported: (ex.times_reported || 1) + 1 };
        for (const k of ['scope', 'channel_name', 'subscribers', 'role']) if (row[k] != null) patch[k] = row[k];
        if (ex.status === 'removed') patch.status = 'reported';
        const { error } = await supabase.from(PIRACY_TABLE).update(patch).eq('id', ex.id);
        if (error) return json(500, { error: error.message });
        updated++;
      } else {
        const { error } = await supabase.from(PIRACY_TABLE).insert(Object.assign({}, row, {
          notice_label: notice, first_reported_on: reportedOn, last_reported_on: reportedOn,
          status: row.kind === 'private' ? 'unchecked' : 'reported',
        }));
        if (error) return json(500, { error: error.message });
        added++;
      }
    }
    return json(200, { ok: true, added, updated });
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
